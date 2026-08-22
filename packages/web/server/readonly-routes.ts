import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleViewModel } from "@ctk/core";
import { UI_HTML } from "./ui-page.js";

/**
 * web/server/readonly-routes.ts — Step 6a. **GET/HEAD만 등록한다.**
 *
 * 상태를 바꾸는 경로가 하나도 없으므로 세션 토큰·CSRF·Origin 검사가 불필요하다(계획 Step 6a).
 * 그 전제는 "쓰기 경로가 없다"에 전적으로 기대므로, 메서드 거부를 **라우팅보다 먼저** 한 곳에서
 * 수행한다 — 핸들러마다 검사하면 새 핸들러가 검사를 빠뜨릴 수 있다.
 *
 * ## URL 문자열이 파일 경로를 만들지 않는다
 *
 * 문서 조회는 `:assetId`를 받지만 그 문자열로 경로를 조립하지 **않는다.** 주입된
 * `getAssetDoc(assetId, which)`가 카탈로그에서 자산을 조회한 뒤 **카탈로그가 이미 아는**
 * kind/name으로 경로를 만든다(`core/catalog/layout.ts`의 관문을 거친다). 이 저장소에서
 * `name: ../../evil`이 스캔만으로 카탈로그 밖 쓰기를 만든 전례가 있고, 그 교훈은 "경로는
 * 우리가 만든 id에서만 산출한다"였다. 웹은 그 규칙이 가장 지켜지기 어려운 표면이다 —
 * 그래서 이 모듈은 `node:path`를 아예 import하지 않는다.
 */

export type AssetDocKind = "annotation" | "usage";

export interface ReadonlyRouteDeps {
  getViewModel: () => ConsoleViewModel;
  /** 자산 문서 본문. 자산이 없거나 문서가 없으면 `null` — 빈 문자열과 구분한다. */
  getAssetDoc: (assetId: string, which: AssetDocKind) => string | null;
}

/** 이 서버가 응답하는 유일한 메서드 집합. `Allow` 헤더와 같은 출처를 쓴다. */
export const ALLOWED_METHODS = ["GET", "HEAD"] as const;

export function isAllowedMethod(method: string | undefined): boolean {
  return method !== undefined && (ALLOWED_METHODS as readonly string[]).includes(method);
}

interface RouteMatch {
  kind: "ui" | "view-model" | "assets" | "usage" | "health" | "asset-doc" | "not-found";
  assetId?: string;
  doc?: AssetDocKind;
}

/**
 * 경로를 라우트로 해석한다 — 순수 함수(I/O 없음)라 라우팅 규칙만 따로 테스트할 수 있다.
 * 쿼리스트링은 무시하고, 경로 세그먼트는 `decodeURIComponent`로 되돌린다.
 */
export function matchRoute(pathname: string): RouteMatch {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return { kind: "ui" };
  if (segments.length === 1 && segments[0] === "healthz") return { kind: "health" };
  if (segments[0] !== "api") return { kind: "not-found" };

  const rest = segments.slice(1);
  if (rest.length === 1 && rest[0] === "view-model") return { kind: "view-model" };
  if (rest.length === 1 && rest[0] === "assets") return { kind: "assets" };
  if (rest.length === 1 && rest[0] === "usage") return { kind: "usage" };

  // /api/assets/<assetId>/doc/<annotation|usage>
  if (rest.length === 4 && rest[0] === "assets" && rest[2] === "doc") {
    const which = rest[3];
    if (which !== "annotation" && which !== "usage") return { kind: "not-found" };
    let assetId: string;
    try {
      assetId = decodeURIComponent(rest[1] ?? "");
    } catch {
      // 잘못된 퍼센트 인코딩을 원문 그대로 통과시키지 않는다 — 조용히 다른 것을 조회하게 된다.
      return { kind: "not-found" };
    }
    if (assetId.length === 0) return { kind: "not-found" };
    return { kind: "asset-doc", assetId, doc: which };
  }

  return { kind: "not-found" };
}

function sendJson(res: ServerResponse, status: number, body: unknown, isHead: boolean): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    // 로컬 조회 콘솔이므로 어떤 교차 출처 접근도 허용하지 않는다.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(isHead ? undefined : payload);
}

function sendHtml(res: ServerResponse, status: number, body: string, isHead: boolean): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // UI는 인라인 스타일·스크립트 한 장이고 외부에서 아무것도 불러오지 않는다.
    // 카탈로그 문서에 심긴 문자열이 어떤 원격 호출도 만들 수 없게 못 박는다(인젝션 방어).
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
  });
  res.end(isHead ? undefined : body);
}

function sendText(res: ServerResponse, status: number, body: string, isHead: boolean): void {
  res.writeHead(status, {
    "content-type": "text/markdown; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(isHead ? undefined : body);
}

export function handleReadonlyRequest(req: IncomingMessage, res: ServerResponse, deps: ReadonlyRouteDeps): void {
  // ① 메서드 거부가 라우팅보다 먼저다 — 쓰기 메서드는 어떤 경로에도 도달하지 않는다.
  if (!isAllowedMethod(req.method)) {
    res.setHeader("allow", ALLOWED_METHODS.join(", "));
    sendJson(res, 405, { error: "method_not_allowed", allowed: ALLOWED_METHODS }, false);
    return;
  }
  const isHead = req.method === "HEAD";

  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const route = matchRoute(pathname);

  switch (route.kind) {
    case "ui":
      sendHtml(res, 200, UI_HTML, isHead);
      return;
    case "health":
      sendJson(res, 200, { ok: true }, isHead);
      return;
    case "view-model":
      sendJson(res, 200, deps.getViewModel(), isHead);
      return;
    case "assets":
      sendJson(res, 200, { assets: deps.getViewModel().assets }, isHead);
      return;
    case "usage":
      sendJson(res, 200, deps.getViewModel().usage, isHead);
      return;
    case "asset-doc": {
      const body = deps.getAssetDoc(route.assetId ?? "", route.doc ?? "annotation");
      if (body === null) {
        // 문서 없음과 자산 없음을 둘 다 404로 낸다 — 존재 여부를 응답 코드로 흘리지 않는다.
        sendJson(res, 404, { error: "not_found" }, isHead);
        return;
      }
      sendText(res, 200, body, isHead);
      return;
    }
    case "not-found":
      sendJson(res, 404, { error: "not_found" }, isHead);
      return;
  }
}

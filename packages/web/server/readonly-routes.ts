import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleViewModel } from "@ctk/core";
import { buildUiPage } from "./ui-page.js";
import { handleActionRequest, type ActionRouteDeps } from "./routes/actions.js";
import { checkLoopbackHost } from "./origin-guard.js";

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
  /**
   * 액션 모드에서만 채워진다. **`undefined`면 `/actions`는 라우트로 존재하지 않는다** —
   * 조회 모드에서 "핸들러가 없으니 403"이 아니라 **경로 자체가 없어야** 6a의 전제
   * (쓰기 경로가 하나도 없다 ⇒ 토큰·CSRF 불요)가 구조적으로 유지된다.
   */
  actions?: ActionRouteDeps | undefined;
  /**
   * 이 서버가 듣고 있는 포트. **조회 경로의 Host 검사에 필요하다**(H1) — DNS rebinding은
   * 조회도 표적이므로 액션 모드가 아니어도 이 값이 있어야 한다.
   */
  port: number;
}

/** 이 서버가 응답하는 유일한 메서드 집합. `Allow` 헤더와 같은 출처를 쓴다. */
export const ALLOWED_METHODS = ["GET", "HEAD"] as const;

export function isAllowedMethod(method: string | undefined): boolean {
  return method !== undefined && (ALLOWED_METHODS as readonly string[]).includes(method);
}

interface RouteMatch {
  kind: "ui" | "view-model" | "assets" | "usage" | "health" | "asset-doc" | "actions" | "not-found";
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
  if (rest.length === 1 && rest[0] === "actions") return { kind: "actions" };
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

function sendHtml(res: ServerResponse, status: number, body: string, isHead: boolean, nonce: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // UI는 인라인 스타일·스크립트 한 장이고 외부에서 아무것도 불러오지 않는다.
    // 카탈로그 문서에 심긴 문자열이 어떤 원격 호출도 만들 수 없게 못 박는다(인젝션 방어).
    "content-security-policy":
      // `frame-ancestors`는 `default-src`가 커버하지 않는다(CSP 명세상 fallback 대상이 아님) —
      // 액션 버튼이 붙는 화면이므로 클릭재킹을 명시적으로 막는다(심사 M4).
      // `script-src`에 `'unsafe-inline'`을 쓰지 않는다 — 그것이 있으면 `javascript:` URI가
      // CSP 층에서 허용되어 악성 `repo_url`이 클릭 한 번에 실행된다(심사 H3).
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; ` +
      "form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
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
  // ⓪ Host 검사가 **모든 경로보다 먼저**다(H1). 조회도 DNS rebinding의 표적이다 —
  //    공격자 도메인을 127.0.0.1로 되돌린 페이지가 GET /api/view-model로 이 머신의
  //    전 툴 목록을 읽어갈 수 있었다. 토큰은 요구하지 않는다(조회는 무인증 유지).
  const hostVerdict = checkLoopbackHost(req.headers, { port: deps.port });
  if (!hostVerdict.ok) {
    sendJson(res, 403, { error: "forbidden", reason: hostVerdict.reason }, false);
    return;
  }

  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const route = matchRoute(pathname);

  // ① 액션은 **액션 모드에서 그 한 경로에만** 존재한다. 조회 모드(`deps.actions === undefined`)
  //    에서는 라우트가 없으므로 아래 메서드 게이트가 그대로 405를 낸다 — 6a의 전제가 유지된다.
  if (route.kind === "actions" && deps.actions !== undefined) {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      sendJson(res, 405, { error: "method_not_allowed", allowed: ["POST"] }, false);
      return;
    }
    // 클라이언트가 조기 절단하면 `send()`가 던질 수 있다 — unhandled rejection은 Node 15+에서
    // 프로세스를 죽인다. 관문 통과 전에도 발생 가능하므로 토큰 없이도 시도할 수 있다(심사 L3).
    // 포트의 출처를 하나로 유지한다(심사 L-f) — 바깥 게이트가 요청 시점에 해소한 값을
    // 그대로 넘긴다. 생성 시점 값과 따로 두면 둘이 갈릴 여지가 남는다.
    const actionDeps = { ...deps.actions, guard: { ...deps.actions.guard, port: deps.port } };
    void handleActionRequest(req, res, actionDeps).catch((err: unknown) => {
      console.error("[action_route_failed]", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(`${JSON.stringify({ ok: false, code: "action_failed" })}\n`);
    });
    return;
  }

  // ② 그 밖의 모든 경로는 GET/HEAD만 받는다. 거부가 라우팅 결과보다 먼저 적용된다.
  if (!isAllowedMethod(req.method)) {
    res.setHeader("allow", ALLOWED_METHODS.join(", "));
    sendJson(res, 405, { error: "method_not_allowed", allowed: ALLOWED_METHODS }, false);
    return;
  }
  const isHead = req.method === "HEAD";

  switch (route.kind) {
    case "ui": {
      // nonce는 응답마다 새로 만든다 — 고정하면 공격자가 그 값을 알고 스크립트를 심을 수 있다.
      const nonce = randomBytes(16).toString("base64");
      sendHtml(res, 200, buildUiPage(nonce), isHead, nonce);
      return;
    }
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
    case "actions":
      // 조회 모드에서 여기 닿았다는 것은 액션 핸들러가 없다는 뜻이다 — 경로를 만들지 않는다.
      sendJson(res, 404, { error: "not_found" }, isHead);
      return;
    case "not-found":
      sendJson(res, 404, { error: "not_found" }, isHead);
      return;
  }
}

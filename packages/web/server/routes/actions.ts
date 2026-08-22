import type { IncomingMessage, ServerResponse } from "node:http";
import { clampGenParams, parseWebActionRequest, type WebActionRequest } from "@ctk/core";
import { checkActionRequest, type ActionGuardExpectation } from "../origin-guard.js";

/**
 * web/server/routes/actions.ts — Step 6b. **화이트리스트 액션만 실행한다.**
 *
 * 이 모듈은 아무것도 직접 실행하지 않는다 — 관문 통과 · 스키마 파싱 · 클램프까지만 하고
 * 실제 수행은 주입된 핸들러(합성 루트 = cli)가 한다. `actuator`를 여기서 import하지 않으므로
 * 웹이 열 수 있는 조작은 **핸들러가 노출한 것뿐**이고, 셸 조합 경로는 존재하지 않는다.
 *
 * ## 순서가 계약이다
 *
 * 관문 → 본문 크기 → JSON 파싱 → 스키마 → 클램프 → 잠금 → 실행. 앞의 하나라도 뒤로 가면
 * 그만큼 검증되지 않은 입력이 더 깊이 들어간다. 특히 **관문이 첫 번째**여야 토큰 없는 요청이
 * 우리 파서에조차 닿지 않는다.
 */

/** 액션 본문 상한. 이 API의 어떤 정상 요청도 1KB를 넘지 않는다. */
const MAX_BODY_BYTES = 4096;

export type ActionFailureCode =
  | "unauthorized"
  | "bad_request"
  | "payload_too_large"
  | "lock_contended"
  | "project_index_out_of_range"
  | "estimate_token_invalid"
  | "action_failed";

export interface ActionOutcome {
  ok: boolean;
  code?: ActionFailureCode;
  message?: string;
  data?: unknown;
}

export interface ActionHandlers {
  scan: () => Promise<unknown>;
  rollback: () => Promise<unknown>;
  move: (request: Extract<WebActionRequest, { action: "move" }>) => Promise<unknown>;
  /** **API 호출·서브프로세스 spawn 없이** 비용만 계산하고 실행 토큰을 발급한다(F6 ⓐ). */
  genEstimate: (params: { maxAssets: number; maxBudgetUsd: number }) => Promise<{ estimateToken: string; data: unknown }>;
  /** ⓐ가 발급한 토큰이 유효할 때만 실제 실행한다(F6 ⓑ). */
  genExecute: (params: {
    maxAssets: number;
    maxBudgetUsd: number;
    estimateToken: string;
  }) => Promise<unknown>;
}

export interface ActionRouteDeps {
  guard: ActionGuardExpectation;
  handlers: ActionHandlers;
}

/** 실패를 코드로 분류해 던진다 — 핸들러가 원인을 알려야 라우트가 상태 코드를 고를 수 있다. */
export class ActionError extends Error {
  constructor(
    readonly code: ActionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

const STATUS_BY_CODE: Record<ActionFailureCode, number> = {
  unauthorized: 401,
  bad_request: 400,
  payload_too_large: 413,
  lock_contended: 409,
  project_index_out_of_range: 400,
  estimate_token_invalid: 400,
  action_failed: 500,
};

/**
 * 본문을 상한까지만 읽는다. 다 읽고 나서 크기를 재면 그때는 이미 메모리에 들어와 있으므로,
 * ⓐ `Content-Length`로 **읽기 전에** 거르고 ⓑ 스트림 중에도 누적을 감시한다(chunked 대비).
 *
 * ⚠️ **상한 초과에서 소켓을 즉시 끊지 않는다.** 처음 구현은 `req.destroy()`를 호출했는데,
 * 그러면 413을 쓰기 전에 연결이 죽어 클라이언트는 `SocketError: other side closed`만 본다 —
 * 거부는 됐지만 **왜 거부됐는지 알 수 없다**(안전 원칙 6). 읽기만 멈추고 응답은 호출자가
 * 정상적으로 내보낸 뒤 연결을 닫는다.
 */
export async function readBodyWithLimit(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string") {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
      throw new ActionError("payload_too_large", `요청 본문이 상한 ${limit}바이트를 넘는다`);
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    const onData = (chunk: Buffer): void => {
      if (rejected) return;
      total += chunk.length;
      if (total > limit) {
        rejected = true;
        req.off("data", onData);
        req.pause();
        reject(new ActionError("payload_too_large", `요청 본문이 상한 ${limit}바이트를 넘는다`));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

export async function dispatchAction(request: WebActionRequest, handlers: ActionHandlers): Promise<unknown> {
  switch (request.action) {
    case "scan":
      return handlers.scan();
    case "rollback":
      return handlers.rollback();
    case "move":
      return handlers.move(request);
    case "gen_estimate": {
      const clamped = clampGenParams(request);
      const result = await handlers.genEstimate({ maxAssets: clamped.maxAssets, maxBudgetUsd: clamped.maxBudgetUsd });
      // 클램프 사실을 응답에 싣는다 — 화면이 "요청한 대로 돌았다"고 오해하지 않게.
      return { ...(result.data as object), estimate_token: result.estimateToken, clamped: clamped.clamped };
    }
    case "gen_execute": {
      const clamped = clampGenParams(request);
      return handlers.genExecute({
        maxAssets: clamped.maxAssets,
        maxBudgetUsd: clamped.maxBudgetUsd,
        estimateToken: request.estimate_token,
      });
    }
  }
}

export async function handleActionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ActionRouteDeps,
): Promise<void> {
  const send = (status: number, body: ActionOutcome): void => {
    const payload = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(payload)),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(payload);
  };

  // ① 관문이 가장 먼저다 — 토큰 없는 요청은 우리 파서에조차 닿지 않는다.
  const verdict = checkActionRequest(req.headers, deps.guard);
  if (!verdict.ok) {
    send(401, { ok: false, code: "unauthorized", message: verdict.reason });
    return;
  }

  let raw: string;
  try {
    raw = await readBodyWithLimit(req);
  } catch (err) {
    const code = err instanceof ActionError ? err.code : "bad_request";
    // 남은 본문을 계속 받지 않되, 응답이 나간 **뒤에** 연결을 닫는다 — 순서가 바뀌면
    // 클라이언트가 이유 대신 소켓 리셋을 본다.
    res.setHeader("connection", "close");
    res.on("finish", () => req.destroy());
    send(STATUS_BY_CODE[code], { ok: false, code, message: err instanceof Error ? err.message : "본문을 읽지 못했다" });
    return;
  }

  let request: WebActionRequest;
  try {
    request = parseWebActionRequest(JSON.parse(raw) as unknown);
  } catch {
    // 어떤 키가 왜 틀렸는지는 싣지 않는다 — 스키마를 되짚어 탐색하는 데 쓰인다.
    send(400, { ok: false, code: "bad_request", message: "액션 요청이 화이트리스트 스키마와 맞지 않는다" });
    return;
  }

  try {
    const data = await dispatchAction(request, deps.handlers);
    send(200, { ok: true, data });
  } catch (err) {
    const code = err instanceof ActionError ? err.code : "action_failed";
    // 실패를 200으로 삼키지 않는다 — 화면이 "됐다"고 표시하면 사용자는 확인하지 않는다.
    send(STATUS_BY_CODE[code], { ok: false, code, message: err instanceof Error ? err.message : String(err) });
  }
}

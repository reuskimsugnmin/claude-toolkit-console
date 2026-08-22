/**
 * web/server/origin-guard.ts — Step 6b 액션 모드의 요청 관문 (R6).
 *
 * 6a는 GET만 있어 이 관문이 **불필요**했다. 6b는 쓰기가 생기므로 로컬 웹 서버가 임의 명령
 * 실행 표면이 될 수 있고, 세 가지를 동시에 막아야 한다:
 *
 * 1. **토큰** — 같은 머신의 다른 프로세스(브라우저의 다른 탭·다른 로컬 앱)가 우리 포트를
 *    알아내 요청을 보내는 것. 기동 시 1회용 난수를 만들어 URL로만 전달한다.
 * 2. **Origin** — 웹페이지가 `fetch("http://127.0.0.1:PORT/actions/…")`로 교차 출처 요청을
 *    보내는 것. 브라우저는 이때 `Origin`을 붙이므로 우리 것이 아니면 거부한다.
 * 3. **Host (DNS rebinding)** — 공격자 도메인이 DNS를 `127.0.0.1`로 되돌려 **동일 출처처럼**
 *    보이게 만드는 것. 이때 `Origin`은 통과할 수 있지만 `Host` 헤더에는 그 도메인이 남는다.
 *    그래서 Origin만으로는 부족하고 Host를 함께 본다.
 *
 * ⚠️ **셋을 모두 통과해야 한다.** 하나라도 "없으면 통과"로 두면 그 항목은 사라진다 —
 * 헤더 부재는 이 관문에서 **거부 사유**다(안전 원칙 7: 판정할 수 없으면 통과시키지 않는다).
 *
 * 순수 함수다 — 헤더 맵과 기대값을 받아 판정만 반환한다.
 */

export type ActionGuardRejection =
  | "missing_token"
  | "bad_token"
  | "missing_host"
  | "bad_host"
  | "bad_origin"
  | "missing_origin";

export interface ActionGuardVerdict {
  ok: boolean;
  /** 거부 사유. 응답 본문에는 이 코드만 싣고 기대값은 절대 싣지 않는다(토큰 유출 방지). */
  reason?: ActionGuardRejection;
}

export interface ActionGuardExpectation {
  /** 기동 시 생성한 1회용 세션 토큰. */
  sessionToken: string;
  /** 이 서버가 실제로 듣고 있는 포트. `Host`/`Origin` 대조의 기준이다. */
  port: number;
}

/** 루프백을 가리키는 호스트명만 허용한다. `localhost`는 브라우저가 흔히 쓰므로 함께 받는다. */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function splitHostPort(value: string): { hostname: string; port: string | null } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // IPv6 리터럴은 대괄호로 감싸여 온다: [::1]:8787
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close === -1) return null;
    const hostname = trimmed.slice(0, close + 1);
    const rest = trimmed.slice(close + 1);
    return { hostname, port: rest.startsWith(":") ? rest.slice(1) : null };
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) return { hostname: trimmed, port: null };
  return { hostname: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) };
}

/**
 * 상수 시간 비교. 길이가 다르면 즉시 false지만(길이는 비밀이 아니다), 같은 길이에서는
 * 첫 불일치에서 빠져나가지 않는다 — 타이밍으로 토큰을 한 글자씩 알아내지 못하게 한다.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkActionRequest(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  expected: ActionGuardExpectation,
): ActionGuardVerdict {
  const header = (name: string): string | undefined => {
    const raw = headers[name];
    // 같은 헤더가 여러 번 오면 어느 것이 진짜인지 판정할 수 없다 — 통과시키지 않는다.
    if (Array.isArray(raw)) return undefined;
    return raw;
  };

  // ① Host — DNS rebinding 방어의 핵심. 없으면 거부다.
  const host = header("host");
  if (host === undefined) return { ok: false, reason: "missing_host" };
  const parsedHost = splitHostPort(host);
  if (parsedHost === null || !ALLOWED_HOSTNAMES.has(parsedHost.hostname)) return { ok: false, reason: "bad_host" };
  if (parsedHost.port !== null && parsedHost.port !== String(expected.port)) return { ok: false, reason: "bad_host" };

  // ② Origin — 브라우저가 붙이는 교차 출처 표시. 우리 자신이 아니면 거부.
  //    브라우저가 아닌 클라이언트(curl 등)는 Origin을 붙이지 않는데, 그것을 통과시키면
  //    교차 출처 페이지가 Origin을 지우는 것과 구분되지 않는다 — 그래서 부재도 거부다.
  const origin = header("origin");
  if (origin === undefined) return { ok: false, reason: "missing_origin" };
  let originHost: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return { ok: false, reason: "bad_origin" };
    originHost = url.hostname;
    if (url.port !== String(expected.port)) return { ok: false, reason: "bad_origin" };
  } catch {
    return { ok: false, reason: "bad_origin" };
  }
  if (!ALLOWED_HOSTNAMES.has(originHost)) return { ok: false, reason: "bad_origin" };

  // ③ 토큰 — 같은 머신의 다른 프로세스를 막는 유일한 수단.
  const token = header("x-ctk-session");
  if (token === undefined || token.length === 0) return { ok: false, reason: "missing_token" };
  if (!timingSafeEqualString(token, expected.sessionToken)) return { ok: false, reason: "bad_token" };

  return { ok: true };
}

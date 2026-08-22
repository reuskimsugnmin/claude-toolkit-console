import { describe, expect, it } from "vitest";
import { checkActionRequest, timingSafeEqualString } from "../server/origin-guard.js";

/**
 * R6 관문의 단위 테스트. **부정 케이스가 본문이다** — 이 파일이 검증하는 것은 "정상 요청이
 * 통과한다"가 아니라 "각 축이 실제로 막는다"이다.
 */

const EXPECTED = { sessionToken: "s".repeat(43), port: 8787 };

function headers(overrides: Record<string, string | string[] | undefined> = {}) {
  return {
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "x-ctk-session": EXPECTED.sessionToken,
    ...overrides,
  };
}

describe("정상 요청", () => {
  it("세 축을 모두 만족하면 통과한다", () => {
    expect(checkActionRequest(headers(), EXPECTED)).toEqual({ ok: true });
  });

  it("localhost 표기도 받는다 — 브라우저가 흔히 쓴다", () => {
    expect(checkActionRequest(headers({ host: "localhost:8787", origin: "http://localhost:8787" }), EXPECTED).ok).toBe(true);
  });

  it("IPv6 루프백 리터럴도 받는다", () => {
    expect(checkActionRequest(headers({ host: "[::1]:8787", origin: "http://[::1]:8787" }), EXPECTED).ok).toBe(true);
  });
});

describe("토큰 — 같은 머신의 다른 프로세스를 막는다", () => {
  it("토큰이 없으면 거부한다", () => {
    expect(checkActionRequest(headers({ "x-ctk-session": undefined }), EXPECTED)).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });

  it("빈 토큰은 '없음'과 같이 거부한다", () => {
    expect(checkActionRequest(headers({ "x-ctk-session": "" }), EXPECTED).reason).toBe("missing_token");
  });

  it("틀린 토큰은 거부한다", () => {
    expect(checkActionRequest(headers({ "x-ctk-session": "x".repeat(43) }), EXPECTED).reason).toBe("bad_token");
  });

  it("접두가 같고 뒤가 다른 토큰도 거부한다 — 부분 일치를 통과시키지 않는다", () => {
    const almost = `${EXPECTED.sessionToken.slice(0, 42)}X`;
    expect(checkActionRequest(headers({ "x-ctk-session": almost }), EXPECTED).reason).toBe("bad_token");
  });

  it("거부 응답에 기대 토큰이 실리지 않는다", () => {
    const verdict = checkActionRequest(headers({ "x-ctk-session": "wrong" }), EXPECTED);
    expect(JSON.stringify(verdict)).not.toContain(EXPECTED.sessionToken);
  });
});

describe("Host — DNS rebinding 방어", () => {
  it("Host가 없으면 거부한다", () => {
    expect(checkActionRequest(headers({ host: undefined }), EXPECTED).reason).toBe("missing_host");
  });

  it("공격자 도메인이 127.0.0.1로 되돌려져도 Host에 그 도메인이 남아 거부된다", () => {
    // rebinding의 핵심: Origin은 동일 출처처럼 보이게 만들 수 있어도 Host는 그렇지 않다.
    const verdict = checkActionRequest(
      headers({ host: "evil.example:8787", origin: "http://evil.example:8787" }),
      EXPECTED,
    );
    expect(verdict.reason).toBe("bad_host");
  });

  it("호스트는 루프백인데 포트가 다르면 거부한다", () => {
    expect(checkActionRequest(headers({ host: "127.0.0.1:9999" }), EXPECTED).reason).toBe("bad_host");
  });

  it("0.0.0.0은 루프백이 아니다", () => {
    expect(checkActionRequest(headers({ host: "0.0.0.0:8787" }), EXPECTED).reason).toBe("bad_host");
  });

  it("같은 헤더가 여러 번 오면 판정하지 않고 거부한다", () => {
    expect(checkActionRequest(headers({ host: ["127.0.0.1:8787", "evil.example"] }), EXPECTED).reason).toBe("missing_host");
  });
});

describe("Origin — 교차 출처 페이지를 막는다", () => {
  it("Origin이 없으면 거부한다 — 부재를 통과로 두면 교차 출처가 Origin을 지우는 것과 구분되지 않는다", () => {
    expect(checkActionRequest(headers({ origin: undefined }), EXPECTED).reason).toBe("missing_origin");
  });

  it("다른 사이트의 Origin은 거부한다", () => {
    expect(checkActionRequest(headers({ origin: "https://evil.example" }), EXPECTED).reason).toBe("bad_origin");
  });

  it("루프백이지만 포트가 다른 Origin은 거부한다 — 같은 머신의 다른 로컬 앱이다", () => {
    expect(checkActionRequest(headers({ origin: "http://127.0.0.1:3000" }), EXPECTED).reason).toBe("bad_origin");
  });

  it("null Origin(샌드박스 iframe·file://)은 거부한다", () => {
    expect(checkActionRequest(headers({ origin: "null" }), EXPECTED).reason).toBe("bad_origin");
  });

  it("https 스킴은 받지 않는다 — 이 서버는 http로만 듣는다", () => {
    expect(checkActionRequest(headers({ origin: "https://127.0.0.1:8787" }), EXPECTED).reason).toBe("bad_origin");
  });

  it("호스트명에 루프백을 접두로 붙인 도메인은 거부한다", () => {
    expect(checkActionRequest(headers({ origin: "http://127.0.0.1.evil.example:8787" }), EXPECTED).reason).toBe("bad_origin");
  });
});

describe("세 축이 서로를 대신하지 않는다", () => {
  it("토큰이 맞아도 Host가 틀리면 거부한다", () => {
    expect(checkActionRequest(headers({ host: "evil.example:8787" }), EXPECTED).ok).toBe(false);
  });

  it("Host·Origin이 맞아도 토큰이 없으면 거부한다", () => {
    expect(checkActionRequest(headers({ "x-ctk-session": undefined }), EXPECTED).ok).toBe(false);
  });

  it("토큰·Host가 맞아도 Origin이 틀리면 거부한다", () => {
    expect(checkActionRequest(headers({ origin: "https://evil.example" }), EXPECTED).ok).toBe(false);
  });
});

describe("timingSafeEqualString", () => {
  it("같은 문자열은 true", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
  });

  it("길이가 다르면 false", () => {
    expect(timingSafeEqualString("abc", "abcd")).toBe(false);
  });

  it("같은 길이의 다른 문자열은 false", () => {
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
  });

  it("빈 문자열끼리는 true지만 호출부가 빈 토큰을 먼저 거른다", () => {
    expect(timingSafeEqualString("", "")).toBe(true);
    expect(checkActionRequest(headers({ "x-ctk-session": "" }), { ...EXPECTED, sessionToken: "" }).reason).toBe(
      "missing_token",
    );
  });
});

describe("기본 포트(80) — 거부에 빠져나갈 길이 있어야 한다 (심사 L-a)", () => {
  const ON_80 = { sessionToken: EXPECTED.sessionToken, port: 80 };

  it("포트 80에서는 Host의 포트 생략을 받는다 — 브라우저가 기본 포트를 붙이지 않기 때문이다", () => {
    expect(
      checkActionRequest(
        { host: "127.0.0.1", origin: "http://127.0.0.1", "x-ctk-session": EXPECTED.sessionToken },
        ON_80,
      ),
    ).toEqual({ ok: true });
  });

  it("포트 80이 아니면 포트 생략은 여전히 거부한다 — 예외가 규칙을 삼키지 않는다", () => {
    expect(checkActionRequest(headers({ host: "127.0.0.1" }), EXPECTED).reason).toBe("bad_host");
  });

  it("포트 80이어도 다른 호스트명은 거부한다", () => {
    expect(
      checkActionRequest(
        { host: "evil.example", origin: "http://evil.example", "x-ctk-session": EXPECTED.sessionToken },
        ON_80,
      ).ok,
    ).toBe(false);
  });

  it("포트 80이어도 명시된 다른 포트는 거부한다", () => {
    expect(
      checkActionRequest(
        { host: "127.0.0.1:9999", origin: "http://127.0.0.1", "x-ctk-session": EXPECTED.sessionToken },
        ON_80,
      ).reason,
    ).toBe("bad_host");
  });
});

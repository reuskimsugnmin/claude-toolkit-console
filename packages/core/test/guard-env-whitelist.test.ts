import { describe, expect, it } from "vitest";
import { assertEnvWhitelist, ENV_WHITELIST_COMMON, ENV_WHITELIST_SEALED_LIVE_EXTRA } from "../src/guard/env-whitelist.js";

describe("core/guard/env-whitelist — iter 8 · B2 (순수 함수, 마지막 방어선)", () => {
  it("허용 목록 안의 키만 있으면 clean이다", () => {
    const env = { HOME: "/x", PATH: "/usr/bin" };
    expect(assertEnvWhitelist(env).status).toBe("clean");
  });

  it("허용 목록 밖 키가 하나라도 있으면 violation이고 키 이름을 보고한다(값은 담지 않는다)", () => {
    const env = { HOME: "/x", ANTHROPIC_API_KEY: "sk-secret-token" };
    const verdict = assertEnvWhitelist(env);
    expect(verdict.status).toBe("violation");
    expect(verdict.leakedKeys).toEqual(["ANTHROPIC_API_KEY"]);
    // 값이 verdict 어디에도 직렬화되지 않는다(토큰 유출 방지).
    expect(JSON.stringify(verdict)).not.toContain("sk-secret-token");
  });

  it("빈 env는 clean이다", () => {
    expect(assertEnvWhitelist({}).status).toBe("clean");
  });

  it("sealed-live 확장 목록을 명시하면 CLAUDE_CODE_SAFE_MODE도 허용된다", () => {
    const env = { HOME: "/x", CLAUDE_CODE_SAFE_MODE: "1" };
    expect(assertEnvWhitelist(env, [...ENV_WHITELIST_COMMON, ...ENV_WHITELIST_SEALED_LIVE_EXTRA]).status).toBe(
      "clean",
    );
    // 공통 목록만 쓰면 같은 키가 위반으로 잡힌다 — 프로파일별 목록이 실제로 다르다는 확인.
    expect(assertEnvWhitelist(env, ENV_WHITELIST_COMMON).status).toBe("violation");
  });
});

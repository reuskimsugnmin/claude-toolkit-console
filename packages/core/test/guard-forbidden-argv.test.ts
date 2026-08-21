import { describe, expect, it } from "vitest";
import {
  assertForbiddenArgv,
  FORBIDDEN_ARGV_RULES,
  DEFAULT_SINGLE_VALUE_ARGV_FLAGS,
} from "../src/guard/forbidden-argv.js";

describe("core/guard/forbidden-argv — 착수 조건 C5 인접(H1): 금지 리터럴 16종", () => {
  it("금지 리터럴 상수가 정확히 16종이다 (plan §1.3 결정 6 · §4.1)", () => {
    expect(FORBIDDEN_ARGV_RULES).toHaveLength(16);
  });

  it.each(FORBIDDEN_ARGV_RULES.filter((r) => !r.forbiddenValues).map((r) => r.flag))(
    "값 무관 금지 플래그 '%s'는 단독으로 등장해도 거부된다",
    (flag) => {
      const result = assertForbiddenArgv([flag]);
      expect(result.status).toBe("violation");
      expect(result.violations.some((v) => v.reason === "forbidden_flag" && v.value === flag)).toBe(
        true,
      );
    },
  );

  it.each(["bypassPermissions", "acceptEdits", "dontAsk", "auto"])(
    "--permission-mode %s 는 금지값이라 거부된다",
    (value) => {
      const result = assertForbiddenArgv(["--permission-mode", value]);
      expect(result.status).toBe("violation");
      expect(
        result.violations.some((v) => v.reason === "forbidden_value" && v.value === `--permission-mode ${value}`),
      ).toBe(true);
    },
  );

  it("--permission-mode에 금지되지 않은 값(예: default)은 통과한다", () => {
    const result = assertForbiddenArgv(["--permission-mode", "default"]);
    expect(result.status).toBe("clean");
  });

  it("금지 리터럴이 전혀 없는 정상 argv는 clean이다", () => {
    const result = assertForbiddenArgv(["--strict-mcp-config", "--disable-slash-commands", "--safe-mode"]);
    expect(result.status).toBe("clean");
  });
});

describe("core/guard/forbidden-argv — 위치인자 0개 단언 (iter 8 ⊕)", () => {
  it("프롬프트가 stdin이 아니라 위치인자로 붙으면(argv 맨 앞) 거부된다", () => {
    const result = assertForbiddenArgv(["이 자산 사용법을 알려줘", "--safe-mode"]);
    expect(result.status).toBe("violation");
    expect(result.violations[0]?.reason).toBe("positional_argument");
  });

  // --add-dir는 DEFAULT_SINGLE_VALUE_ARGV_FLAGS(값 소비 등록)이면서 동시에 FORBIDDEN_ARGV_RULES에도
  // 있다(존재 자체로 금지) — "값 1개는 clean" 전제가 성립하지 않으므로 이 일반화 루프에서 제외하고
  // 아래 별도 테스트에서 확인한다.
  const forbiddenFlagSet = new Set(FORBIDDEN_ARGV_RULES.map((r) => r.flag));
  it.each(DEFAULT_SINGLE_VALUE_ARGV_FLAGS.filter((f) => !forbiddenFlagSet.has(f)))(
    "가변인자 플래그 '%s'는 값 1개는 정상 소비하지만 그 뒤에 또 비-플래그 토큰이 오면 위치인자 위반이다",
    (flag) => {
      // flag 값 1개까지는 정상 — 추가로 딸려온 두 번째 토큰이 "삼켜진 위치인자"다.
      const clean = assertForbiddenArgv([flag, "intended-value"]);
      expect(clean.status).toBe("clean");

      const withSwallowedPositional = assertForbiddenArgv([flag, "intended-value", "sneaked-in-extra"]);
      expect(withSwallowedPositional.status).toBe("violation");
      expect(
        withSwallowedPositional.violations.some(
          (v) => v.reason === "positional_argument" && v.value === "sneaked-in-extra",
        ),
      ).toBe(true);
    },
  );

  it("'--add-dir'는 존재 자체로 금지(forbidden_flag)이면서, 값 뒤 추가 토큰은 위치인자 위반도 함께 낸다", () => {
    const bare = assertForbiddenArgv(["--add-dir", "intended-value"]);
    expect(bare.status).toBe("violation");
    expect(bare.violations.some((v) => v.reason === "forbidden_flag" && v.value === "--add-dir")).toBe(true);

    const withSwallowedPositional = assertForbiddenArgv(["--add-dir", "intended-value", "sneaked-in-extra"]);
    expect(
      withSwallowedPositional.violations.some(
        (v) => v.reason === "positional_argument" && v.value === "sneaked-in-extra",
      ),
    ).toBe(true);
  });

  it("--tools \"\" (빈 문자열, ADR-004가 요구하는 필수 사용법)는 위치인자 위반을 만들지 않는다", () => {
    const result = assertForbiddenArgv(["--tools", ""]);
    expect(result.status).toBe("clean");
  });

  it("boolean 플래그 사이에 낀 순수 위치인자도 검출된다", () => {
    const result = assertForbiddenArgv(["--safe-mode", "unexpected-positional", "--disable-slash-commands"]);
    expect(result.status).toBe("violation");
    expect(
      result.violations.some((v) => v.reason === "positional_argument" && v.value === "unexpected-positional"),
    ).toBe(true);
  });

  it("빈 argv는 clean이다", () => {
    expect(assertForbiddenArgv([]).status).toBe("clean");
  });
});

describe("core/guard/forbidden-argv — 순수 함수 계약", () => {
  it("동일 입력에 항상 동일 판정을 낸다 (결정적)", () => {
    const argv = ["--dangerously-skip-permissions", "stray"];
    const first = assertForbiddenArgv(argv);
    const second = assertForbiddenArgv(argv);
    expect(first).toEqual(second);
  });

  it("호출자가 rules/singleValueFlags를 교체하면 판정이 갈린다 (C2와 같은 파라미터화 원칙)", () => {
    const strict = assertForbiddenArgv(["--timeout-sec", "30"], FORBIDDEN_ARGV_RULES, []);
    // singleValueFlags를 빈 배열로 주면 "30"은 어떤 플래그의 값으로도 인정되지 않아 위치인자다.
    expect(strict.status).toBe("violation");

    const withRegisteredFlag = assertForbiddenArgv(
      ["--timeout-sec", "30"],
      FORBIDDEN_ARGV_RULES,
      ["--timeout-sec"],
    );
    expect(withRegisteredFlag.status).toBe("clean");
  });
});

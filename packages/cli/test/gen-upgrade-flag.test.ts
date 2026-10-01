import { describe, expect, it } from "vitest";
import { runGenCli, UpgradeRequiresLlmError } from "../src/commands/gen.js";

/**
 * cli/test/gen-upgrade-flag.test.ts — `--upgrade-rule-extract`는 LLM 경로 전용이다. `--no-llm`과 함께면
 * 규칙 추출 문서를 다시 규칙 추출로 만들 뿐이라 **아무것도 읽거나 쓰기 전에** 거부한다.
 */
describe("cli/gen — --upgrade-rule-extract × --no-llm", () => {
  it("함께 주면 카탈로그를 열기 전에 UpgradeRequiresLlmError로 거부한다", async () => {
    await expect(
      runGenCli({ noLlm: true, upgradeRuleExtract: true, maxBudgetUsd: 0.01, timeoutSec: 1 }),
    ).rejects.toBeInstanceOf(UpgradeRequiresLlmError);
  });
});

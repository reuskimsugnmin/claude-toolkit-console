import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TIER1_INTENTIONAL_WRITES } from "@ctk/core";
import { auditPassed, auditRoot, captureRootSnapshot, readClaudeJsonRawOrNull } from "../src/audit.js";

describe("actuator/audit — probe/tree-collect 수집 -> core/guard 판정 배선(AC-2.7)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-audit-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("Tier-1(settings.json)만 바뀌면 통과한다", () => {
    writeFileSync(path.join(root, "settings.json"), '{"enabledPlugins":{}}', "utf8");
    const before = captureRootSnapshot(root);
    writeFileSync(path.join(root, "settings.json"), '{"enabledPlugins":{"a@b":true}}', "utf8");
    const after = captureRootSnapshot(root);

    const result = auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: false }, before, after, null);
    expect(auditPassed(result)).toBe(true);
  });

  it("허용목록 밖 파일이 바뀌면 위반이다(config 루트, Tier-2 미적용 — project 루트 흉내)", () => {
    writeFileSync(path.join(root, "settings.json"), "{}", "utf8");
    writeFileSync(path.join(root, "CLAUDE.md"), "original", "utf8");
    const before = captureRootSnapshot(root);
    writeFileSync(path.join(root, "CLAUDE.md"), "tampered", "utf8"); // ctk가 쓰지 않은 경로
    const after = captureRootSnapshot(root);

    const result = auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: false }, before, after, null);
    expect(auditPassed(result)).toBe(false);
    expect(result.verdict.overallStatus).toBe("violation");
  });

  it("CLAUDE.md 변경은 Tier-2 churn을 허용해도(config 루트) 여전히 위반이다(AC-2.7-c 금지 목록, churn 예외 없음)", () => {
    writeFileSync(path.join(root, "settings.json"), "{}", "utf8");
    writeFileSync(path.join(root, "CLAUDE.md"), "original", "utf8");
    const before = captureRootSnapshot(root);
    writeFileSync(path.join(root, "CLAUDE.md"), "tampered", "utf8");
    const after = captureRootSnapshot(root);

    const result = auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true }, before, after, null);
    expect(auditPassed(result)).toBe(false);
  });

  it("config 루트에서 .claude.json 바이트 churn은 허용되지만 의미 diff가 위반이면 전체가 위반이다(F5)", () => {
    writeFileSync(path.join(root, "settings.json"), "{}", "utf8");
    writeFileSync(path.join(root, ".claude.json"), '{"numStartups":1}', "utf8");
    const before = captureRootSnapshot(root);
    const claudeJsonBeforeRaw = readClaudeJsonRawOrNull(root);
    writeFileSync(path.join(root, ".claude.json"), '{"numStartups":2}', "utf8"); // 바이트+의미 둘 다 변경
    const after = captureRootSnapshot(root);

    const result = auditRoot(
      { rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true },
      before,
      after,
      claudeJsonBeforeRaw,
    );
    // 파일 자체는 Tier-2라 tree-diff verdict만 보면 allowed_churn이지만, 의미 diff가 위반이므로
    // auditPassed는 전체를 위반으로 판정해야 한다(F5 — 화이트리스트 방향).
    expect(result.verdict.overallStatus).toBe("allowed_churn");
    expect(result.claudeJsonSemantic?.overallStatus).toBe("violation");
    expect(auditPassed(result)).toBe(false);
  });

  it("config 루트에서 .claude.json이 바이트만 바뀌고 의미가 동일하면 통과한다(재포맷 등, 실측 형태)", () => {
    writeFileSync(path.join(root, "settings.json"), "{}", "utf8");
    writeFileSync(path.join(root, ".claude.json"), '{"a":1,"b":2}', "utf8");
    const before = captureRootSnapshot(root);
    const claudeJsonBeforeRaw = readClaudeJsonRawOrNull(root);
    writeFileSync(path.join(root, ".claude.json"), '{\n  "b": 2,\n  "a": 1\n}\n', "utf8"); // 키 순서만 바뀜(의미 동일)
    const after = captureRootSnapshot(root);

    const result = auditRoot(
      { rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true },
      before,
      after,
      claudeJsonBeforeRaw,
    );
    expect(auditPassed(result)).toBe(true);
  });

  it("동적으로 구성된 스킬 Tier-1(정확한 스킬명)은 그 스킬 파일 변경만 허용한다", () => {
    mkdirSync(path.join(root, "skills", "demo-skill"), { recursive: true });
    writeFileSync(path.join(root, "skills", "demo-skill", "SKILL.md"), "v1", "utf8");
    const before = captureRootSnapshot(root);
    writeFileSync(path.join(root, "skills", "demo-skill", "SKILL.md"), "v2", "utf8");
    const after = captureRootSnapshot(root);

    const tier1 = [{ pattern: /^skills\/demo-skill(\/|$)/, note: "대상 스킬" }];
    const result = auditRoot({ rootAbs: root, tier1, allowTier2Churn: false }, before, after, null);
    expect(auditPassed(result)).toBe(true);
  });

  it("다른 스킬 디렉터리 변경은 Tier-1 밖이라 위반이다(다른 스킬을 건드리면 안 된다)", () => {
    mkdirSync(path.join(root, "skills", "demo-skill"), { recursive: true });
    mkdirSync(path.join(root, "skills", "unrelated-skill"), { recursive: true });
    writeFileSync(path.join(root, "skills", "demo-skill", "SKILL.md"), "v1", "utf8");
    writeFileSync(path.join(root, "skills", "unrelated-skill", "SKILL.md"), "v1", "utf8");
    const before = captureRootSnapshot(root);
    writeFileSync(path.join(root, "skills", "unrelated-skill", "SKILL.md"), "tampered", "utf8");
    const after = captureRootSnapshot(root);

    const tier1 = [{ pattern: /^skills\/demo-skill(\/|$)/, note: "대상 스킬" }];
    const result = auditRoot({ rootAbs: root, tier1, allowTier2Churn: false }, before, after, null);
    expect(auditPassed(result)).toBe(false);
  });
});

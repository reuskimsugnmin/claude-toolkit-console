import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TIER1_INTENTIONAL_WRITES } from "@ctk/core";
import {
  ForbiddenPathWriteError,
  WhitelistViolationError,
  auditFailureError,
  auditPassed,
  auditRoot,
  captureRootSnapshot,
  readClaudeJsonRawOrNull,
} from "../src/audit.js";

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

  it(
    "✅ M2 재현 — before가 부재(.claude.json 없음)이고 after가 손상돼 있으면(구문 오류) " +
      "예전엔 둘 다 {}로 뭉개져 deep-equal이 성립해 손상이 감사를 조용히 통과했다. 지금은 " +
      "파싱 실패를 감지해 던진다(auditRoot가 throw — auditPassed로 조용히 false가 되는 게 " +
      "아니라 호출 자체가 실패한다)",
    () => {
      writeFileSync(path.join(root, "settings.json"), "{}", "utf8");
      const before = captureRootSnapshot(root); // .claude.json 부재
      const claudeJsonBeforeRaw = readClaudeJsonRawOrNull(root); // null(정상 부재)
      writeFileSync(path.join(root, "settings.json"), "{}", "utf8"); // churn 유발 없음 — 아래서 직접 구성
      // Tier-2 churn 판정이 .claude.json을 "바뀜"으로 잡으려면 트리에도 나타나야 한다.
      writeFileSync(path.join(root, ".claude.json"), "{not valid json", "utf8");
      const after = captureRootSnapshot(root);

      expect(() =>
        auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true }, before, after, claudeJsonBeforeRaw),
      ).toThrow(WhitelistViolationError);
    },
  );

  it(
    "✅ M5 재현 — auditFailureError()는 감사 위반의 failure_class를 실제로 채운다. 금지 목록" +
      "(CLAUDE.md 등)에 걸린 위반은 forbidden_path_write, 단순히 허용목록 밖인 위반은 " +
      "whitelist_violation이다(수정 전에는 평문 Error만 던져져 failure_class가 항상 " +
      "unclassified로 남았다)",
    () => {
      // 1) 단순 허용목록 밖 위반 — whitelist_violation.
      writeFileSync(path.join(root, "settings.json"), "{}", "utf8");
      writeFileSync(path.join(root, "extra.json"), "before", "utf8");
      const before1 = captureRootSnapshot(root);
      writeFileSync(path.join(root, "extra.json"), "after", "utf8");
      const after1 = captureRootSnapshot(root);
      const result1 = auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: false }, before1, after1, null);
      expect(auditPassed(result1)).toBe(false);
      const err1 = auditFailureError(result1, "테스트");
      expect(err1).toBeInstanceOf(WhitelistViolationError);
      expect(err1.failureClass).toBe("whitelist_violation");

      // 2) 금지 목록(AC-2.7-c) 위반 — forbidden_path_write.
      writeFileSync(path.join(root, "CLAUDE.md"), "original", "utf8");
      const before2 = captureRootSnapshot(root);
      writeFileSync(path.join(root, "CLAUDE.md"), "tampered", "utf8");
      const after2 = captureRootSnapshot(root);
      const result2 = auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true }, before2, after2, null);
      expect(auditPassed(result2)).toBe(false);
      const err2 = auditFailureError(result2, "테스트");
      expect(err2).toBeInstanceOf(ForbiddenPathWriteError);
      expect(err2.failureClass).toBe("forbidden_path_write");
    },
  );

  it(
    "✅ M7 재현 — plugins/repos/** (플러그인 코드 트리) 변경은 실제 조치 감사(Tier-2 churn)를 " +
      "통과하지 못한다. 이전에는 미실측 항목까지 같은 TIER2_CHURN_ALLOWLIST에 섞여 있어 조치 " +
      "도중 플러그인 소스가 바뀌어도(공급망 위협 시나리오) 조용히 허용됐다",
    () => {
      writeFileSync(path.join(root, "settings.json"), "{}", "utf8");
      mkdirSync(path.join(root, "plugins", "repos", "demo-plugin"), { recursive: true });
      writeFileSync(path.join(root, "plugins", "repos", "demo-plugin", "index.js"), "original", "utf8");
      const before = captureRootSnapshot(root);
      writeFileSync(path.join(root, "plugins", "repos", "demo-plugin", "index.js"), "tampered", "utf8");
      const after = captureRootSnapshot(root);

      const result = auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true }, before, after, null);
      expect(auditPassed(result)).toBe(false);
    },
  );
});

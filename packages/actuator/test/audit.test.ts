import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TIER1_INTENTIONAL_WRITES } from "@ctk/core";
import { claudeJsonPath, resolveHomeContext } from "@ctk/probe";
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

    const result = auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true, claudeJsonAbs: path.join(root, ".claude.json") }, before, after, null);
    expect(auditPassed(result)).toBe(false);
  });

  it("config 루트에서 .claude.json 바이트 churn은 허용되지만 의미 diff가 위반이면 전체가 위반이다(F5)", () => {
    writeFileSync(path.join(root, "settings.json"), "{}", "utf8");
    writeFileSync(path.join(root, ".claude.json"), '{"numStartups":1}', "utf8");
    const before = captureRootSnapshot(root);
    const claudeJsonBeforeRaw = readClaudeJsonRawOrNull(path.join(root, ".claude.json"));
    writeFileSync(path.join(root, ".claude.json"), '{"numStartups":2}', "utf8"); // 바이트+의미 둘 다 변경
    const after = captureRootSnapshot(root);

    const result = auditRoot(
      { rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true, claudeJsonAbs: path.join(root, ".claude.json") },
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
    const claudeJsonBeforeRaw = readClaudeJsonRawOrNull(path.join(root, ".claude.json"));
    writeFileSync(path.join(root, ".claude.json"), '{\n  "b": 2,\n  "a": 1\n}\n', "utf8"); // 키 순서만 바뀜(의미 동일)
    const after = captureRootSnapshot(root);

    const result = auditRoot(
      { rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true, claudeJsonAbs: path.join(root, ".claude.json") },
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
      const claudeJsonBeforeRaw = readClaudeJsonRawOrNull(path.join(root, ".claude.json")); // null(정상 부재)
      writeFileSync(path.join(root, "settings.json"), "{}", "utf8"); // churn 유발 없음 — 아래서 직접 구성
      // Tier-2 churn 판정이 .claude.json을 "바뀜"으로 잡으려면 트리에도 나타나야 한다.
      writeFileSync(path.join(root, ".claude.json"), "{not valid json", "utf8");
      const after = captureRootSnapshot(root);

      expect(() =>
        auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true, claudeJsonAbs: path.join(root, ".claude.json") }, before, after, claudeJsonBeforeRaw),
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
      const result2 = auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true, claudeJsonAbs: path.join(root, ".claude.json") }, before2, after2, null);
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

      const result = auditRoot({ rootAbs: root, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true, claudeJsonAbs: path.join(root, ".claude.json") }, before, after, null);
      expect(auditPassed(result)).toBe(false);
    },
  );

  describe("프로덕션 형태 — CTK_CONFIG_DIR 미설정(configDirExplicit=false): 실제 파일은 $HOME/.claude.json", () => {
    const PLUGIN = "demo@market";
    const PROJECT_KEY = "/synthetic/project";
    // 실제 경로 계산·스냅샷·감사 함수를 그대로 쓴다(스텁 없음). env는 CTK_HOME만 — CTK_CONFIG_DIR 없음.
    function setup(initialHome: unknown, initialInner?: unknown) {
      const home = resolveHomeContext({ CTK_HOME: root });
      expect(home.configDirExplicit).toBe(false); // 이 describe의 전제 자체를 확인한다
      mkdirSync(home.ctkConfigDir, { recursive: true });
      writeFileSync(path.join(home.ctkConfigDir, "settings.json"), "{}", "utf8");
      const realAbs = claudeJsonPath(home);
      expect(realAbs).toBe(path.join(root, ".claude.json"));
      expect(path.dirname(realAbs)).not.toBe(home.ctkConfigDir); // 트리 밖 — 트리 스냅샷에 안 잡힌다
      writeFileSync(realAbs, JSON.stringify(initialHome), "utf8");
      const innerAbs = path.join(home.ctkConfigDir, ".claude.json");
      if (initialInner !== undefined) writeFileSync(innerAbs, JSON.stringify(initialInner), "utf8");
      const before = captureRootSnapshot(home.ctkConfigDir);
      const beforeRaw = readClaudeJsonRawOrNull(realAbs);
      const audit = () =>
        auditRoot(
          { rootAbs: home.ctkConfigDir, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true, claudeJsonAbs: claudeJsonPath(home), enabledPluginId: PLUGIN },
          before,
          captureRootSnapshot(home.ctkConfigDir, before.cache),
          beforeRaw,
        );
      return { realAbs, innerAbs, audit };
    }

    it("(a) $HOME/.claude.json의 projects[k].mcpServers 추가는 위반이다(AC-R7-1 형태)", () => {
      const { realAbs, audit } = setup({ numStartups: 1, projects: { [PROJECT_KEY]: { mcpServers: {} } } });
      writeFileSync(realAbs, JSON.stringify({ numStartups: 1, projects: { [PROJECT_KEY]: { mcpServers: { evil: { command: "x" } } } } }), "utf8");
      const result = audit();
      expect(result.verdict.overallStatus).toBe("clean"); // 트리에는 아무것도 안 나타난다 — 예전 게이트가 못 보던 상태
      expect(result.claudeJsonSemantic?.overallStatus).toBe("violation");
      expect(result.claudeJsonSemantic?.violations.some((v) => v.mcpForbidden)).toBe(true);
      // 정확히 이 한 경로만 바뀐 것으로 읽혀야 한다 — 엉뚱한 파일을 읽었다면 numStartups까지 "사라진" 것으로 잡혀 2건 이상이 된다.
      expect(result.claudeJsonSemantic?.changed.map((c) => c.path)).toEqual([expect.stringMatching(/^projects\.#[0-9a-f]{8}\.mcpServers$/)]);
      expect(auditPassed(result)).toBe(false);
    });

    it("(b) plugin enable 흔적(pluginUsage[id].lastUsedAt/lastUsedNumStartups)만이면 통과한다", () => {
      const { realAbs, audit } = setup({ pluginUsage: { [PLUGIN]: { usageCount: 3, lastUsedAt: 1, lastUsedNumStartups: 5 } } });
      writeFileSync(realAbs, JSON.stringify({ pluginUsage: { [PLUGIN]: { usageCount: 3, lastUsedAt: 2, lastUsedNumStartups: 0 } } }), "utf8");
      const result = audit();
      expect(result.claudeJsonSemantic?.overallStatus).toBe("allowed_churn"); // 의미 감사가 실제로 돌았다
      expect(auditPassed(result)).toBe(true);
    });

    it.each([
      ["promptQueueUseCount", 1, 2],
      ["additionalModelOptionsAnsweredAt", 1, 2],
      ["additionalModelOptionsCache", { a: 1 }, { a: 2, b: 3 }],
      ["cachedExperimentData", { a: 1 }, { a: 2 }],
      ["cachedExperimentFeatures", { a: 1 }, { a: 2 }],
      ["cachedGrowthBookFeatures", { a: 1 }, { a: 2 }],
      ["cachedGrowthBookFeaturesAt", 1, 2],
      ["clientDataCacheSlots", { a: 1 }, { a: 2 }],
      ["replBridgePlaceholders", { a: 1 }, { a: 2 }],
    ])("(d) 실측된 live-session 키 %s 단독 변경은 통과한다 (MCP 서브트리는 같은 파일에 그대로)", (key, was, now) => {
      const mcp = { projects: { [PROJECT_KEY]: { mcpServers: {} } } };
      const { realAbs, audit } = setup({ ...mcp, [key]: was });
      writeFileSync(realAbs, JSON.stringify({ ...mcp, [key]: now }), "utf8");
      const result = audit();
      expect(result.claudeJsonSemantic?.overallStatus).toBe("allowed_churn");
      expect(auditPassed(result)).toBe(true);
    });

    it("(e) 다른 플러그인의 기존 pluginUsage 항목 lastUsedAt/usageCount 변경은 통과한다(이동 대상 enable 흔적과 동시여도)", () => {
      const { realAbs, audit } = setup({ pluginUsage: { other: { usageCount: 1, lastUsedAt: 1 }, [PLUGIN]: { usageCount: 3, lastUsedAt: 1, lastUsedNumStartups: 5 } } });
      writeFileSync(realAbs, JSON.stringify({ pluginUsage: { other: { usageCount: 2, lastUsedAt: 9 }, [PLUGIN]: { usageCount: 3, lastUsedAt: 2, lastUsedNumStartups: 0 } } }), "utf8");
      expect(auditPassed(audit())).toBe(true);
    });

    it("(e') 다른 플러그인의 pluginUsage 신규 항목·다른 필드 변경은 위반이다", () => {
      const s1 = setup({ pluginUsage: { other: { usageCount: 1, lastUsedAt: 1 } } });
      writeFileSync(s1.realAbs, JSON.stringify({ pluginUsage: { other: { usageCount: 1, lastUsedAt: 1 }, brandnew: { usageCount: 0, lastUsedAt: 1 } } }), "utf8");
      expect(auditPassed(s1.audit())).toBe(false);
      writeFileSync(s1.realAbs, JSON.stringify({ pluginUsage: { other: { usageCount: 1, lastUsedAt: 1, extra: true } } }), "utf8");
      expect(auditPassed(s1.audit())).toBe(false);
    });

    it("L1 — 허용 키 변경과 projects[k].mcpServers 변경이 함께 있으면 위반이다(허용 목록이 MCP 서브트리를 덮지 않는다)", () => {
      const { realAbs, audit } = setup({ cachedGrowthBookFeaturesAt: 1, projects: { [PROJECT_KEY]: { mcpServers: {} } } });
      writeFileSync(realAbs, JSON.stringify({ cachedGrowthBookFeaturesAt: 2, projects: { [PROJECT_KEY]: { mcpServers: { evil: { command: "x" } } } } }), "utf8");
      const result = audit();
      expect(auditPassed(result)).toBe(false);
      expect(result.claudeJsonSemantic?.violations.some((v) => v.mcpForbidden)).toBe(true);
    });

    it("(f) 미측정 키(numStartups) 변경은 위반이고 실패 메시지에 변경 경로가 들어가며 의미 위반 표지가 선다", () => {
      const { realAbs, audit } = setup({ numStartups: 1 });
      writeFileSync(realAbs, JSON.stringify({ numStartups: 2 }), "utf8");
      const result = audit();
      expect(auditPassed(result)).toBe(false);
      const error = auditFailureError(result, "config 트리 감사 위반");
      expect(error.message).toContain("numStartups");
      // 복구 안내는 롤백 결과를 아는 호출자(cli/move.ts)가 붙인다 — 여기서 "롤백됐다"고 단정하지 않는다.
      expect(error.message).not.toContain("롤백");
      expect(error.claudeJsonSemanticViolation).toBe(true);
    });

    it("(c) $HOME/.claude/.claude.json(트리 안 별개 파일)만 바뀌면 진짜 파일로 오인하지 않는다 — 의미 감사는 돌지 않고 트리 감사만 받는다", () => {
      const { innerAbs, audit } = setup({ numStartups: 1 }, { projects: { [PROJECT_KEY]: { mcpServers: {} } } });
      writeFileSync(innerAbs, JSON.stringify({ projects: { [PROJECT_KEY]: { mcpServers: { evil: { command: "x" } } } } }), "utf8");
      const result = audit();
      expect(result.claudeJsonSemantic).toBeNull(); // 진짜 파일은 바이트 동일
      expect(result.verdict.modified.some((e) => e.path === ".claude.json")).toBe(true); // 트리 감사는 본다
    });

    it("진짜 파일이 손상되면 던진다(fail-closed) — 진단에 경로와 시점이 들어간다", () => {
      const { realAbs, audit } = setup({ numStartups: 1 });
      writeFileSync(realAbs, "{not json", "utf8");
      let message = "";
      try {
        audit();
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/\.claude\.json\(after\) 파싱 실패/);
      expect(message).toContain("SyntaxError");
      expect(message).not.toContain(root); // 절대경로 없음
      expect(message).not.toContain("not json"); // V8 SyntaxError의 내용 조각 없음
    });
  });
});

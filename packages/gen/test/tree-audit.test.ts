import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditSealedLiveConfigDir, captureConfigDirSnapshot, readClaudeJsonRawOrNull, sealedLiveAuditPassed } from "../src/tree-audit.js";

describe("gen/tree-audit — AC-3.7 (sealed-live 전용 Tier-2 허용목록, AC-0.11 기준)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("변경이 없으면 clean이다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-"));
    const before = captureConfigDirSnapshot(dir);
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(true);
    expect(result.verdict.overallStatus).toBe("clean");
  });

  it("AC-0.11 실측 churn(sessions/<pid>.json)은 허용된다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-sessions-"));
    const before = captureConfigDirSnapshot(dir);
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    writeFileSync(path.join(dir, "sessions", "12345.json"), "{}");
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(true);
    expect(result.verdict.overallStatus).toBe("allowed_churn");
  });

  it("허용목록 밖 경로가 바뀌면 위반이다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-violation-"));
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(dir, "CLAUDE.md"), "# 새로 생김");
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(false);
    expect(result.verdict.overallStatus).toBe("violation");
  });

  it(".claude.json은 cachedGrowthBookFeaturesAt 한 키만 바뀌면 통과한다(AC-0.11 실측)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-cjson-"));
    const beforeJson = JSON.stringify({ cachedGrowthBookFeaturesAt: 1, projects: {} });
    writeFileSync(path.join(dir, ".claude.json"), beforeJson);
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ cachedGrowthBookFeaturesAt: 2, projects: {} }));
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, beforeJson);
    expect(sealedLiveAuditPassed(result)).toBe(true);
    expect(result.claudeJsonSemantic?.overallStatus).toBe("allowed_churn");
  });

  it(".claude.json에서 허용 키 밖의 값이 바뀌면 위반이다(화이트리스트 방향, F5)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-cjson-violation-"));
    const beforeJson = JSON.stringify({ numStartups: 1 });
    writeFileSync(path.join(dir, ".claude.json"), beforeJson);
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ numStartups: 2 }));
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, beforeJson);
    expect(sealedLiveAuditPassed(result)).toBe(false);
    expect(result.claudeJsonSemantic?.overallStatus).toBe("violation");
  });

  it("readClaudeJsonRawOrNull은 파일이 없으면 null, 있으면 원문을 반환한다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-read-"));
    expect(readClaudeJsonRawOrNull(dir)).toBeNull();
    writeFileSync(path.join(dir, ".claude.json"), '{"x":1}');
    expect(readClaudeJsonRawOrNull(dir)).toBe('{"x":1}');
  });
});

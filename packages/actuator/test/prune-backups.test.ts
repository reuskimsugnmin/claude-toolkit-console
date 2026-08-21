import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneBackupRuns } from "../src/backup.js";

/**
 * 백업 보존 정책(M1 후속). 핵심은 "정리가 데이터 손실의 원인이 되지 않는다" — 중단된 복원이
 * 남아 있는 런은 사용자 파일이 그 안에만 존재할 수 있으므로 보존 대상에서 절대 빠지지 않는다.
 */
describe("actuator/pruneBackupRuns — 백업 보존 정책", () => {
  let backupsRoot: string;
  beforeEach(() => {
    backupsRoot = mkdtempSync(path.join(os.tmpdir(), "ctk-prune-"));
  });
  afterEach(() => {
    rmSync(backupsRoot, { recursive: true, force: true });
  });

  const seedRun = (runId: string, opts: { interrupted?: boolean } = {}): void => {
    const root = path.join(backupsRoot, runId);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "manifest.json"), "{}", "utf8");
    if (opts.interrupted) mkdirSync(path.join(root, ".restore-evicted", "k"), { recursive: true });
  };

  it("keep 이하이면 아무것도 지우지 않는다", () => {
    seedRun("2026-01-01T00-00-00Z.aaa");
    seedRun("2026-01-02T00-00-00Z.bbb");
    const { removed } = pruneBackupRuns(backupsRoot, 10);
    expect(removed).toHaveLength(0);
  });

  it("오래된 런부터 지우고 최근 keep개를 남긴다", () => {
    for (const d of ["01", "02", "03", "04", "05"]) seedRun(`2026-01-${d}T00-00-00Z.x`);
    const { removed, kept } = pruneBackupRuns(backupsRoot, 2);
    expect(removed).toEqual(["2026-01-01T00-00-00Z.x", "2026-01-02T00-00-00Z.x", "2026-01-03T00-00-00Z.x"]);
    expect(kept).toEqual(["2026-01-04T00-00-00Z.x", "2026-01-05T00-00-00Z.x"]);
    expect(existsSync(path.join(backupsRoot, "2026-01-05T00-00-00Z.x"))).toBe(true);
  });

  it("중단된 복원이 있는 런은 오래됐어도 지우지 않는다 (정리가 손실이 되면 안 된다)", () => {
    seedRun("2026-01-01T00-00-00Z.old", { interrupted: true });
    for (const d of ["02", "03", "04"]) seedRun(`2026-01-${d}T00-00-00Z.x`);

    const { removed, kept } = pruneBackupRuns(backupsRoot, 1);
    expect(removed).not.toContain("2026-01-01T00-00-00Z.old");
    expect(kept).toContain("2026-01-01T00-00-00Z.old");
    // 사용자 파일이 그 안에 살아 있어야 한다.
    expect(existsSync(path.join(backupsRoot, "2026-01-01T00-00-00Z.old", ".restore-evicted", "k"))).toBe(true);
  });

  it("백업 루트가 없으면 조용히 빈 결과다 (아직 조치가 없었던 정상 상태)", () => {
    expect(pruneBackupRuns(path.join(backupsRoot, "없음"))).toEqual({ removed: [], kept: [] });
  });

  it("백업 루트를 읽을 수 없으면 '정리할 것 없음'이 아니라 판정 불가로 던진다", () => {
    const asFile = path.join(backupsRoot, "not-a-dir");
    writeFileSync(asFile, "x", "utf8");
    expect(() => pruneBackupRuns(asFile)).toThrow(/적용할 수 없다/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findInterruptedRestores } from "../src/rollback.js";

/**
 * 2-phase 복원은 대상을 삭제하지 않고 `.restore-evicted/<key>`로 퇴피시킨 뒤 교체한다.
 * 그 사이에 프로세스가 죽으면 대상 자리는 비어 있고 사용자 파일은 evicted에만 남는다 —
 * **복구 가능한데 소실로 보이는** 상태다. 아무도 알려주지 않으면 그 자체가 손실이 된다
 * (CLAUDE.md 안전 원칙 5: 없음과 실패를 구분한다).
 */
describe("actuator/findInterruptedRestores — 중단된 복원 탐지", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "ctk-interrupted-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedRun(runId: string, key: string, targetAbs: string | null): string {
    const backupRoot = path.join(tmp, ".ctk-backups", runId);
    mkdirSync(path.join(backupRoot, ".restore-evicted", key), { recursive: true });
    if (targetAbs !== null) {
      writeFileSync(
        path.join(backupRoot, "manifest.json"),
        JSON.stringify({
          run_id: runId,
          created_at: "2026-08-21T00:00:00.000Z",
          entries: { [key]: { kind: "directory", targetAbs, existed: true, files: [], storedRelPath: key } },
        }),
        "utf8",
      );
    }
    return backupRoot;
  }

  it("잔존물이 없으면 빈 목록이다", () => {
    mkdirSync(path.join(tmp, ".ctk-backups"), { recursive: true });
    expect(findInterruptedRestores(path.join(tmp, ".ctk-backups"))).toHaveLength(0);
  });

  it("백업 루트 자체가 없으면 빈 목록이다 (정상 상태 — 아직 조치가 없었다)", () => {
    expect(findInterruptedRestores(path.join(tmp, "없는경로"))).toHaveLength(0);
  });

  it("중단된 복원을 찾아내고 대상 자리가 비었음을 보고한다", () => {
    const missingTarget = path.join(tmp, "skills", "demo");
    seedRun("run-1", "skill_dir", missingTarget);

    const found = findInterruptedRestores(path.join(tmp, ".ctk-backups"));
    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe("skill_dir");
    expect(found[0]?.targetAbs).toBe(missingTarget);
    // 이것이 핵심 — 대상이 비어 있으므로 사용자에게는 파일이 사라진 것으로 보인다.
    expect(found[0]?.targetMissing).toBe(true);
  });

  it("대상이 이미 복구돼 있으면 targetMissing=false로 구분한다", () => {
    const existingTarget = path.join(tmp, "skills", "restored");
    mkdirSync(existingTarget, { recursive: true });
    seedRun("run-2", "skill_dir", existingTarget);

    const found = findInterruptedRestores(path.join(tmp, ".ctk-backups"));
    expect(found[0]?.targetMissing).toBe(false);
  });

  it("manifest를 읽을 수 없어도 잔존물 자체는 보고한다 (조용히 넘어가지 않는다)", () => {
    seedRun("run-3", "orphan", null); // manifest 없음

    const found = findInterruptedRestores(path.join(tmp, ".ctk-backups"));
    expect(found).toHaveLength(1);
    expect(found[0]?.targetAbs).toBeNull();
  });

  it("백업 루트를 읽을 수 없으면 '잔존물 없음'이 아니라 판정 불가로 던진다", () => {
    const filePath = path.join(tmp, "not-a-dir");
    writeFileSync(filePath, "x", "utf8");
    expect(() => findInterruptedRestores(filePath)).toThrow(/판정할 수 없다/);
  });
});

import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { collectTree } from "@ctk/probe";
import { atomicWriteFile } from "./guard/atomic-write.js";
import { readManifest, type BackupEntry } from "./backup.js";

/**
 * actuator/src/rollback.ts — 검증 실패 시 자동, 사용자 요청 시 수동(§4 Step 5). 백업에서
 * **직접 파일을 복원**한다(CLI를 다시 부르지 않는다) — 롤백은 "조치 이전 스냅샷과 완전히
 * 동일"해야 하는 결정적(deterministic) 연산이어야 하고(AC-2.5), CLI를 다시 호출하면 그 시점의
 * 하네스 상태(예: 이미 disabled인데 다시 disable 시도)에 좌우될 수 있다. 복원 쓰기는
 * `guard/atomic-write.ts`를 그대로 재사용한다(temp write → fsync → rename, AC-2.8과 동형).
 *
 * 복원 후 자체적으로 sha256을 검증한다 — 복원 자체가 실패하면(파일시스템 오류 등) 여기서
 * `RollbackFailedError`(`failure_class: rollback_failed`)로 던진다. 이 오류는 **최악**이므로
 * (§7.2) 백업 경로를 그대로 실어 호출자가 §7.2의 "수동 복구 런북"을 안내할 수 있게 한다.
 */

export class RollbackFailedError extends Error {
  readonly failureClass = "rollback_failed" as const;
  readonly backupRoot: string;
  readonly manifestPath: string;
  constructor(backupRoot: string, cause: unknown) {
    super(
      `롤백 자체가 실패했다 — 수동 복구가 필요하다. 백업: ${backupRoot}, ` +
        `manifest: ${path.join(backupRoot, "manifest.json")}, 원인: ${String(cause)}`,
    );
    this.name = "RollbackFailedError";
    this.backupRoot = backupRoot;
    this.manifestPath = path.join(backupRoot, "manifest.json");
    this.cause = cause;
  }
}

function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function restoreFileEntry(entry: Extract<BackupEntry, { kind: "file" }>, backupRoot: string, targetAbs: string): void {
  if (!entry.existed) {
    if (existsSync(targetAbs)) rmSync(targetAbs);
    return;
  }
  const storedAbs = path.join(backupRoot, entry.storedRelPath!);
  const content = readFileSync(storedAbs, "utf8");
  atomicWriteFile(targetAbs, content);
  const restoredSha = sha256File(targetAbs);
  if (restoredSha !== entry.sha256) {
    throw new Error(`복원 후 sha256 불일치(기대 ${entry.sha256}, 실제 ${restoredSha}): ${targetAbs}`);
  }
}

function restoreDirectoryEntry(
  entry: Extract<BackupEntry, { kind: "directory" }>,
  backupRoot: string,
  targetAbs: string,
): void {
  if (existsSync(targetAbs)) rmSync(targetAbs, { recursive: true, force: true });
  if (!entry.existed) return;
  const storedAbs = path.join(backupRoot, entry.storedRelPath!);
  cpSync(storedAbs, targetAbs, { recursive: true });
  const restored = collectTree(targetAbs).entries;
  const restoredByPath = new Map(restored.map((f) => [f.path, f.sha256]));
  if (restored.length !== entry.files.length) {
    throw new Error(`복원 후 파일 개수 불일치(기대 ${entry.files.length}, 실제 ${restored.length}): ${targetAbs}`);
  }
  for (const f of entry.files) {
    if (restoredByPath.get(f.relPath) !== f.sha256) {
      throw new Error(`복원 후 ${f.relPath}의 sha256 불일치: ${targetAbs}`);
    }
  }
}

/**
 * `backupRoot`의 manifest에 있는 **모든** 항목을 각자의 `targetAbs`로 복원한다. 각 항목이
 * 자신의 복원 대상 경로를 스스로 담고 있으므로(backup.ts — 카탈로그 밖이라 AC-1.7 대상이
 * 아니다), 호출자는 무엇을 백업했는지 다시 알 필요가 없다 — `ctk rollback --last`가
 * journal의 `backup_ref`만으로 복원할 수 있는 이유다.
 *
 * 하나라도 실패하면 즉시 `RollbackFailedError`로 던진다(부분 복원 상태를 성공으로 보고하지
 * 않는다) — 이미 복원된 항목들은 그대로 남는다(추가 되돌리기 시도는 하지 않는다, "롤백의
 * 롤백"은 더 큰 손상 위험).
 */
export function restoreFromBackup(backupRoot: string): void {
  let manifest;
  try {
    manifest = readManifest(backupRoot);
  } catch (cause) {
    throw new RollbackFailedError(backupRoot, cause);
  }

  for (const [key, entry] of Object.entries(manifest.entries)) {
    try {
      if (entry.kind === "file") {
        restoreFileEntry(entry, backupRoot, entry.targetAbs);
      } else {
        restoreDirectoryEntry(entry, backupRoot, entry.targetAbs);
      }
    } catch (cause) {
      throw new RollbackFailedError(backupRoot, new Error(`키 '${key}' 복원 실패: ${String(cause)}`));
    }
  }
}

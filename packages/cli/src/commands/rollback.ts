import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildRollbackJournalEntry, manifestSha256Of, restoreFromBackup } from "@ctk/actuator";
import { resolveHomeContext } from "@ctk/probe";
import { FAILURE_CLASSES, type FailureClass, type JournalEntry, type RunLogEntry } from "@ctk/core";
import { acquireLock, commitAll, writeJournalEntry, writeRunLog } from "@ctk/sync";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { CatalogNotInitializedError } from "./scan.js";

/**
 * cli/src/commands/rollback.ts — `ctk rollback --last`. v1은 가장 최근 journal 레코드 하나만
 * 되돌린다(§4 Step 5 CLI 표면). 백업은 `actuator/rollback.ts`가 그대로 복원하고(manifest가
 * 자기 복원 대상을 담고 있다 — backup.ts), 이 모듈은 journal에서 대상을 찾고 뒤집힌 상태로
 * 새 journal 레코드(action:"rollback")를 남기는 오케스트레이션만 한다.
 *
 * ⚠️ **Step 5 보안 심사 수정(H2/H3/AC-2.13)**:
 * - 되돌릴 대상 journal 레코드의 `backup_manifest_sha256`을 `restoreFromBackup()`에 넘겨,
 *   백업 저장소(카탈로그 밖, `.ctk-backups/`)가 journal 커밋 이후 변조되지 않았음을 대조한다.
 * - `restoreFromBackup()`은 이제 `home`(허용 루트 계산용)을 받는다(H2 — 복원 대상이 `<config>`
 *   또는 알려진 `<project>/.claude` 안인지 단일 관문에서 검증).
 * - 성공·실패 양쪽 모두 run-log를 남긴다(H3/AC-5.1). journal은 성공했을 때만 새로 남긴다 —
 *   롤백 자체가 실패하면(`RollbackFailedError`) 무엇이 실제로 바뀌었는지 알 수 없어 journal에
 *   확정적인 after 상태를 적을 수 없다(run-log의 failure_class로만 기록한다).
 */

export { CatalogNotInitializedError };

export class NoRollbackTargetError extends Error {
  constructor(reason: string) {
    super(`되돌릴 대상이 없다 — ${reason}`);
    this.name = "NoRollbackTargetError";
  }
}

export interface RollbackOptions {
  /** v1은 --last만 지원한다(§4 Step 5 CLI 표면 — 임의 journal id 지정은 범위 밖). */
  last: true;
}

export interface RollbackSummary {
  assetId: string;
  action: JournalEntry["action"];
  backupRef: string;
  journalPath: string;
}

function listJournalFilesSorted(catalogPath: string): string[] {
  const journalDir = path.join(catalogPath, "journal");
  if (!existsSync(journalDir)) return [];
  return readdirSync(journalDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
}

function readJournalEntry(catalogPath: string, file: string): JournalEntry {
  const raw = readFileSync(path.join(catalogPath, "journal", file), "utf8").trim();
  return JSON.parse(raw) as JournalEntry;
}

function findLastEntry(catalogPath: string): { entry: JournalEntry; file: string } {
  const files = listJournalFilesSorted(catalogPath);
  const lastFile = files[files.length - 1];
  if (lastFile === undefined) throw new NoRollbackTargetError("journal 레코드가 없다 — 아직 아무 것도 이동하지 않았다");
  return { entry: readJournalEntry(catalogPath, lastFile), file: lastFile };
}

function backupRefToAbs(homeDir: string, homeRelative: string): string {
  // normalizePath()의 home_relative 형식은 항상 "~/..." — 앞의 "~"만 잘라내고 join한다.
  return path.join(homeDir, homeRelative.slice(1));
}

const FAILURE_CLASS_SET = new Set<string>(FAILURE_CLASSES);

function extractFailureClass(err: unknown): FailureClass {
  if (
    typeof err === "object" &&
    err !== null &&
    "failureClass" in err &&
    typeof (err as { failureClass: unknown }).failureClass === "string" &&
    FAILURE_CLASS_SET.has((err as { failureClass: string }).failureClass)
  ) {
    return (err as { failureClass: FailureClass }).failureClass;
  }
  return "unclassified";
}

function writeRunLogSafely(catalogPath: string, entry: RunLogEntry): void {
  try {
    writeRunLog(catalogPath, entry);
  } catch {
    // best-effort — 원본 성공/실패 결과에 영향을 주지 않는다.
  }
}

export async function runRollback(_options: RollbackOptions): Promise<RollbackSummary> {
  const startedAt = new Date();
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;
  const machine = readOrCreateMachineIdentity(home, "local-machine");

  const lock = acquireLock(catalogPath, {
    command: "rollback",
    origin: "cli",
    started_at: startedAt.toISOString(),
    machine_id: machine.machine_id,
  });

  try {
    // findLastEntry가 문자 그대로 "가장 최근" journal 레코드를 고른다 — H3 수정으로 실패/
    // 자기-롤백 시도도 journal에 남으므로, 그 시도가 최신이면 아래 result!=="success" 검사가
    // 자동으로 거부한다(더 최근에 failure/rolled_back이 있으면 그보다 오래된 성공을 되돌리지
    // 않는다는 지시사항을 이 하나의 검사로 충족한다).
    const { entry } = findLastEntry(catalogPath);
    if (entry.action === "rollback") {
      throw new NoRollbackTargetError("마지막 journal 레코드가 이미 rollback이다 — 다시 되돌릴 이동이 없다");
    }
    if (entry.result !== "success") {
      throw new NoRollbackTargetError(`마지막 이동의 result가 "${entry.result}"다 — 성공한 이동만 되돌릴 수 있다`);
    }

    const backupRootAbs = backupRefToAbs(home.ctkHome, entry.backup_ref);
    restoreFromBackup(backupRootAbs, home, entry.backup_manifest_sha256);

    const rollbackEntry = buildRollbackJournalEntry({
      originalAction: entry.action,
      assetId: entry.asset_id,
      machineId: machine.machine_id,
      homeDir: home.ctkHome,
      before: entry.after,
      after: entry.before,
      backupRootAbs,
      manifestSha256: manifestSha256Of(backupRootAbs),
      result: "success",
    });
    const { path: journalPath } = writeJournalEntry(catalogPath, rollbackEntry);
    commitAll(catalogPath, `ctk rollback: ${entry.asset_id} (${entry.action})`);

    writeRunLogSafely(catalogPath, {
      schema_version: 1,
      _scope: "machine_dependent",
      command: "rollback",
      args: { asset_id: entry.asset_id, original_action: entry.action },
      machine_id: machine.machine_id,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      exit_code: 0,
      failure_class: null,
    });

    return { assetId: entry.asset_id, action: entry.action, backupRef: entry.backup_ref, journalPath };
  } catch (err) {
    writeRunLogSafely(catalogPath, {
      schema_version: 1,
      _scope: "machine_dependent",
      command: "rollback",
      args: {},
      machine_id: machine.machine_id,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      exit_code: 1,
      failure_class: extractFailureClass(err),
    });
    throw err;
  } finally {
    lock.release();
  }
}

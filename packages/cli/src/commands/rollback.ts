import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildRollbackJournalEntry, restoreFromBackup } from "@ctk/actuator";
import { resolveHomeContext } from "@ctk/probe";
import type { JournalEntry } from "@ctk/core";
import { acquireLock, commitAll, writeJournalEntry } from "@ctk/sync";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { CatalogNotInitializedError } from "./scan.js";

/**
 * cli/src/commands/rollback.ts — `ctk rollback --last`. v1은 가장 최근 journal 레코드 하나만
 * 되돌린다(§4 Step 5 CLI 표면). 백업은 `actuator/rollback.ts`가 그대로 복원하고(manifest가
 * 자기 복원 대상을 담고 있다 — backup.ts), 이 모듈은 journal에서 대상을 찾고 뒤집힌 상태로
 * 새 journal 레코드(action:"rollback")를 남기는 오케스트레이션만 한다.
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

export async function runRollback(_options: RollbackOptions): Promise<RollbackSummary> {
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;
  const machine = readOrCreateMachineIdentity(home, "local-machine");

  const lock = acquireLock(catalogPath, {
    command: "rollback",
    origin: "cli",
    started_at: new Date().toISOString(),
    machine_id: machine.machine_id,
  });

  try {
    const { entry } = findLastEntry(catalogPath);
    if (entry.action === "rollback") {
      throw new NoRollbackTargetError("마지막 journal 레코드가 이미 rollback이다 — 다시 되돌릴 이동이 없다");
    }
    if (entry.result !== "success") {
      throw new NoRollbackTargetError(`마지막 이동의 result가 "${entry.result}"다 — 성공한 이동만 되돌릴 수 있다`);
    }

    const backupRootAbs = backupRefToAbs(home.ctkHome, entry.backup_ref);
    restoreFromBackup(backupRootAbs);

    const rollbackEntry = buildRollbackJournalEntry({
      originalAction: entry.action,
      assetId: entry.asset_id,
      machineId: machine.machine_id,
      homeDir: home.ctkHome,
      before: entry.after,
      after: entry.before,
      backupRootAbs,
      result: "success",
    });
    const { path: journalPath } = writeJournalEntry(catalogPath, rollbackEntry);
    commitAll(catalogPath, `ctk rollback: ${entry.asset_id} (${entry.action})`);

    return { assetId: entry.asset_id, action: entry.action, backupRef: entry.backup_ref, journalPath };
  } finally {
    lock.release();
  }
}

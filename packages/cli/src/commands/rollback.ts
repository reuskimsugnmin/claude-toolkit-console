import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildRollbackJournalEntry, manifestSha256Of, restoreFromBackup } from "@ctk/actuator";
import { resolveHomeContext } from "@ctk/probe";
import { FAILURE_CLASSES, parseJournalEntry, type FailureClass, type JournalEntry, type RunLogEntry } from "@ctk/core";
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
  // L5 — 캐스팅이 아니라 zod로 검증한다(카탈로그는 git으로 동기화되므로, 다른 머신이 쓴 값이나
  // 손으로 편집된 값이 그대로 rollback 인자가 될 수 있다).
  return parseJournalEntry(JSON.parse(raw) as unknown);
}

/**
 * ⚠️ **Step 5 보안 심사 수정(L4)** — journal 파일명(`journal/<iso8601>.jsonl`)에 `machine_id`가
 * 없다. 카탈로그는 git으로 여러 머신에 동기화되므로(CLAUDE.md — "조치는 현재 로컬에서만
 * 실행한다"), sync를 붙이면 `journal/` 아래 여러 머신의 레코드가 섞여 쌓인다. 이전에는
 * "가장 최근 파일"을 무조건 골랐다 — 그게 다른 머신이 만든 레코드면, 그 백업(`backup_ref`)은
 * **이 머신에 존재하지 않는 로컬 전용 디렉터리**를 가리키므로 롤백이 엉뚱한(혹은 존재하지 않는)
 * 대상을 되돌리려 시도한다. 이 머신이 만든 레코드만 후보로 거른다.
 */
function findLastEntry(catalogPath: string, machineId: string): { entry: JournalEntry; file: string } {
  const files = listJournalFilesSorted(catalogPath);
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i]!;
    const entry = readJournalEntry(catalogPath, file);
    if (entry.machine_id === machineId) return { entry, file };
  }
  throw new NoRollbackTargetError("이 머신이 만든 journal 레코드가 없다 — 아직 아무 것도 이동하지 않았다(다른 머신의 기록은 되돌리지 않는다)");
}

/** journal의 `backup_ref`(home-relative)가 실제로 `~/...` 형식이 아니면 던진다(L8). */
export class InvalidBackupRefError extends Error {
  constructor(homeRelative: string) {
    super(`journal의 backup_ref가 "~/"로 시작하지 않는다(카탈로그 변조 의심): ${homeRelative}`);
    this.name = "InvalidBackupRefError";
  }
}

/**
 * ⚠️ **Step 5 보안 심사 수정(L8)** — 카탈로그는 git으로 동기화되므로 `journal`의 `backup_ref`는
 * 신뢰할 수 없는 입력이다(zod 스키마는 `min(1)`만 보장할 뿐 `"~/..."` 형식은 강제하지 않는다).
 * 이전에는 `.slice(1)`이 무검증이라, `backup_ref`가 `"~/../../etc/passwd"` 같은 값이면
 * 홈 밖으로 탈출한 절대경로가 만들어질 수 있었다(H2의 `assertRestorableTarget`이 이후 단계에서
 * 잡아내긴 하지만, 이 함수 자체도 방어선을 갖춘다 — 심층 방어). `~/`로 시작하지 않으면 즉시
 * 거부하고, 계산된 결과가 실제로 `homeDir` 안인지도 재확인한다.
 */
function backupRefToAbs(homeDir: string, homeRelative: string): string {
  if (!homeRelative.startsWith("~/") && homeRelative !== "~") {
    throw new InvalidBackupRefError(homeRelative);
  }
  const rest = homeRelative === "~" ? "" : homeRelative.slice(2);
  const abs = path.join(homeDir, rest);
  const normalizedHome = path.resolve(homeDir);
  const normalizedAbs = path.resolve(abs);
  if (normalizedAbs !== normalizedHome && !normalizedAbs.startsWith(`${normalizedHome}${path.sep}`)) {
    throw new InvalidBackupRefError(homeRelative);
  }
  return abs;
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
    const { entry } = findLastEntry(catalogPath, machine.machine_id);
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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { RollbackFailedError, buildRollbackJournalEntry, describeClaudeJsonLeftover, manifestSha256Of, restoreFromBackup } from "@ctk/actuator";
import { resolveHomeContext } from "@ctk/probe";
import { extractFailureClass, McpToggleJournalStateSchema, parseJournalEntry, type JournalEntry } from "@ctk/core";
import { acquireLock, commitAll, writeJournalEntry } from "@ctk/sync";
import { writeRunLogSafely } from "../run-log-safe.js";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { CatalogNotInitializedError } from "./scan.js";
import { inverseMcpToggleCommand } from "./mcp-toggle.js";

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

/**
 * R7 — `toggle_mcp_project` 레코드는 `ctk rollback`이 되돌리지 않는다. `restoreFromBackup`은 `.claude.json`을 복원하지 않아(P0)
 * 파일 0개를 복원하고 **"성공"을 journal에 남기는** 허구가 된다. 웹 롤백도 `NoRollbackTargetError`를 400으로 분류하므로 하위 클래스로 둔다.
 */
export class McpToggleRollbackRefusedError extends NoRollbackTargetError {
  readonly failureClass = "mcp_toggle_refused" as const;
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
  /** `.claude.json`을 복원하지 않고 남긴 사정 중 사람이 봐야 할 것(허용 밖 변경 등). 없으면 null. */
  claudeJsonNote: string | null;
  /** `.claude.json` 점검 상태 — manifest에 항목이 없으면 "absent". */
  claudeJsonStatus: "absent" | "ok" | "violation" | "unjudgeable";
  claudeJsonMcpForbidden: boolean;
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
    // R7 risk 2 — 다른 머신의 레코드는 이 ctk가 모르는 action일 수 있다(더 새 버전이 쓴 것). 엄격 파싱은 **이 머신의 레코드에만** 한다.
    // 소유를 가리는 `machine_id`는 느슨하게 먼저 읽는다. 읽을 수 없거나 문자열이 아니면 누구 것인지 모르므로 건너뛰지 않고 던진다.
    const owner = readMachineIdLoose(catalogPath, file);
    if (owner !== machineId) continue;
    return { entry: readJournalEntry(catalogPath, file), file };
  }
  throw new NoRollbackTargetError("이 머신이 만든 journal 레코드가 없다 — 아직 아무 것도 이동하지 않았다(다른 머신의 기록은 되돌리지 않는다)");
}

function readMachineIdLoose(catalogPath: string, file: string): string {
  const raw = readFileSync(path.join(catalogPath, "journal", file), "utf8").trim();
  const owner = (JSON.parse(raw) as { machine_id?: unknown } | null)?.machine_id;
  if (typeof owner !== "string") throw new Error(`journal 레코드에서 machine_id를 읽지 못했다: ${file}`);
  return owner;
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

/**
 * 거부 사유 + 되돌리는 명령. `journal`은 동기화된 — 신뢰할 수 없는 — 저장소에서 오므로, 스키마를 통과하고 성공 기록일 때만 명령을 만든다.
 * 자산 id가 안전하게 찍을 수 있는 모양인지는 `inverseMcpToggleCommand`가 **단일 관문**으로 거른다(여기서 한 번 더 걸러 사본을 만들지 않는다) —
 * 안전하지 않으면 `null`이고, 그러면 일반 안내(명령 없음)다.
 */
function describeToggleRefusal(entry: JournalEntry): string {
  const head = "마지막 기록은 MCP 토글이다 — `ctk rollback`은 .claude.json을 복원하지 않는다(다른 세션의 변경을 덮어쓸 수 있다).";
  const after = McpToggleJournalStateSchema.safeParse(entry.after);
  const cmd =
    after.success && entry.result === "success"
      ? inverseMcpToggleCommand(after.data.disabled ? "disable" : "enable", entry.asset_id, after.data.project_path_hash)
      : null;
  return cmd !== null ? `${head} 되돌리려면: ${cmd}` : `${head} 되돌릴 명령을 안전하게 만들 수 없다 — 먼저 \`ctk scan\`을 실행해 현재 상태를 확인한 뒤 \`ctk mcp\`로 직접 되돌린다.`;
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
    // R7 — result 검사·복원보다 **먼저** 거부한다. 쓰기도 journal도 만들지 않는다.
    if (entry.action === "toggle_mcp_project") throw new McpToggleRollbackRefusedError(describeToggleRefusal(entry));
    if (entry.action === "rollback") {
      throw new NoRollbackTargetError("마지막 journal 레코드가 이미 rollback이다 — 다시 되돌릴 이동이 없다");
    }
    if (entry.result !== "success") {
      throw new NoRollbackTargetError(`마지막 이동의 result가 "${entry.result}"다 — 성공한 이동만 되돌릴 수 있다`);
    }

    const backupRootAbs = backupRefToAbs(home.ctkHome, entry.backup_ref);
    const restoreReport = restoreFromBackup(backupRootAbs, home, entry.backup_manifest_sha256, undefined, { enabledPluginId: entry.asset_id });

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
      // journal은 스키마가 엄격해 .claude.json 점검 신호를 못 싣는다 — 지속 기록은 run-log다.
      args: {
        asset_id: entry.asset_id,
        original_action: entry.action,
        claude_json: restoreReport.claudeJson?.status ?? "absent",
        claude_json_mcp_forbidden: restoreReport.claudeJson?.mcpForbidden ?? false,
        restored_keys: restoreReport.restoredKeys,
      },
      machine_id: machine.machine_id,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      exit_code: 0,
      failure_class: null,
    });

    return {
      assetId: entry.asset_id,
      action: entry.action,
      backupRef: entry.backup_ref,
      journalPath,
      claudeJsonNote: describeClaudeJsonLeftover(restoreReport, entry.backup_ref),
      claudeJsonStatus: restoreReport.claudeJson?.status ?? "absent",
      claudeJsonMcpForbidden: restoreReport.claudeJson?.mcpForbidden ?? false,
    };
  } catch (err) {
    writeRunLogSafely(catalogPath, {
      schema_version: 1,
      _scope: "machine_dependent",
      command: "rollback",
      args: err instanceof RollbackFailedError ? { restored_keys: err.restoredKeys, unrestored_keys: err.unrestoredKeys } : {},
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

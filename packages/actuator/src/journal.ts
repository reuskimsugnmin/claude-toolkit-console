import { normalizePath, type InstallScope, type JournalAction, type JournalEntry, type JournalResult } from "@ctk/core";

/**
 * actuator/src/journal.ts — `before`/`after`가 필수인 감사 레코드를 **반환만 한다**(P1-5).
 * 카탈로그 저장소 append는 `sync/journal-store.ts`가 `cli`의 지시로 수행한다 — actuator는
 * 카탈로그 쓰기 루트를 만들지 않는다(계층 lint `no-restricted-imports`가 actuator→sync import를
 * 이미 차단한다).
 *
 * **경로 필드는 `~/…` 홈 상대화까지만 허용한다 — `path_hash` 폴백을 쓰지 않는다.** 다른
 * append-only 레코드(스냅샷 등)는 홈 상대화가 안 되면 `path_hash`로 대체하지만(정상 폴백),
 * `backup_ref`(백업 원본 경로)는 **복원 명령의 인자 그 자체**다 — 해시로는 복원이 불가능해
 * 롤백이 깨진다. 정규화 자체가 안 되면(homeDir 접두사가 아예 안 맞는 등) 저장이 아니라
 * **실패**로 처리한다(`path_normalize_failed`, F4).
 */

export class PathNormalizeFailedError extends Error {
  readonly failureClass = "path_normalize_failed" as const;
  readonly fieldName: string;
  constructor(fieldName: string) {
    super(
      `journal 레코드의 ${fieldName} 필드를 홈 상대 경로로 정규화할 수 없다 — ` +
        `path_hash 폴백은 이 필드에서 금지된다(복원 명령의 인자이므로 해시로는 롤백이 불가능하다)`,
    );
    this.name = "PathNormalizeFailedError";
    this.fieldName = fieldName;
  }
}

function homeRelativeOrThrow(rawAbsolutePath: string, homeDir: string, fieldName: string): string {
  const normalized = normalizePath(rawAbsolutePath, homeDir);
  if (normalized.home_relative === null) {
    throw new PathNormalizeFailedError(fieldName);
  }
  return normalized.home_relative;
}

export interface PluginEnablementState {
  install_scope: InstallScope | null;
  enabled_at: InstallScope | null;
}

export interface BuildPluginEnablementJournalOptions {
  assetId: string;
  machineId: string;
  homeDir: string;
  before: PluginEnablementState;
  after: PluginEnablementState;
  backupRootAbs: string;
  /** 백업 manifest.json 바이트의 sha256(H2/AC-2.13, `backup.ts`의 `writeManifest().manifestSha256`). */
  manifestSha256: string;
  result: JournalResult;
  timestamp?: string;
}

export function buildPluginEnablementJournalEntry(options: BuildPluginEnablementJournalOptions): JournalEntry {
  const backup_ref = homeRelativeOrThrow(options.backupRootAbs, options.homeDir, "backup_ref");
  return {
    schema_version: 1,
    _scope: "machine_dependent",
    action: "move_plugin_enablement",
    asset_id: options.assetId,
    machine_id: options.machineId,
    before: { ...options.before },
    after: { ...options.after },
    backup_ref,
    backup_manifest_sha256: options.manifestSha256,
    result: options.result,
    timestamp: options.timestamp ?? new Date().toISOString(),
  };
}

export interface SkillDirLocationState {
  /** "user"(전역) | "project"(프로젝트). `Installation.enabled_at`과 동일 어휘를 쓴다(probe/skills.ts).
   * 원문 경로가 아니라 스코프 분류만 담는다(AC-1.7). */
  location: "user" | "project";
  /** location==="project"일 때만 채워진다 — 원문이 아니라 해시(core/normalizePath와 동일 계산). */
  project_path_hash: string | null;
}

export interface BuildSkillDirJournalOptions {
  assetId: string;
  machineId: string;
  homeDir: string;
  before: SkillDirLocationState;
  after: SkillDirLocationState;
  backupRootAbs: string;
  manifestSha256: string;
  result: JournalResult;
  timestamp?: string;
}

export function buildSkillDirJournalEntry(options: BuildSkillDirJournalOptions): JournalEntry {
  const backup_ref = homeRelativeOrThrow(options.backupRootAbs, options.homeDir, "backup_ref");
  return {
    schema_version: 1,
    _scope: "machine_dependent",
    action: "move_skill_dir",
    asset_id: options.assetId,
    machine_id: options.machineId,
    before: { ...options.before },
    after: { ...options.after },
    backup_ref,
    backup_manifest_sha256: options.manifestSha256,
    result: options.result,
    timestamp: options.timestamp ?? new Date().toISOString(),
  };
}

export interface BuildRollbackJournalOptions {
  /** 되돌리는 대상 journal 레코드의 action — 롤백 레코드 자체의 action은 항상 "rollback"이다. */
  originalAction: JournalAction;
  assetId: string;
  machineId: string;
  homeDir: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  backupRootAbs: string;
  manifestSha256: string;
  result: JournalResult;
  timestamp?: string;
}

export function buildRollbackJournalEntry(options: BuildRollbackJournalOptions): JournalEntry {
  const backup_ref = homeRelativeOrThrow(options.backupRootAbs, options.homeDir, "backup_ref");
  return {
    schema_version: 1,
    _scope: "machine_dependent",
    action: "rollback",
    asset_id: options.assetId,
    machine_id: options.machineId,
    before: { original_action: options.originalAction, ...options.before },
    after: { ...options.after },
    backup_ref,
    backup_manifest_sha256: options.manifestSha256,
    result: options.result,
    timestamp: options.timestamp ?? new Date().toISOString(),
  };
}

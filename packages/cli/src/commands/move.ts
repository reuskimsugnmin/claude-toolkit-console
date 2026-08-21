import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertMovableAssetKind,
  auditPassed,
  auditRoot,
  backupFile,
  backupDirectory,
  beginBackupRun,
  buildPluginEnablementJournalEntry,
  buildSkillDirJournalEntry,
  captureRootSnapshot,
  movePluginEnablement,
  moveSkillDir as applyMoveSkillDir,
  readClaudeJsonRawOrNull,
  restoreFromBackup,
  verifyPluginEnablementMove,
  verifySkillDirMove,
  writeManifest,
} from "@ctk/actuator";
import { listKnownProjectPaths, resolveHomeContext, type HomeContext } from "@ctk/probe";
import {
  FORBIDDEN_RULES,
  TIER1_INTENTIONAL_WRITES,
  matchesForbidden,
  normalizePath,
  parseInstalledPluginsFile,
  snapshotIdFsSafe,
  type AssetKind,
  type InstallScope,
} from "@ctk/core";
import { acquireLock, writeJournalEntry, commitAll } from "@ctk/sync";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { CatalogNotInitializedError } from "./scan.js";

/**
 * cli/src/commands/move.ts — `ctk move` 오케스트레이션. actuator의 building block(backup·apply·
 * audit·verify·rollback·journal)을 배선한다 — 순서는 절대 규칙이다: **백업 → 수정 → 검증(재스캔
 * 실측) → 실패 시 롤백**. journal 레코드는 actuator가 반환만 하고, 카탈로그 저장소 append는
 * 여기서 `@ctk/sync`로 한다(P1-5 — actuator에 카탈로그 쓰기 루트를 두지 않는다).
 */

export { CatalogNotInitializedError };

export class AssetNotFoundError extends Error {
  constructor(assetId: string) {
    super(`카탈로그 index.json에서 asset_id를 찾지 못했다: ${assetId} — 먼저 \`ctk scan\`을 실행했는지 확인하라.`);
    this.name = "AssetNotFoundError";
  }
}

export class NoOpMoveError extends Error {
  constructor() {
    super("출발지와 목적지 스코프가 같다 — 이동할 것이 없다.");
    this.name = "NoOpMoveError";
  }
}

export class ProjectIndexOutOfRangeError extends Error {
  constructor(index: number, known: number) {
    super(`--project-index ${index}가 범위를 벗어났다 — 알려진 프로젝트 ${known}개(0..${known - 1}).`);
    this.name = "ProjectIndexOutOfRangeError";
  }
}

/**
 * `path_traversal_detected`류 방어(H2와 동일 논리) — 스킬 자산 id는 SKILL.md frontmatter의
 * `name` 필드에서 온다(probe/sources/skills.ts). 그 필드는 서드파티 스킬 저자가 쓰는 값이고,
 * 이 함수가 곧바로 `path.join(root, "skills", assetId)`의 세그먼트로 쓰인다 — frontmatter에
 * `name: ../../evil`류 값을 자칭하면 스킬 디렉터리 트리 밖으로 쓰기를 탈출시킬 수 있다.
 * `core/guard/forbidden.ts`의 판정을 그대로 재사용한다(경로 순회·절대경로·NUL 금지 — H1과
 * 동형으로 여기서도 판정기를 재구현하지 않는다) + 단일 경로 세그먼트여야 하므로 `/` 자체도 막는다.
 */
function assertSafePathSegment(value: string, fieldName: string): void {
  if (value.length === 0) throw new Error(`${fieldName}가 비어있다`);
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`${fieldName}에 경로 구분자가 포함될 수 없다(단일 경로 세그먼트여야 한다): ${value}`);
  }
  const forbidden = matchesForbidden(value, FORBIDDEN_RULES);
  if (forbidden) {
    throw new Error(`${fieldName}가 금지된 경로 패턴과 일치한다(${forbidden.note}): ${value}`);
  }
}

export interface MoveOptions {
  assetId: string;
  to: "user" | "project";
  toProjectIndex?: number;
  from?: "user" | "project";
  fromProjectIndex?: number;
  timeoutSec?: number;
}

export interface MoveSummary {
  assetId: string;
  kind: AssetKind;
  from: string;
  to: string;
  journalPath: string;
}

interface CatalogIndexEntry {
  id: string;
  kind: AssetKind;
  name: string;
}

function readCatalogAssetKind(catalogPath: string, assetId: string): AssetKind {
  const indexAbsPath = path.join(catalogPath, "catalog", "index.json");
  if (!existsSync(indexAbsPath)) throw new AssetNotFoundError(assetId);
  const index = JSON.parse(readFileSync(indexAbsPath, "utf8")) as { assets: CatalogIndexEntry[] };
  const entry = index.assets.find((a) => a.id === assetId);
  if (!entry) throw new AssetNotFoundError(assetId);
  return entry.kind;
}

function resolveProjectPath(home: HomeContext, index: number | undefined): string {
  if (index === undefined) {
    throw new Error("project 스코프에는 --project-index가 필요하다.");
  }
  const known = listKnownProjectPaths(home);
  const projectPath = known[index];
  if (projectPath === undefined) throw new ProjectIndexOutOfRangeError(index, known.length);
  return projectPath;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function movePluginAsset(
  home: HomeContext,
  machineId: string,
  catalogPath: string,
  options: MoveOptions,
): Promise<MoveSummary> {
  const timeoutSec = options.timeoutSec ?? 30;
  const fromScope: InstallScope = options.from ?? "user";
  const toScope: InstallScope = options.to;
  const fromProjectPath = fromScope === "project" ? resolveProjectPath(home, options.fromProjectIndex) : null;
  const toProjectPath = toScope === "project" ? resolveProjectPath(home, options.toProjectIndex) : null;
  if (fromScope === toScope && fromProjectPath === toProjectPath) throw new NoOpMoveError();

  const tmpCwd = mkdtempSync(path.join(tmpdir(), "ctk-move-"));
  const fromCwd = fromScope === "user" ? tmpCwd : fromProjectPath!;
  const toCwd = toScope === "user" ? tmpCwd : toProjectPath!;

  const configRoot = home.ctkConfigDir;
  const involvedProjectPaths = [...new Set([fromProjectPath, toProjectPath].filter((p): p is string => p !== null))];

  try {
    // ---- 1. before 스냅샷(백업·감사·저널 전부의 기준선) ----
    const configBefore = captureRootSnapshot(configRoot);
    const claudeJsonBeforeRaw = readClaudeJsonRawOrNull(configRoot);
    const projectBefores = new Map(involvedProjectPaths.map((p) => [p, captureRootSnapshot(path.join(p, ".claude"))]));

    const installedPluginsAbsPath = path.join(configRoot, "plugins", "installed_plugins.json");
    const installedPluginsShaBefore =
      configBefore.entries.find((e) => e.path === "plugins/installed_plugins.json")?.sha256 ?? null;
    const installedPluginsBefore = existsSync(installedPluginsAbsPath)
      ? parseInstalledPluginsFile(JSON.parse(readFileSync(installedPluginsAbsPath, "utf8")) as unknown)
      : { plugins: {} };
    // install_scope는 레지스트리(installed_plugins.json) 유래이며 move가 절대 바꾸지 않는다
    // (AC-2.1ⓑ) — journal에는 실측된 실제 값을 담는다(가정하지 않는다). 같은 id가 여러 스코프로
    // 설치돼 있을 수 있으나(P1-13), 여기서는 이 액션이 옮기는 enablement의 등록 스코프로
    // fromScope와 일치하는 첫 엔트리를 채택한다.
    const registryScope =
      installedPluginsBefore.plugins[options.assetId]?.find((e) => e.scope === fromScope)?.scope ??
      installedPluginsBefore.plugins[options.assetId]?.[0]?.scope ??
      null;

    // ---- 2. 백업 ----
    const runId = snapshotIdFsSafe();
    const { backupRoot } = beginBackupRun(home.ctkHome, runId);
    const fromSettingsAbs =
      fromScope === "user" ? path.join(configRoot, "settings.json") : path.join(fromProjectPath!, ".claude", "settings.json");
    const toSettingsAbs =
      toScope === "user" ? path.join(configRoot, "settings.json") : path.join(toProjectPath!, ".claude", "settings.json");
    const backupEntries: Record<string, ReturnType<typeof backupFile>> = { from_settings: backupFile(backupRoot, "from_settings", fromSettingsAbs) };
    if (toSettingsAbs !== fromSettingsAbs) {
      backupEntries.to_settings = backupFile(backupRoot, "to_settings", toSettingsAbs);
    }
    writeManifest(backupRoot, runId, backupEntries);

    const rollbackAndThrow = (cause: unknown): never => {
      restoreFromBackup(backupRoot);
      throw cause;
    };

    // ---- 3. 적용 ----
    try {
      await movePluginEnablement({
        assetId: options.assetId,
        fromScope,
        toScope,
        home,
        fromCwd,
        toCwd,
        timeoutSec,
      });
    } catch (err) {
      rollbackAndThrow(err);
    }

    // ---- 4. 감사(AC-2.7) ----
    const configAfter = captureRootSnapshot(configRoot);
    const configAudit = auditRoot(
      { rootAbs: configRoot, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true },
      configBefore,
      configAfter,
      claudeJsonBeforeRaw,
    );
    if (!auditPassed(configAudit)) {
      rollbackAndThrow(
        new Error(
          `config 트리 감사 위반: ${JSON.stringify(configAudit.verdict.violations)} / .claude.json 의미 위반: ${JSON.stringify(
            configAudit.claudeJsonSemantic?.violations ?? [],
          )}`,
        ),
      );
    }
    for (const projectPath of involvedProjectPaths) {
      const before = projectBefores.get(projectPath)!;
      const after = captureRootSnapshot(path.join(projectPath, ".claude"));
      const projectAudit = auditRoot(
        { rootAbs: path.join(projectPath, ".claude"), tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: false },
        before,
        after,
        null,
      );
      if (!auditPassed(projectAudit)) {
        rollbackAndThrow(new Error(`project 트리 감사 위반(${projectPath}): ${JSON.stringify(projectAudit.verdict.violations)}`));
      }
    }

    // ---- 5. 검증(재스캔 실측, AC-2.1/2.6) ----
    try {
      await verifyPluginEnablementMove({
        assetId: options.assetId,
        fromScope,
        toScope,
        fromProjectPathHash: fromProjectPath !== null ? normalizePath(fromProjectPath, home.ctkHome).path_hash : null,
        toProjectPathHash: toProjectPath !== null ? normalizePath(toProjectPath, home.ctkHome).path_hash : null,
        installedPluginsAbsPath,
        installedPluginsShaBefore,
        home,
        machineId,
        cwd: tmpCwd,
        timeoutSec,
      });
    } catch (err) {
      rollbackAndThrow(err);
    }

    // ---- 6. journal ----
    const entry = buildPluginEnablementJournalEntry({
      assetId: options.assetId,
      machineId,
      homeDir: home.ctkHome,
      before: { install_scope: registryScope, enabled_at: fromScope },
      after: { install_scope: registryScope, enabled_at: toScope },
      backupRootAbs: backupRoot,
      result: "success",
    });
    const { path: journalPath } = writeJournalEntry(catalogPath, entry);
    commitAll(catalogPath, `ctk move: ${options.assetId} ${fromScope} -> ${toScope}`);

    return {
      assetId: options.assetId,
      kind: "plugin",
      from: fromProjectPath ? `project:${fromScope}` : fromScope,
      to: toProjectPath ? `project:${toScope}` : toScope,
      journalPath,
    };
  } finally {
    rmSync(tmpCwd, { recursive: true, force: true });
  }
}

async function moveSkillAsset(
  home: HomeContext,
  machineId: string,
  catalogPath: string,
  options: MoveOptions,
): Promise<MoveSummary> {
  assertSafePathSegment(options.assetId, "--asset"); // assetId가 곧 skills/<assetId> 경로 세그먼트가 된다.
  const fromScope: "user" | "project" = options.from ?? "user";
  const toScope: "user" | "project" = options.to;
  const fromProjectPath = fromScope === "project" ? resolveProjectPath(home, options.fromProjectIndex) : null;
  const toProjectPath = toScope === "project" ? resolveProjectPath(home, options.toProjectIndex) : null;
  if (fromScope === toScope && fromProjectPath === toProjectPath) throw new NoOpMoveError();

  const sourceAbs =
    fromScope === "user"
      ? path.join(home.ctkConfigDir, "skills", options.assetId)
      : path.join(fromProjectPath!, ".claude", "skills", options.assetId);
  const destAbs =
    toScope === "user"
      ? path.join(home.ctkConfigDir, "skills", options.assetId)
      : path.join(toProjectPath!, ".claude", "skills", options.assetId);

  const configRoot = home.ctkConfigDir;
  const involvedProjectPaths = [...new Set([fromProjectPath, toProjectPath].filter((p): p is string => p !== null))];

  // ---- 1. before 스냅샷 ----
  const configBefore = captureRootSnapshot(configRoot);
  const projectBefores = new Map(involvedProjectPaths.map((p) => [p, captureRootSnapshot(path.join(p, ".claude"))]));

  // ---- 2. 백업(이동 대상 스킬 디렉터리 자체 + 목적지 자리) ----
  const runId = snapshotIdFsSafe();
  const { backupRoot } = beginBackupRun(home.ctkHome, runId);
  const backupEntries = {
    skill_dir: backupDirectory(backupRoot, "skill_dir", sourceAbs),
    // 목적지는 이동 전에는 존재하지 않는다(existed:false로 기록됨) — `ctk rollback --last`가
    // 나중에(이 함수 호출이 끝난 뒤에도) manifest만으로 "이동이 새로 만든 디렉터리를 지운다"를
    // 재현하려면 목적지 자리도 백업 항목으로 남아있어야 한다. 실패 시 즉시 되돌리는
    // rollbackAndThrow와 달리, 성공 후 `ctk rollback --last`는 이 함수의 지역 변수(destAbs)에
    // 접근할 수 없고 manifest만 본다.
    skill_dir_dest: backupDirectory(backupRoot, "skill_dir_dest", destAbs),
  };
  writeManifest(backupRoot, runId, backupEntries);

  const rollbackAndThrow = (cause: unknown): never => {
    restoreFromBackup(backupRoot);
    throw cause;
  };

  // ---- 3. 적용 ----
  try {
    applyMoveSkillDir(sourceAbs, destAbs);
  } catch (err) {
    rollbackAndThrow(err);
  }

  // ---- 4. 감사 ----
  const skillTier1 = [{ pattern: new RegExp(`^skills/${escapeRegExp(options.assetId)}(/|$)`), note: "Tier-1 대상 스킬" }];
  const configAfter = captureRootSnapshot(configRoot);
  const configAudit = auditRoot({ rootAbs: configRoot, tier1: skillTier1, allowTier2Churn: true }, configBefore, configAfter, readClaudeJsonRawOrNull(configRoot));
  if (!auditPassed(configAudit)) {
    rollbackAndThrow(new Error(`config 트리 감사 위반: ${JSON.stringify(configAudit.verdict.violations)}`));
  }
  for (const projectPath of involvedProjectPaths) {
    const before = projectBefores.get(projectPath)!;
    const after = captureRootSnapshot(path.join(projectPath, ".claude"));
    const projectAudit = auditRoot({ rootAbs: path.join(projectPath, ".claude"), tier1: skillTier1, allowTier2Churn: false }, before, after, null);
    if (!auditPassed(projectAudit)) {
      rollbackAndThrow(new Error(`project 트리 감사 위반(${projectPath}): ${JSON.stringify(projectAudit.verdict.violations)}`));
    }
  }

  // ---- 5. 검증 ----
  try {
    verifySkillDirMove({
      assetId: options.assetId,
      fromLocation: fromScope,
      toLocation: toScope,
      fromProjectPathHash: fromProjectPath !== null ? normalizePath(fromProjectPath, home.ctkHome).path_hash : null,
      toProjectPathHash: toProjectPath !== null ? normalizePath(toProjectPath, home.ctkHome).path_hash : null,
      destAbs,
      home,
      machineId,
    });
  } catch (err) {
    rollbackAndThrow(err);
  }

  // ---- 6. journal ----
  const entry = buildSkillDirJournalEntry({
    assetId: options.assetId,
    machineId,
    homeDir: home.ctkHome,
    before: { location: fromScope, project_path_hash: fromProjectPath !== null ? normalizePath(fromProjectPath, home.ctkHome).path_hash : null },
    after: { location: toScope, project_path_hash: toProjectPath !== null ? normalizePath(toProjectPath, home.ctkHome).path_hash : null },
    backupRootAbs: backupRoot,
    result: "success",
  });
  const { path: journalPath } = writeJournalEntry(catalogPath, entry);
  commitAll(catalogPath, `ctk move: ${options.assetId} (skill) ${fromScope} -> ${toScope}`);

  return {
    assetId: options.assetId,
    kind: "skill",
    from: fromProjectPath ? `project:${fromScope}` : fromScope,
    to: toProjectPath ? `project:${toScope}` : toScope,
    journalPath,
  };
}

export async function runMove(options: MoveOptions): Promise<MoveSummary> {
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;
  const machine = readOrCreateMachineIdentity(home, "local-machine");

  const lock = acquireLock(catalogPath, {
    command: "move",
    origin: "cli",
    started_at: new Date().toISOString(),
    machine_id: machine.machine_id,
  });

  try {
    const kind = readCatalogAssetKind(catalogPath, options.assetId);
    assertMovableAssetKind(kind);
    if (kind === "plugin") return await movePluginAsset(home, machine.machine_id, catalogPath, options);
    return await moveSkillAsset(home, machine.machine_id, catalogPath, options);
  } finally {
    lock.release();
  }
}

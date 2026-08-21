import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertMovableAssetKind,
  auditFailureError,
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
  writeBeforeSnapshot,
  writeManifest,
  pruneBackupRuns,
  type BeforeSnapshotRoot,
} from "@ctk/actuator";
import { claudeJsonPath, findSkillDirsById, listKnownProjectPaths, resolveHomeContext, type HomeContext } from "@ctk/probe";
import {
  FAILURE_CLASSES,
  TIER1_INTENTIONAL_WRITES,
  normalizePath,
  parseInstalledPluginsFile,
  snapshotIdFsSafe,
  type AssetKind,
  type FailureClass,
  type InstalledPluginEntry,
  type InstallScope,
  type JournalResult,
  type RunLogEntry,
} from "@ctk/core";
import { acquireLock, writeJournalEntry, commitAll, writeRunLog } from "@ctk/sync";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { CatalogNotInitializedError } from "./scan.js";

/**
 * cli/src/commands/move.ts — `ctk move` 오케스트레이션. actuator의 building block(backup·apply·
 * audit·verify·rollback·journal)을 배선한다 — 순서는 절대 규칙이다: **백업 → 수정 → 검증(재스캔
 * 실측) → 실패 시 롤백**. journal 레코드는 actuator가 반환만 하고, 카탈로그 저장소 append는
 * 여기서 `@ctk/sync`로 한다(P1-5 — actuator에 카탈로그 쓰기 루트를 두지 않는다).
 *
 * ⚠️ **Step 5 보안 심사 수정(H3)** — 이전에는 검증(AC-2.1/2.2) 통과 후에만 journal을 썼다.
 * 그래서 apply는 됐는데 감사·검증이 실패해 자기-롤백한 시도는 **기록이 전혀 없었다**
 * (`JournalResult`의 `"failure"`/`"rolled_back"`이 스키마에만 있고 코드가 한 번도 안 씀).
 * 결과적으로 `ctk rollback --last`가 실패한 시도를 건너뛰고 그 이전 성공을 되돌려 **두 조치
 * 이전 상태로 덮어쓰는** 사고 경로가 있었다. 지금은 **성공·실패·롤백 3종단 모두** journal 1건
 * + run-log 1건을 남긴다 — `findLastEntry`(cli/rollback.ts)가 항상 최신 시도를 정확히 보게 된다.
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

/** H6 — 스킬 자산 id(frontmatter name)에 대응하는 실제 디렉터리가 0개 또는 2개 이상이라 판정 불가. */
export class SkillLocationAmbiguousError extends Error {
  readonly failureClass = "skill_location_ambiguous" as const;
  constructor(assetId: string, count: number) {
    super(
      count === 0
        ? `스킬 자산 id '${assetId}'에 대응하는 실제 디렉터리를 찾지 못했다 — 카탈로그가 드리프트됐을 수 있다(\`ctk scan\`을 다시 실행하라).`
        : `스킬 자산 id '${assetId}'에 대응하는 실제 디렉터리가 ${count}개다 — 어느 것이 진짜인지 판정할 수 없어 거부한다(추정으로 채우지 않는다).`,
    );
    this.name = "SkillLocationAmbiguousError";
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

/** M8 — "조치 직후 우리가 남긴 sha256"을 계산한다. 대상이 없으면 undefined(검사 생략 대상). */
function sha256FileOrUndefined(absPath: string): string | undefined {
  if (!existsSync(absPath)) return undefined;
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/**
 * L7 재현 — `assetId`는 `--asset` 플래그를 통한 사용자 입력이다. `plugins[assetId]`를
 * `Object.hasOwn` 없이 그대로 색인하면, `assetId`가 문자 그대로 `"__proto__"`일 때 파일 내용과
 * 무관하게 `plugins["__proto__"]`가 그 객체의 프로토타입을 반환한다(일반 객체라면 항상) —
 * 배열이 아니므로 이어지는 `.find()` 호출이 TypeError로 죽는다(재현:
 * `({})["__proto__"]?.find` → "not a function"). `Object.hasOwn`으로 실제 소유 프로퍼티인지
 * 먼저 확인해 프로토타입 체인 접근을 막는다. 같은 id가 여러 스코프로 설치돼 있을 수 있으나
 * (P1-13), 이 액션이 옮기는 enablement의 등록 스코프로 fromScope와 일치하는 첫 엔트리를
 * 채택한다.
 */
export function resolveRegistryScope(
  plugins: Record<string, InstalledPluginEntry[]>,
  assetId: string,
  fromScope: InstallScope,
): InstallScope | null {
  const entries = Object.hasOwn(plugins, assetId) ? plugins[assetId] : undefined;
  return entries?.find((e) => e.scope === fromScope)?.scope ?? entries?.[0]?.scope ?? null;
}

const FAILURE_CLASS_SET = new Set<string>(FAILURE_CLASSES);

/** 던져진 오류가 알려진 `failure_class`를 싣고 있으면 그대로 쓰고, 아니면 "unclassified"로 남긴다. */
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

/**
 * H3 — apply 이후 단계에서 실패하면 self-rollback을 시도하고, **그 결과와 무관하게** journal
 * 레코드를 남긴다(`rolled_back`이면 복원 성공, `failure`면 복원 자체도 실패 — `RollbackFailedError`
 * 원문이 그대로 cause 체인에 남는다. H3: "원래 실패 원인이 소실"되지 않게 한다).
 */
function rollbackAndRecord(options: {
  cause: unknown;
  backupRoot: string;
  manifestSha256: string;
  home: HomeContext;
  catalogPath: string;
  assetId: string;
  buildEntry: (result: JournalResult) => Parameters<typeof writeJournalEntry>[1];
  commitMessage: (result: JournalResult) => string;
  /** M8 — manifest 키 → "조치 직후 우리가 남긴 sha256". restoreFromBackup이 복원 직전 이 값과
   * 실측을 대조해, 백업~롤백 사이 다른 세션이 파일을 바꿨으면 조용히 덮어쓰지 않고 중단한다. */
  expectedCurrentShas?: Readonly<Record<string, string | undefined>>;
}): never {
  let result: JournalResult;
  let rollbackCause: unknown = null;
  try {
    restoreFromBackup(options.backupRoot, options.home, undefined, options.expectedCurrentShas);
    result = "rolled_back";
  } catch (rbErr) {
    result = "failure";
    rollbackCause = rbErr;
  }

  try {
    const entry = options.buildEntry(result);
    writeJournalEntry(options.catalogPath, entry);
    commitAll(options.catalogPath, options.commitMessage(result));
  } catch {
    // journal 기록 자체가 실패해도 원래 오류를 삼키지 않는다(아래에서 그대로 재throw).
  }

  if (rollbackCause !== null) {
    if (rollbackCause instanceof Error && options.cause instanceof Error) {
      rollbackCause.cause = options.cause;
    }
    throw rollbackCause;
  }
  throw options.cause;
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
    // (AC-2.1ⓑ) — journal에는 실측된 실제 값을 담는다(가정하지 않는다). L7 방어는
    // resolveRegistryScope() 안에 있다(아래 정의).
    const registryScope = resolveRegistryScope(installedPluginsBefore.plugins, options.assetId, fromScope);

    // ---- 2. 백업(H4 — .claude.json도 함께 백업하고, before 스냅샷을 함께 저장한다) ----
    const runId = snapshotIdFsSafe();
    const { backupRoot } = beginBackupRun(home.ctkHome, runId);
    const fromSettingsAbs =
      fromScope === "user" ? path.join(configRoot, "settings.json") : path.join(fromProjectPath!, ".claude", "settings.json");
    const toSettingsAbs =
      toScope === "user" ? path.join(configRoot, "settings.json") : path.join(toProjectPath!, ".claude", "settings.json");
    const backupEntries: Record<string, ReturnType<typeof backupFile>> = {
      from_settings: backupFile(backupRoot, "from_settings", fromSettingsAbs),
      // H4 — `claude plugin disable/enable`이 실제로 건드리는 config_claude_json도 백업 대상에
      // 포함한다(AC-0.8 실측 — 읽기 명령만으로도 갱신된다. 롤백이 이걸 복원 못 하면 AC-2.3/2.5가
      // 구조적으로 성립하지 않는다).
      config_claude_json: backupFile(backupRoot, "config_claude_json", claudeJsonPath(home)),
    };
    if (toSettingsAbs !== fromSettingsAbs) {
      backupEntries.to_settings = backupFile(backupRoot, "to_settings", toSettingsAbs);
    }
    const { manifestSha256 } = writeManifest(backupRoot, runId, backupEntries);
    const beforeRoots: BeforeSnapshotRoot[] = [
      { rootAbs: configRoot, entries: configBefore.entries },
      ...involvedProjectPaths.map((p) => ({ rootAbs: path.join(p, ".claude"), entries: projectBefores.get(p)!.entries })),
    ];
    writeBeforeSnapshot(backupRoot, { roots: beforeRoots });

    const buildFailureEntry = (result: JournalResult) =>
      buildPluginEnablementJournalEntry({
        assetId: options.assetId,
        machineId,
        homeDir: home.ctkHome,
        before: { install_scope: registryScope, enabled_at: fromScope },
        after: { install_scope: registryScope, enabled_at: result === "rolled_back" ? fromScope : toScope },
        backupRootAbs: backupRoot,
        manifestSha256,
        result,
      });
    // M8 — "조치 직후 우리가 남긴 값". apply(3단계) 성공 직후에만 채워진다 — 그 전에
    // rollbackAndThrow가 호출되면(apply 자체 실패) 아직 우리가 무엇을 썼는지 확정할 수 없으므로
    // undefined로 두고 검사를 생략한다. 박스(객체) 자체는 const로 두고 `.value`만 나중에 채운다 —
    // rollbackAndThrow 클로저가 항상 호출 시점의 최신 값을 읽어야 하므로 `let` 재할당 대신
    // 프로퍼티 갱신을 쓴다.
    const expectedCurrentShasBox: { value: Record<string, string | undefined> | undefined } = { value: undefined };
    const rollbackAndThrow = (cause: unknown): never =>
      rollbackAndRecord({
        cause,
        backupRoot,
        manifestSha256,
        home,
        catalogPath,
        assetId: options.assetId,
        buildEntry: buildFailureEntry,
        commitMessage: (result) => `ctk move (${result}): ${options.assetId} ${fromScope} -> ${toScope}`,
        expectedCurrentShas: expectedCurrentShasBox.value,
      });

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
    expectedCurrentShasBox.value = {
      from_settings: sha256FileOrUndefined(fromSettingsAbs),
      config_claude_json: sha256FileOrUndefined(claudeJsonPath(home)),
      ...(toSettingsAbs !== fromSettingsAbs ? { to_settings: sha256FileOrUndefined(toSettingsAbs) } : {}),
    };

    // ---- 4. 감사(AC-2.7) ----
    // M2/M5 — auditRoot는 .claude.json이 손상돼 있으면(파싱 실패) 이제 throw한다(조용히 {}로
    // 뭉개 감사를 통과시키지 않는다). 그 throw도 감사 위반과 동일하게 self-rollback을 트리거해야
    // 하므로 이 블록 전체를 try/catch로 감싼다. 감사 위반 자체도 M5 수정으로 평문 Error가 아니라
    // ForbiddenPathWriteError/WhitelistViolationError를 던진다(failure_class가 실제로 채워진다).
    try {
      // M10 — before의 캐시를 넘겨 안 바뀐 파일은 재해시를 건너뛴다.
      const configAfter = captureRootSnapshot(configRoot, configBefore.cache);
      const configAudit = auditRoot(
        { rootAbs: configRoot, tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: true },
        configBefore,
        configAfter,
        claudeJsonBeforeRaw,
      );
      if (!auditPassed(configAudit)) {
        throw auditFailureError(configAudit, "config 트리 감사 위반");
      }
      for (const projectPath of involvedProjectPaths) {
        const before = projectBefores.get(projectPath)!;
        const after = captureRootSnapshot(path.join(projectPath, ".claude"), before.cache);
        const projectAudit = auditRoot(
          { rootAbs: path.join(projectPath, ".claude"), tier1: TIER1_INTENTIONAL_WRITES, allowTier2Churn: false },
          before,
          after,
          null,
        );
        if (!auditPassed(projectAudit)) {
          throw auditFailureError(projectAudit, `project 트리 감사 위반(${projectPath})`);
        }
      }
    } catch (err) {
      rollbackAndThrow(err);
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

    // ---- 6. journal(성공) ----
    const entry = buildPluginEnablementJournalEntry({
      assetId: options.assetId,
      machineId,
      homeDir: home.ctkHome,
      before: { install_scope: registryScope, enabled_at: fromScope },
      after: { install_scope: registryScope, enabled_at: toScope },
      backupRootAbs: backupRoot,
      manifestSha256,
      result: "success",
    });
    const { path: journalPath } = writeJournalEntry(catalogPath, entry);
    commitAll(catalogPath, `ctk move: ${options.assetId} ${fromScope} -> ${toScope}`);
    // 조치가 성공적으로 기록된 뒤에만 오래된 백업을 정리한다 — 중단된 복원이 있는 런과
    // 최근 keep개는 보호되므로 `ctk rollback --last`의 대상은 남는다(M1 후속).
    pruneBackupRuns(path.join(home.ctkHome, ".ctk-backups"));

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
  const fromScope: "user" | "project" = options.from ?? "user";
  const toScope: "user" | "project" = options.to;
  const fromProjectPath = fromScope === "project" ? resolveProjectPath(home, options.fromProjectIndex) : null;
  const toProjectPath = toScope === "project" ? resolveProjectPath(home, options.toProjectIndex) : null;
  if (fromScope === toScope && fromProjectPath === toProjectPath) throw new NoOpMoveError();

  // H6 — assetId(frontmatter name)로 경로를 지어내지 않는다. probe로 실제 디렉터리를 되찾고,
  // 정확히 스코프가 일치하는 항목이 하나여야만 진행한다(0건/2건 이상은 판정 불가로 거부).
  const matches = findSkillDirsById(home, options.assetId).filter(
    (d) => d.scope === fromScope && (fromScope === "user" ? d.projectPath === null : d.projectPath === fromProjectPath),
  );
  if (matches.length !== 1) {
    throw new SkillLocationAmbiguousError(options.assetId, matches.length);
  }
  const sourceMatch = matches[0]!;
  const sourceAbs = sourceMatch.absPath;
  const dirName = sourceMatch.dirName;
  const destAbs =
    toScope === "user" ? path.join(home.ctkConfigDir, "skills", dirName) : path.join(toProjectPath!, ".claude", "skills", dirName);

  const configRoot = home.ctkConfigDir;
  const involvedProjectPaths = [...new Set([fromProjectPath, toProjectPath].filter((p): p is string => p !== null))];

  // ---- 1. before 스냅샷 ----
  const configBefore = captureRootSnapshot(configRoot);
  const projectBefores = new Map(involvedProjectPaths.map((p) => [p, captureRootSnapshot(path.join(p, ".claude"))]));

  // ---- 2. 백업(이동 대상 스킬 디렉터리 자체 + 목적지 자리, H4: before 스냅샷도 저장) ----
  const runId = snapshotIdFsSafe();
  const { backupRoot } = beginBackupRun(home.ctkHome, runId);
  const backupEntries = {
    skill_dir: backupDirectory(backupRoot, "skill_dir", sourceAbs),
    // 목적지는 이동 전에는 존재하지 않는다(existed:false로 기록됨) — `ctk rollback --last`가
    // 나중에(이 함수 호출이 끝난 뒤에도) manifest만으로 "이동이 새로 만든 디렉터리를 지운다"를
    // 재현하려면 목적지 자리도 백업 항목으로 남아있어야 한다.
    skill_dir_dest: backupDirectory(backupRoot, "skill_dir_dest", destAbs),
  };
  const { manifestSha256 } = writeManifest(backupRoot, runId, backupEntries);
  const beforeRoots: BeforeSnapshotRoot[] = [
    { rootAbs: configRoot, entries: configBefore.entries },
    ...involvedProjectPaths.map((p) => ({ rootAbs: path.join(p, ".claude"), entries: projectBefores.get(p)!.entries })),
  ];
  writeBeforeSnapshot(backupRoot, { roots: beforeRoots });

  const buildFailureEntry = (result: JournalResult) =>
    buildSkillDirJournalEntry({
      assetId: options.assetId,
      machineId,
      homeDir: home.ctkHome,
      before: { location: fromScope, project_path_hash: fromProjectPath !== null ? normalizePath(fromProjectPath, home.ctkHome).path_hash : null },
      after: {
        location: result === "rolled_back" ? fromScope : toScope,
        project_path_hash:
          (result === "rolled_back" ? fromProjectPath : toProjectPath) !== null
            ? normalizePath((result === "rolled_back" ? fromProjectPath : toProjectPath)!, home.ctkHome).path_hash
            : null,
      },
      backupRootAbs: backupRoot,
      manifestSha256,
      result,
    });
  const rollbackAndThrow = (cause: unknown): never =>
    rollbackAndRecord({
      cause,
      backupRoot,
      manifestSha256,
      home,
      catalogPath,
      assetId: options.assetId,
      buildEntry: buildFailureEntry,
      commitMessage: (result) => `ctk move (${result}): ${options.assetId} (skill) ${fromScope} -> ${toScope}`,
    });

  // ---- 3. 적용 ----
  try {
    applyMoveSkillDir(sourceAbs, destAbs);
  } catch (err) {
    rollbackAndThrow(err);
  }

  // ---- 4. 감사 ----
  // M2/M5 — auditRoot 호출 자체가 던질 수 있으므로(손상된 .claude.json) 이 블록도 try/catch로
  // 감싸 self-rollback을 트리거한다. 감사 위반은 타입 오류(auditFailureError)로 던진다.
  const skillTier1 = [{ pattern: new RegExp(`^skills/${escapeRegExp(dirName)}(/|$)`), note: "Tier-1 대상 스킬" }];
  try {
    // M10 — before의 캐시를 넘겨 안 바뀐 파일은 재해시를 건너뛴다.
    const configAfter = captureRootSnapshot(configRoot, configBefore.cache);
    const configAudit = auditRoot({ rootAbs: configRoot, tier1: skillTier1, allowTier2Churn: true }, configBefore, configAfter, readClaudeJsonRawOrNull(configRoot));
    if (!auditPassed(configAudit)) {
      throw auditFailureError(configAudit, "config 트리 감사 위반");
    }
    for (const projectPath of involvedProjectPaths) {
      const before = projectBefores.get(projectPath)!;
      const after = captureRootSnapshot(path.join(projectPath, ".claude"), before.cache);
      const projectAudit = auditRoot({ rootAbs: path.join(projectPath, ".claude"), tier1: skillTier1, allowTier2Churn: false }, before, after, null);
      if (!auditPassed(projectAudit)) {
        throw auditFailureError(projectAudit, `project 트리 감사 위반(${projectPath})`);
      }
    }
  } catch (err) {
    rollbackAndThrow(err);
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

  // ---- 6. journal(성공) ----
  const entry = buildSkillDirJournalEntry({
    assetId: options.assetId,
    machineId,
    homeDir: home.ctkHome,
    before: { location: fromScope, project_path_hash: fromProjectPath !== null ? normalizePath(fromProjectPath, home.ctkHome).path_hash : null },
    after: { location: toScope, project_path_hash: toProjectPath !== null ? normalizePath(toProjectPath, home.ctkHome).path_hash : null },
    backupRootAbs: backupRoot,
    manifestSha256,
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
  const startedAt = new Date();
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;
  const machine = readOrCreateMachineIdentity(home, "local-machine");

  const lock = acquireLock(catalogPath, {
    command: "move",
    origin: "cli",
    started_at: startedAt.toISOString(),
    machine_id: machine.machine_id,
  });

  try {
    const kind = readCatalogAssetKind(catalogPath, options.assetId);
    assertMovableAssetKind(kind);
    const summary = kind === "plugin" ? await movePluginAsset(home, machine.machine_id, catalogPath, options) : await moveSkillAsset(home, machine.machine_id, catalogPath, options);

    writeRunLogSafely(catalogPath, {
      schema_version: 1,
      _scope: "machine_dependent",
      command: "move",
      args: { asset_id: options.assetId, to: options.to },
      machine_id: machine.machine_id,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      exit_code: 0,
      failure_class: null,
    });
    return summary;
  } catch (err) {
    // H3 — 실패(자기-롤백 성공/실패 포함)도 run-log를 남긴다(AC-5.1). journal은 각 단계에서
    // `rollbackAndRecord`가 이미 남겼다 — 여기서는 §7 관측 가능성의 마지막 관문(run-log)만 채운다.
    writeRunLogSafely(catalogPath, {
      schema_version: 1,
      _scope: "machine_dependent",
      command: "move",
      args: { asset_id: options.assetId, to: options.to },
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

/** run-log 기록 자체의 실패가 원본 오류를 삼키지 않도록 격리한다(H3). */
function writeRunLogSafely(catalogPath: string, entry: RunLogEntry): void {
  try {
    writeRunLog(catalogPath, entry);
  } catch {
    // best-effort — 원본 성공/실패 결과에 영향을 주지 않는다.
  }
}

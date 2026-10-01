import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizePath,
  parseInstalledPluginsFile,
  parseKnownMarketplacesFile,
  parsePluginDetails,
  parsePluginList,
  parseSettingsFile,
  toRepoLink,
  type Asset,
  type Installation,
  type PluginDetails,
  type RepoLink,
} from "@ctk/core";
import type { HomeContext } from "../home.js";
import { spawnClaude, type SpawnClaudeResult } from "../harness/spawn-claude.js";
import { CommandFailedError, ParseSchemaMismatchError } from "./errors.js";
import { listKnownProjectPaths } from "./known-projects.js";
import { validateInstallPath, type ValidatedInstallPath } from "./install-path.js";

/**
 * probe/src/sources/plugins.ts — plan §4.1 Step 2.
 *
 * `claude plugin list --json`(파싱 → id 기준 고유 집계, `id`=`name@marketplace`)를 **자산 정체성의
 * 1차 소스**로 쓴다. `install_scope`는 `<config>/plugins/installed_plugins.json` 직독으로,
 * `enabled_at`은 `<config>/settings.json`류 직독으로 **따로** 채운다(P0-3 — 두 필드를 같은 호출
 * 결과에서 섞지 않는다. AC-1.1의 "독립 대조 필드 vs 항등 필드" 구분이 여기서 갈린다).
 *
 * ⚠️ 문서화된 단순화(Step 2 범위 내 판단, 근거 불충분 항목): `install_scope: "local"`인 설치의
 * `enabled_at`도 `"project"`와 동일하게 `<projectPath>/.claude/settings.json`을 조회해 채운다.
 * AC-1.1의 직독 경로 8종 목록에 `<project>/.claude/settings.local.json`이 없어(project-local
 * 개인 오버라이드 파일의 존재를 이 목록이 다루지 않는다), "local" 스코프 전용 오버라이드 파일을
 * 가정할 근거가 없다 — 실측(Step 0)이 이 구분을 다루지 않았다.
 */

export interface PluginSourceResult {
  assets: Asset[];
  installations: Installation[];
}

function readJsonOrNull(absPath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  return JSON.parse(raw) as unknown;
}

function readEnabledPlugins(settingsAbsPath: string): Record<string, boolean> {
  const raw = readJsonOrNull(settingsAbsPath);
  if (raw === null) return {};
  const parsed = parseSettingsFile(raw);
  return parsed.enabledPlugins ?? {};
}

export interface CollectPluginsOptions {
  home: HomeContext;
  machineId: string;
  cwd: string;
  timeoutSec: number;
  /** 테스트 주입용 — 기본값은 실제 `spawnClaude`(spawn-claude.ts). 실제 `claude` 바이너리 없이
   * 유닛 테스트를 돌리기 위해 교체 가능하게 열어둔다(다른 소스 모듈은 파일 직독뿐이라 필요 없다). */
  spawnFn?: typeof spawnClaude;
}

export async function collectPlugins(options: CollectPluginsOptions): Promise<PluginSourceResult> {
  const { home, machineId, cwd, timeoutSec, spawnFn = spawnClaude } = options;

  const spawnResult: SpawnClaudeResult = await spawnFn({
    profile: "test-isolated",
    subcommand: ["plugin", "list", "--json"],
    home,
    cwd,
    timeoutSec,
  });

  if (spawnResult.exitCode !== 0) {
    // 빈 stdout을 "플러그인 0개"로 조용히 해석하지 않는다(실측으로 발견된 회귀 — errors.ts 참조).
    throw new CommandFailedError("claude plugin list --json", spawnResult.exitCode, spawnResult.stderr);
  }

  let listRaw: unknown;
  try {
    listRaw = spawnResult.stdout.trim().length > 0 ? JSON.parse(spawnResult.stdout) : [];
  } catch (cause) {
    throw new ParseSchemaMismatchError("claude plugin list --json (invalid JSON)", cause);
  }
  let entries;
  try {
    entries = parsePluginList(listRaw);
  } catch (cause) {
    throw new ParseSchemaMismatchError("claude plugin list --json (zod strict)", cause);
  }

  // 요구사항 6 — 저장소 링크의 유일한 출처. 파일이 없거나 파싱에 실패하면 링크를 비워 둘 뿐
  // 스캔을 실패시키지 않는다(링크는 부가 정보다). 다만 **비운 것과 "로컬 출처라 URL이 없는 것"은
  // 다르므로**, 후자는 `repo_source: "directory"`로 남긴다.
  const marketplacesAbsPath = path.join(home.ctkConfigDir, "plugins", "known_marketplaces.json");
  const marketplacesRaw = readJsonOrNull(marketplacesAbsPath);
  let repoLinkByMarketplace = new Map<string, RepoLink>();
  if (marketplacesRaw !== null) {
    const parsed = parseKnownMarketplacesFile(marketplacesRaw);
    repoLinkByMarketplace = new Map(Object.entries(parsed).map(([name, entry]) => [name, toRepoLink(entry.source)]));
  }

  // 자산 정체성 — id 기준 고유 집계(P1-13, AC-0.3 실측: local 스코프 "중복"은 프로젝트별 설치일 뿐
  // 자산은 하나다). 첫 등장 엔트리의 값을 대표값으로 쓴다.
  const assetById = new Map<string, Asset>();
  const knownAssetIds = new Set<string>();
  for (const entry of entries) {
    knownAssetIds.add(entry.id);
    if (assetById.has(entry.id)) continue;
    const atIndex = entry.id.indexOf("@");
    const name = entry.id.slice(0, atIndex);
    const marketplace = entry.id.slice(atIndex + 1);
    const normalizedInstallPath = normalizePath(entry.installPath, home.ctkHome);
    const repoLink = repoLinkByMarketplace.get(marketplace);
    assetById.set(entry.id, {
      schema_version: 1,
      _scope: "machine_independent",
      id: entry.id,
      kind: "plugin",
      name,
      marketplace,
      source_ref: normalizedInstallPath.home_relative ?? `path_hash:${normalizedInstallPath.path_hash}`,
      // 두 필드를 함께 넣거나 함께 뺀다 — repo_source만 있고 url이 없는 상태가 "로컬 출처"의 표현이다.
      ...(repoLink === undefined ? {} : { repo_source: repoLink.kind }),
      ...(repoLink?.url == null ? {} : { repo_url: repoLink.url }),
    });
  }

  // install_scope + project_path_hash — installed_plugins.json 직독(1차 소스와 분리, AC-1.1).
  const installedPluginsAbsPath = path.join(home.ctkConfigDir, "plugins", "installed_plugins.json");
  const installedPluginsRaw = readJsonOrNull(installedPluginsAbsPath);
  const installedPlugins = installedPluginsRaw === null ? { plugins: {} } : parseInstalledPluginsFile(installedPluginsRaw);

  interface InstallDimension {
    assetId: string;
    installScope: "user" | "project" | "local";
    projectPath: string | null;
  }
  const dimensions: InstallDimension[] = [];
  for (const [id, pluginEntries] of Object.entries(installedPlugins.plugins)) {
    if (!knownAssetIds.has(id)) continue; // plugin-list 출력과의 정체성 불일치는 방어적으로 건너뛴다.
    for (const entry of pluginEntries) {
      dimensions.push({ assetId: id, installScope: entry.scope, projectPath: entry.projectPath ?? null });
    }
  }

  // enabled_at — settings.json류 직독. user 스코프는 <config>/settings.json + settings.local.json,
  // project/local 스코프는 <projectPath>/.claude/settings.json.
  const userEnabled = {
    ...readEnabledPlugins(path.join(home.ctkConfigDir, "settings.json")),
    ...readEnabledPlugins(path.join(home.ctkConfigDir, "settings.local.json")),
  };

  const projectEnabledCache = new Map<string, Record<string, boolean>>();
  function projectEnabledPlugins(projectPath: string): Record<string, boolean> {
    const cached = projectEnabledCache.get(projectPath);
    if (cached) return cached;
    const result = readEnabledPlugins(path.join(projectPath, ".claude", "settings.json"));
    projectEnabledCache.set(projectPath, result);
    return result;
  }

  const installations: Installation[] = dimensions.map((dim) => {
    let enabledAt: Installation["enabled_at"] = null;
    let projectPathHash: string | null = null;
    if (dim.installScope === "user") {
      enabledAt = userEnabled[dim.assetId] === true ? "user" : null;
    } else if (dim.projectPath !== null) {
      projectPathHash = normalizePath(dim.projectPath, home.ctkHome).path_hash;
      const enabled = projectEnabledPlugins(dim.projectPath);
      enabledAt = enabled[dim.assetId] === true ? dim.installScope : null;
    }
    return {
      schema_version: 1,
      _scope: "machine_dependent",
      asset_id: dim.assetId,
      machine_id: machineId,
      install_scope: dim.installScope,
      enabled_at: enabledAt,
      project_path_hash: projectPathHash,
      mcp_enabled_state: null,
      mcp_state_source: null,
    };
  });

  // ⚠️ Step 5 실측 수정(회귀 방지) — `claude plugin enable <id> -s project`는 "user" 스코프로
  // 설치된 플러그인도 특정 프로젝트에서 독립적으로 켤 수 있다(installed_plugins.json은 건드리지
  // 않는다 — 결정 6C의 "install scope 무변경" 보장, AC-0.8/AC-2.1ⓒ가 실측으로 확인). 위
  // `dimensions` 루프는 installed_plugins.json의 스코프 엔트리만 순회하므로 이 케이스를 아예
  // 놓친다 — user 스코프 설치가 project에서 켜져도 `enabled_at`이 계속 null로 보이고,
  // actuator의 `move`(user→project 전이)를 재스캔으로 검증할 방법이 없었다(AC-2.1 차단).
  // installed_plugins.json에 "project별 user-scope 활성" 레지스트리가 따로 없으므로(위 실측),
  // 알려진 프로젝트 전체를 순회해 이 케이스를 찾는 것 외에 다른 권위 출처가 없다.
  // "project"/"local" 스코프는 같은 파일(<project>/.claude/settings.json)을 쓰므로(위 "문서화된
  // 단순화" 주석과 동일 근거) 이 신규 레코드의 enabled_at은 "project"로 통일한다.
  const userScopeAssetIds = new Set(dimensions.filter((d) => d.installScope === "user").map((d) => d.assetId));
  if (userScopeAssetIds.size > 0) {
    for (const projectPath of listKnownProjectPaths(home)) {
      const enabled = projectEnabledPlugins(projectPath);
      for (const assetId of userScopeAssetIds) {
        if (enabled[assetId] !== true) continue;
        installations.push({
          schema_version: 1,
          _scope: "machine_dependent",
          asset_id: assetId,
          machine_id: machineId,
          install_scope: "user",
          enabled_at: "project",
          project_path_hash: normalizePath(projectPath, home.ctkHome).path_hash,
          mcp_enabled_state: null,
          mcp_state_source: null,
        });
      }
    }
  }

  // synced(claude.ai 계정 동기화, CLI 2.1.284 실측) — installed_plugins.json에 **없다.** 스코프의
  // 유일한 출처가 plugin-list 자신이므로 여기서만 plugin-list의 scope를 쓴다. 활성 여부는 다른
  // 플러그인과 같이 user settings.json 직독이되 **기본값이 켜짐이다** — 끈 것만 `false`로 기록되고
  // 켜진 것은 키가 없었다(실측 3/3, plugin-list의 `enabled`와 일치). `=== true`로 읽으면 전부 꺼짐으로 보인다.
  for (const entry of entries) {
    if (entry.scope !== "synced") continue;
    installations.push({
      schema_version: 1,
      _scope: "machine_dependent",
      asset_id: entry.id,
      machine_id: machineId,
      install_scope: "synced",
      enabled_at: userEnabled[entry.id] === false ? null : "user",
      project_path_hash: null,
      mcp_enabled_state: null,
      mcp_state_source: null,
    });
  }

  // 문서화된 단순화(Step 2 범위) — installed_plugins.json에 프로젝트별 설치 기록이 없는데
  // project-committed settings.json만으로 활성화된 케이스는 다루지 않는다. install_scope의
  // 유일한 권위 출처는 installed_plugins.json이라는 §4.1 Step 2 spec 문구를 그대로 따른다.
  return { assets: [...assetById.values()], installations };
}

/**
 * Step 4(`gen`) 전용 — 플러그인 자산의 실제 설치 경로를 되찾는다. `installed_plugins.json`
 * 의 `installPath`가 유일한 권위 출처다(P0-3과 동일 논리 — `plugin list --json`의 정규화된
 * `source_ref`는 이미 홈 상대화·해시화됐으므로 실제 파일을 읽을 절대경로로 되돌릴 수 없다).
 * 같은 id가 여러 스코프(project별 local 등)에 설치돼 있으면 첫 항목을 대표값으로 쓴다 —
 * `gen`은 원문 텍스트를 읽는 용도일 뿐 어느 설치를 "정답"으로 볼지가 카탈로그 정합성에 영향을
 * 주지 않는다(플러그인 코드 자체는 스코프와 무관하게 동일하다).
 *
 * ⚠️ **`string | null`이 아니라 `ValidatedInstallPath`다**(보안 심사 M-B, 2026-08-28).
 * 두 가지가 함께 틀려 있었다:
 *
 * ① **검증이 없었다.** 이 함수의 반환값은 `gen/source-resolve.ts`의 `pluginSource`에서 곧바로
 *    `readAssetSourceFileSafely`의 루트가 된다. 번들 축은 같은 파일의 같은 필드에 3중 방어를
 *    거는데 플러그인 축만 맨몸이었다 — `installed_plugins.json`이 오염되면 `gen`이 임의 경로의
 *    README를 읽어 카탈로그 문서에 넣고 `sync` 저장소로 내보낸다. 이제 `validateInstallPath`
 *    (절대성·존재·realpath 경계)를 지난다.
 * ② **`null`이 두 축을 뭉갰다.** 예전에는 "이 플러그인이 목록에 없다"와 "경로가 안전하지 않다"가
 *    똑같이 `null`이었고, 호출자는 둘 다 `source_missing`(= 드리프트 조사하라)으로 표시했다.
 *    **거부를 "원본 없음"으로 말하면 사용자는 보안 사건을 드리프트로 조사한다**(안전 원칙 7).
 *    이제 `state`가 `install_path_missing`과 `install_path_rejected`를 갈라 준다.
 */
export function findPluginInstallPath(home: HomeContext, assetId: string): ValidatedInstallPath {
  // 피해 반경을 좁힌다(보안 심사 M3) — synced manifest가 망가져도 일반 플러그인의 gen은 멈추지 않는다.
  const synced = assetId.endsWith(SYNCED_ID_SUFFIX) ? readSyncedOrFailure(home) : new Map<string, PluginInstallPathEntry>();
  const registry = readRegistryInstallPaths(home);
  if (registry === null && !assetId.endsWith(SYNCED_ID_SUFFIX)) {
    return { ok: false, state: "install_path_missing", reason: "installed_plugins.json을 읽지 못했다" };
  }
  if (!(synced instanceof Map)) return validatePluginInstallPathEntry(home, assetId, synced);
  return validatePluginInstallPathEntry(home, assetId, pluginInstallPathEntry(registry ?? new Map(), synced, assetId));
}

const SYNCED_ID_SUFFIX = "@synced";

/** 설치 경로 후보 — 조립 단계에서 이미 거부된 것은 경로가 아니라 사유를 싣는다("없음"과 "거부"를 가른다). */
export type PluginInstallPathEntry = { path: string } | { rejected: string } | { missing: string };

/** 번들 수집이 쓰는 조회 — synced 쪽을 못 읽었을 때 그 실패를 `@synced` id에만 싣기 위해 Map 대신 쓴다. */
export interface PluginInstallPathIndex {
  get(assetId: string): PluginInstallPathEntry | undefined;
}

/** synced 읽기 실패를 **synced id에만** 남긴다(보안 심사 M3) — 사유에 경로·계정 이름을 싣지 않는다. */
function syncedReadFailure(err: unknown): PluginInstallPathEntry {
  const kind = err instanceof ParseSchemaMismatchError ? "형태가 예상과 다르다" : `읽지 못했다(${(err as NodeJS.ErrnoException).code ?? "unknown"})`;
  return { missing: `synced manifest를 ${kind} — synced 플러그인만 판정 불가` };
}

function readSyncedOrFailure(home: HomeContext): Map<string, PluginInstallPathEntry> | PluginInstallPathEntry {
  try {
    return readSyncedPluginInstallPaths(home);
  } catch (err) {
    return syncedReadFailure(err);
  }
}

function readRegistryInstallPaths(home: HomeContext): Map<string, PluginInstallPathEntry> | null {
  const raw = readJsonOrNull(path.join(home.ctkConfigDir, "plugins", "installed_plugins.json"));
  if (raw === null) return null;
  const result = new Map<string, PluginInstallPathEntry>();
  for (const [id, entries] of Object.entries(parseInstalledPluginsFile(raw).plugins)) {
    const first = entries[0];
    if (first !== undefined) result.set(id, { path: first.installPath });
  }
  return result;
}

/**
 * **우선순위 규칙은 여기 한 곳이다**(보안 심사 M1) — `@synced` id는 synced manifest에서만, 나머지는
 * 레지스트리에서만 찾는다. 같은 `x@synced`가 레지스트리에도 있으면(마켓플레이스 이름이 `synced`)
 * 어느 쪽도 고르지 않고 거부한다.
 */
function pluginInstallPathEntry(
  registry: ReadonlyMap<string, PluginInstallPathEntry>,
  synced: ReadonlyMap<string, PluginInstallPathEntry>,
  assetId: string,
): PluginInstallPathEntry | undefined {
  if (!assetId.endsWith(SYNCED_ID_SUFFIX)) return registry.get(assetId);
  if (registry.has(assetId)) return { rejected: "같은 id가 installed_plugins.json과 synced manifest 양쪽에 있다 — 어느 쪽인지 판정할 수 없다" };
  return synced.get(assetId);
}

/** 설치 경로 판정의 단일 관문 — 번들 수집과 gen이 모두 지난다. 경로는 반드시 `validateInstallPath`를 거친다. */
export function validatePluginInstallPathEntry(home: HomeContext, assetId: string, entry: PluginInstallPathEntry | undefined): ValidatedInstallPath {
  if (entry === undefined) {
    return assetId.endsWith(SYNCED_ID_SUFFIX)
      ? { ok: false, state: "install_path_missing", reason: "synced manifest에 이 플러그인이 없다" }
      : validateInstallPath(home, undefined);
  }
  if ("missing" in entry) return { ok: false, state: "install_path_missing", reason: entry.missing };
  if ("rejected" in entry) {
    return { ok: false, state: "install_path_rejected", reason: entry.rejected, rejectedPath: "(synced manifest)" };
  }
  const validated = validateInstallPath(home, entry.path);
  // synced 경로의 사유에는 계정 디렉터리 이름이 섞인다(재심 신규) — scan 경고·웹 응답으로 나가므로 고정 문구로 바꾼다.
  if (validated.ok || !assetId.endsWith(SYNCED_ID_SUFFIX)) return validated;
  return validated.state === "install_path_missing"
    ? { ok: false, state: "install_path_missing", reason: "synced 플러그인 디렉터리가 디스크에 없다" }
    : { ...validated, reason: "synced 플러그인 디렉터리가 <config>/plugins 경계 검증을 통과하지 못했다" };
}

/** manifest의 `name`이 경로 세그먼트 하나로만 쓰이게 한다 — `/`·`..`·선행 점을 막는다. */
const SAFE_SYNCED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * ROADMAP D5 — synced(claude.ai 계정 동기화) 플러그인의 설치 경로. `installed_plugins.json`에 없고
 * `plugin list`의 `installPath`는 플러그인이 아니라 **계정 디렉터리**다. 실측(CLI 2.1.284, 3/3):
 * `<config>/plugins/synced/<계정>/<name>~g<generation>/`, 목록은 같은 계정의 `manifest.json`
 * `plugins[]{name, generation}`. 조립을 금지하는 번들 축의 원칙(`bundled.ts`)에서 벗어나는 유일한
 * 자리라 **출처를 manifest로 한정한다.** 이름·세대가 어긋나거나 id가 중복되면 고르지 않고 거부로
 * 싣는다(보안 심사 M2·L2). manifest 형태가 틀리면 레지스트리처럼 던진다. 디렉터리가 없으면 0건.
 */
export function readSyncedPluginInstallPaths(home: HomeContext): Map<string, PluginInstallPathEntry> {
  const syncedRoot = path.join(home.ctkConfigDir, "plugins", "synced");
  let accounts: string[];
  try {
    accounts = readdirSync(syncedRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const result = new Map<string, PluginInstallPathEntry>();
  for (const account of accounts) {
    const manifestAbs = path.join(syncedRoot, account, "manifest.json");
    let manifestRaw: string;
    try {
      manifestRaw = readFileSync(manifestAbs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // 매니페스트 없는 계정 디렉터리 — 0건
      throw err; // 권한 등은 "없음"이 아니다(재심 L2)
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch {
      throw new ParseSchemaMismatchError("synced manifest.json (invalid JSON)", "계정 디렉터리 하나의 manifest를 파싱하지 못했다");
    }
    const plugins = typeof manifest === "object" ? (manifest as { plugins?: unknown }).plugins : undefined;
    if (!Array.isArray(plugins)) throw new ParseSchemaMismatchError("synced manifest.json (plugins[] 아님)", "계정 디렉터리 하나의 manifest 형태가 다르다");
    for (const entry of plugins as { name?: unknown; generation?: unknown }[]) {
      const { name, generation } = entry ?? {};
      if (typeof name !== "string") throw new ParseSchemaMismatchError("synced manifest.json (plugins[].name 아님)", "계정 디렉터리 하나의 manifest 형태가 다르다");
      const id = `${name}${SYNCED_ID_SUFFIX}`;
      let candidate: PluginInstallPathEntry;
      if (!SAFE_SYNCED_NAME.test(name)) candidate = { rejected: "synced manifest의 이름이 안전한 경로 세그먼트가 아니다" };
      else if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) candidate = { rejected: "synced manifest의 generation이 음이 아닌 정수가 아니다" };
      else candidate = { path: path.join(syncedRoot, account, `${name}~g${generation}`) };
      result.set(id, result.has(id) ? { rejected: "synced manifest에 같은 이름이 둘 이상 있다 — 어느 쪽인지 판정할 수 없다" } : candidate);
    }
  }
  return result;
}

/**
 * B1 Step 5(`probe/src/sources/bundled.ts`) 전용 — `findPluginInstallPath`는 자산 하나당
 * `installed_plugins.json`을 다시 읽는다(Step 4 시점엔 호출부가 최대 1건이라 문제가 없었다).
 * 번들 하위 툴 수집은 활성 플러그인 전수를 순회하므로 파일을 한 번만 읽어 맵으로 돌려준다.
 * 같은 id가 여러 스코프에 설치돼 있으면 첫 항목을 대표값으로 쓴다(`findPluginInstallPath`와
 * 동일 정책 — 어느 설치를 "정답"으로 볼지가 번들 내용에 영향을 주지 않는다).
 */
export function listPluginInstallPaths(home: HomeContext): PluginInstallPathIndex {
  const registry = readRegistryInstallPaths(home) ?? new Map<string, PluginInstallPathEntry>();
  // synced를 못 읽어도 레지스트리 플러그인의 편입은 계속된다(재심 M3 잔여) — 실패는 @synced id에만 실린다.
  const synced = readSyncedOrFailure(home);
  if (!(synced instanceof Map)) {
    return { get: (id) => (id.endsWith(SYNCED_ID_SUFFIX) ? synced : registry.get(id)) };
  }
  // 레지스트리가 없어도 synced는 있을 수 있다 — 조기 반환하면 synced만 있는 머신이 통째로 빠진다.
  return { get: (id) => pluginInstallPathEntry(registry, synced, id) };
}

/**
 * `claude plugin details <id>` 파싱 — Step 3 확장(AC-4.8 5D 교차검증, harness_alwayson_tokens).
 * `--json` 옵션이 없어(AC-0.5 실측) 텍스트를 정규식으로 파싱한다. `ctk scan`이 아니라 `ctk measure`
 * 전용 경로다 — 플러그인 자산마다 서브프로세스를 1회씩 추가로 띄우므로 매 스캔에 끼워 넣지 않는다.
 *
 * 실측 원문 3건(2026-08-21, 이 세션에서 직접 실행 — `claude plugin details`는 읽기 전용 구조적
 * 서브커맨드라 인증·비용이 들지 않는다):
 * ```
 * context7
 *   Upstash Context7 MCP server for ...
 *   Source: context7@claude-plugins-official
 *
 * Component inventory
 *   Skills (0)
 *   Agents (0)
 *   Hooks (0)
 *   MCP servers (1)  context7  (tool schemas resolved at runtime; not counted)
 *   LSP servers (0)
 *
 * Projected token cost
 *   Always-on:   ~0 tok   added to every session
 * ```
 * `oh-my-claudecode 4.15.7`처럼 **첫 줄에 버전이 붙는 경우도, `context7`처럼 붙지 않는 경우도**
 * 실측됐다 — `version`을 필수로 가정한 AC-0.5 원 스키마를 여기서 정정한다
 * (`core/harness/plugin-details.schema.ts` 갱신 주석 참조).
 */
const SOURCE_LINE_PREFIX = "Source:";

export function parsePluginDetailsText(text: string): PluginDetails | null {
  const lines = text.split("\n");
  const firstLine = lines[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) return null;
  const nameVersionMatch = /^(\S+)(?:\s+(\d[\w.-]*))?$/.exec(firstLine);
  if (nameVersionMatch === null) return null;
  const version = nameVersionMatch[2];

  const sourceLineIndex = lines.findIndex((l) => l.trim().startsWith(SOURCE_LINE_PREFIX));
  if (sourceLineIndex === -1) return null;
  const sourceLine = lines[sourceLineIndex];
  if (sourceLine === undefined) return null;
  const id = sourceLine.trim().slice(SOURCE_LINE_PREFIX.length).trim();
  if (id.length === 0) return null;

  let description: string | undefined;
  for (let i = 1; i < sourceLineIndex; i++) {
    const candidate = lines[i]?.trim();
    if (candidate !== undefined && candidate.length > 0) {
      description = candidate;
      break;
    }
  }

  const countOf = (label: string): number | null => {
    const m = new RegExp(`${label} \\((\\d+)\\)`).exec(text);
    return m?.[1] !== undefined ? Number(m[1]) : null;
  };
  const skills = countOf("Skills");
  const agents = countOf("Agents");
  const hooks = countOf("Hooks");
  const mcpServers = countOf("MCP servers");
  const lspServers = countOf("LSP servers");
  if (skills === null || agents === null || hooks === null || mcpServers === null || lspServers === null) {
    return null;
  }

  const alwaysOnMatch = /Always-on:\s*~?([\d,]+)\s*tok/.exec(text);
  if (alwaysOnMatch?.[1] === undefined) return null;
  const alwaysOnTokens = Number(alwaysOnMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(alwaysOnTokens)) return null;

  try {
    return parsePluginDetails({
      id,
      version,
      description,
      source: id,
      components: { skills, agents, hooks, mcp_servers: mcpServers, lsp_servers: lspServers },
      projected_token_cost: { always_on_tokens: alwaysOnTokens },
    });
  } catch {
    // R13 — 파서가 만든 구조가 zod strict 계약과 안 맞으면(우리 자신의 파싱 버그이거나 하네시
    // 문구가 더 크게 바뀌었거나) null로 열화한다. 호출자는 harness_alwayson을
    // unmeasured(reason: parse_failed)로 남긴다(AC-4.8 — 자동 보정하지 않는다).
    return null;
  }
}

export interface FetchPluginDetailsOptions {
  home: HomeContext;
  cwd: string;
  timeoutSec: number;
  spawnFn?: typeof spawnClaude;
}

/** `null` = 명령 실패 또는 파싱 실패 — 호출자가 unmeasured 사유(command_failed/parse_failed)를 구분해 붙인다. */
export async function fetchPluginDetails(pluginId: string, options: FetchPluginDetailsOptions): Promise<{ details: PluginDetails } | { error: "command_failed" | "parse_failed" }> {
  const { home, cwd, timeoutSec, spawnFn = spawnClaude } = options;
  const result = await spawnFn({ profile: "test-isolated", subcommand: ["plugin", "details", pluginId], home, cwd, timeoutSec });
  if (result.exitCode !== 0) {
    return { error: "command_failed" };
  }
  const details = parsePluginDetailsText(result.stdout);
  if (details === null) {
    return { error: "parse_failed" };
  }
  return { details };
}

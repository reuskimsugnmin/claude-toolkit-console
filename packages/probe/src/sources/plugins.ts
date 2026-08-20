import { readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizePath,
  parseInstalledPluginsFile,
  parsePluginList,
  parseSettingsFile,
  type Asset,
  type Installation,
} from "@ctk/core";
import type { HomeContext } from "../home.js";
import { spawnClaude, type SpawnClaudeResult } from "../harness/spawn-claude.js";
import { CommandFailedError, ParseSchemaMismatchError } from "./errors.js";

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
    assetById.set(entry.id, {
      schema_version: 1,
      _scope: "machine_independent",
      id: entry.id,
      kind: "plugin",
      name,
      marketplace,
      source_ref: normalizedInstallPath.home_relative ?? `path_hash:${normalizedInstallPath.path_hash}`,
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

  // 문서화된 단순화(Step 2 범위) — installed_plugins.json에 프로젝트별 설치 기록이 없는데
  // project-committed settings.json만으로 활성화된 케이스는 다루지 않는다. install_scope의
  // 유일한 권위 출처는 installed_plugins.json이라는 §4.1 Step 2 spec 문구를 그대로 따른다.
  return { assets: [...assetById.values()], installations };
}

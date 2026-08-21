import { readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizePath,
  parseInstalledPluginsFile,
  parsePluginDetails,
  parsePluginList,
  parseSettingsFile,
  type Asset,
  type Installation,
  type PluginDetails,
} from "@ctk/core";
import type { HomeContext } from "../home.js";
import { spawnClaude, type SpawnClaudeResult } from "../harness/spawn-claude.js";
import { CommandFailedError, ParseSchemaMismatchError } from "./errors.js";
import { listKnownProjectPaths } from "./known-projects.js";

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

  // 문서화된 단순화(Step 2 범위) — installed_plugins.json에 프로젝트별 설치 기록이 없는데
  // project-committed settings.json만으로 활성화된 케이스는 다루지 않는다. install_scope의
  // 유일한 권위 출처는 installed_plugins.json이라는 §4.1 Step 2 spec 문구를 그대로 따른다.
  return { assets: [...assetById.values()], installations };
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

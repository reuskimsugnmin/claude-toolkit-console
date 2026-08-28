import { readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizePath,
  parseMcpJsonFile,
  type Asset,
  type Installation,
  type McpEnabledState,
  type McpStateSource,
  type Toggle,
} from "@ctk/core";
import type { HomeContext } from "../home.js";
import { safeAssetNameSegment } from "./asset-name.js";
import { listKnownProjectPaths, readClaudeJsonFile } from "./known-projects.js";

/**
 * probe/src/sources/mcp.ts — plan §4.1 Step 2. **파일 직독 전용** — `claude mcp list`는 24초짜리
 * 전 서버 health-check이고 비결정적이며 HTML이 섞이므로 스냅샷 입력으로 절대 쓰지 않는다(실측,
 * spikes/results/AC-0.7.md 인접 관측). 출처는 `~/.claude.json`의 루트 `mcpServers`(user) ·
 * `projects.<path>.mcpServers`(결정 7 문서의 "프로젝트 엔트리 mcpServers(local)") · 프로젝트
 * `.mcp.json`의 `mcpServers`(project) · 프로젝트 `enabledMcpServers`/`disabledMcpServers`(토글 이력)다.
 *
 * **결정 7 — 이름 패턴으로 kind를 확정하지 않는다.** "로컬에서 정의를 찾을 수 있는가"로 판정한다.
 * - 로컬 정의를 찾은 이름(root/local/project `mcpServers`의 키) → **Asset(kind:"mcp")**.
 * - `plugin:<p>:<s>` (설치된 플러그인 이름과 일치) → **비-Asset**, `toggles[]`에
 *   `classification_source:"definition_found"`(정의가 플러그인 자신이므로).
 * - `claude.ai <Name>` → **비-Asset**, `classification_source:"name_pattern"`.
 * - 그 외(예: `computer-use`) → **비-Asset**, `classification_source:"unclassified"`.
 *
 * AC-0.4ⓑ 실측 결과(spikes/results/AC-0.4.md, Step 0에서 이미 확정): ①우선순위 — 동시 존재 시
 * 두 필드는 겹치지 않는 append형 토글 이력이라 진짜 충돌(같은 이름이 양쪽에 존재) 사례가 0건이었다.
 * 그래도 방어적으로 충돌을 감지하면 `mcp_state_source:"both"` + `mcp_enabled_state:null`로 남긴다.
 * ②대상 범위 — 위 4개 기원 분류로 이미 반영됨. **③(`*McpjsonServers`)은 여전히 판정불가** —
 * 16개 프로젝트 표본 전부 빈 배열이었고 이 스캔에서도 값을 발견하면 `mcp_state_unverified`
 * 성격의 정보로만 남긴다(`Installation.mcp_enabled_state`/`mcp_state_source` 스키마에는 이
 * 세 번째 차원을 위한 자리가 없다 — v1 Ontology가 애초에 이 필드를 모델링하지 않는다).
 */

export interface McpSourceResult {
  assets: Asset[];
  installations: Installation[];
  toggles: Toggle[];
  /**
   * 보안 재심 M-2 — 서버 이름이 안전한 자산 id 세그먼트가 아니어서 건너뛴 건수.
   *
   * ⚠️ **이 축에는 검사 자체가 없었다.** 이 파일은 `.mcp.json`·`~/.claude.json`의 **최상위 키를
   * 그대로** `Asset.id`로 썼고, 그중 하나(프로젝트 `.mcp.json`)는 **저장소에 담겨 배포되는
   * 파일**이다. `"<플러그인id>:mcp:x"`를 자칭하는 저장소를 한 번 열면 번들 자산과 id가 겹쳐
   * `mergeAssets`가 `DuplicateAssetIdError`로 **`ctk scan` 전체를 죽인다.**
   * 이제 그 서버 하나만 건너뛰고 건수를 올린다(안전 원칙 6 — 빠져나갈 길을 남긴다).
   */
  unsafeNamesSkipped: number;
}

export interface CollectMcpOptions {
  home: HomeContext;
  machineId: string;
  /** plugins.ts가 이미 얻은 설치 플러그인 **이름**(marketplace 제외, id의 name@ 부분) 집합 —
   * `plugin:<name>:<server>` 토글의 classification_source 판정에 쓴다. */
  installedPluginNames: ReadonlySet<string>;
}

interface ServerDefinition {
  name: string;
  installScope: "user" | "project" | "local";
  projectPath: string | null;
}

function classifyToggleName(
  name: string,
  installedPluginNames: ReadonlySet<string>,
): Toggle["classification_source"] {
  if (name.startsWith("plugin:")) {
    const pluginName = name.split(":")[1];
    return pluginName !== undefined && installedPluginNames.has(pluginName) ? "definition_found" : "unclassified";
  }
  if (name.startsWith("claude.ai ")) {
    return "name_pattern";
  }
  return "unclassified";
}

export function collectMcp(options: CollectMcpOptions): McpSourceResult {
  const { home, machineId, installedPluginNames } = options;

  const claudeJson = readClaudeJsonFile(home);
  const definitions: ServerDefinition[] = [];

  for (const name of Object.keys(claudeJson?.mcpServers ?? {})) {
    definitions.push({ name, installScope: "user", projectPath: null });
  }

  const knownProjects = listKnownProjectPaths(home);
  for (const projectPath of knownProjects) {
    const projectEntry = claudeJson?.projects?.[projectPath];
    for (const name of Object.keys(projectEntry?.mcpServers ?? {})) {
      definitions.push({ name, installScope: "local", projectPath });
    }
    const mcpJsonAbs = path.join(projectPath, ".mcp.json");
    let mcpJsonRaw: unknown = null;
    try {
      mcpJsonRaw = JSON.parse(readFileSync(mcpJsonAbs, "utf8")) as unknown;
    } catch {
      // 파일 없음 — 정상(프로젝트에 .mcp.json이 없을 수 있다).
    }
    if (mcpJsonRaw !== null) {
      const mcpJson = parseMcpJsonFile(mcpJsonRaw);
      for (const name of Object.keys(mcpJson.mcpServers ?? {})) {
        definitions.push({ name, installScope: "project", projectPath });
      }
    }
  }

  // 자산 — 이름 기준 고유 집계(같은 이름이 user+local 등 여러 스코프에 있어도 자산은 하나).
  const assetByName = new Map<string, Asset>();
  let unsafeNamesSkipped = 0;
  for (const def of definitions) {
    if (assetByName.has(def.name)) continue;
    // ⚠️ **번들 축과 같은 관문을 지난다**(M-2). 예전에는 이 축만 검사 없이 지나갔다.
    if (safeAssetNameSegment(def.name, "MCP 서버 이름") === null) {
      unsafeNamesSkipped++;
      continue;
    }
    assetByName.set(def.name, {
      schema_version: 1,
      _scope: "machine_independent",
      id: def.name,
      kind: "mcp",
      name: def.name,
    });
  }

  // Installation 타입은 mcp_enabled_state/mcp_state_source가 읽기 전용이다(P0-3 — actuator가
  // 실수로 대입하면 컴파일 오류가 나야 한다). probe 내부에서는 아직 조립 중인 가변 초안이므로,
  // 별도 가변 인터페이스로 다루다가 마지막에 한 번에 `Installation[]`으로 확정한다(readonly 우회
  // 캐스팅을 하지 않기 위함).
  interface InstallationDraft {
    asset_id: string;
    install_scope: "user" | "project" | "local" | null;
    project_path_hash: string | null;
    mcp_enabled_state: McpEnabledState | null;
    mcp_state_source: McpStateSource | null;
  }
  const draftKey = (assetId: string, projectPathHash: string | null): string => `${assetId} ${projectPathHash ?? ""}`;
  const drafts = new Map<string, InstallationDraft>();
  for (const def of definitions) {
    const projectPathHash = def.projectPath !== null ? normalizePath(def.projectPath, home.ctkHome).path_hash : null;
    drafts.set(draftKey(def.name, projectPathHash), {
      asset_id: def.name,
      install_scope: def.installScope,
      project_path_hash: projectPathHash,
      mcp_enabled_state: null,
      mcp_state_source: null,
    });
  }

  const definedNames = new Set(definitions.map((d) => d.name));
  const toggles: Toggle[] = [];

  for (const projectPath of knownProjects) {
    const projectEntry = claudeJson?.projects?.[projectPath];
    const enabledNames = new Set(projectEntry?.enabledMcpServers ?? []);
    const disabledNames = new Set(projectEntry?.disabledMcpServers ?? []);
    const allNames = new Set<string>([...enabledNames, ...disabledNames]);
    const projectPathHash = normalizePath(projectPath, home.ctkHome).path_hash;

    for (const name of allNames) {
      const isEnabled = enabledNames.has(name);
      const isDisabled = disabledNames.has(name);
      const conflict = isEnabled && isDisabled;

      if (definedNames.has(name)) {
        // 정의를 찾은 MCP 자산 — 해당 프로젝트의 Installation 초안에 mcp_enabled_state를 채운다.
        // 그 프로젝트 스코프로 이미 만든 초안이 있으면 거기에 병합하고, 없으면(예: user 스코프
        // 서버를 프로젝트 단위로 토글) install_scope:null인 새 초안을 추가한다.
        const state: McpEnabledState | null = conflict ? null : isEnabled ? "enabled" : "disabled";
        const source: McpStateSource = conflict ? "both" : isEnabled ? "enabledMcpServers" : "disabledMcpServers";
        const key = draftKey(name, projectPathHash);
        const existing = drafts.get(key);
        if (existing) {
          existing.mcp_enabled_state = state;
          existing.mcp_state_source = source;
        } else {
          drafts.set(key, {
            asset_id: name,
            install_scope: null,
            project_path_hash: projectPathHash,
            mcp_enabled_state: state,
            mcp_state_source: source,
          });
        }
        continue;
      }

      // 정의를 못 찾은 이름 — 비-Asset 토글 관측(결정 7). 충돌이면 각 source_field별로 원문 그대로
      // 보존한다(버리지 않는다 — append-only 원칙).
      const classification = classifyToggleName(name, installedPluginNames);
      if (isEnabled) {
        toggles.push({
          schema_version: 1,
          _scope: "machine_dependent",
          __kind: "toggle",
          project_path_hash: projectPathHash,
          name,
          state: "enabled",
          source_field: "enabledMcpServers",
          classification_source: classification,
        });
      }
      if (isDisabled) {
        toggles.push({
          schema_version: 1,
          _scope: "machine_dependent",
          __kind: "toggle",
          project_path_hash: projectPathHash,
          name,
          state: "disabled",
          source_field: "disabledMcpServers",
          classification_source: classification,
        });
      }
    }
  }

  const installations: Installation[] = [...drafts.values()].map((draft) => ({
    schema_version: 1,
    _scope: "machine_dependent",
    asset_id: draft.asset_id,
    machine_id: machineId,
    install_scope: draft.install_scope,
    enabled_at: null, // MCP는 v1 읽기 전용 — enabled_at 개념 대신 mcp_enabled_state/mcp_state_source를 쓴다.
    project_path_hash: draft.project_path_hash,
    mcp_enabled_state: draft.mcp_enabled_state,
    mcp_state_source: draft.mcp_state_source,
  }));

  return { assets: [...assetByName.values()], installations, toggles, unsafeNamesSkipped };
}

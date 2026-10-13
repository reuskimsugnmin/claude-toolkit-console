import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COMPUTER_USE,
  classifyToggleName,
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
 * **상태 축 (2026-10-12 실측, CLI 2.1.296 — 번들 판정 함수 원문 + 격리 HOME, r7-prereq F1·F2).**
 * 하네스의 판정은 `isDisabled(name) = name==="computer-use" ? !enabledMcpServers.includes(name)
 * : disabledMcpServers.includes(name)` 한 줄이다. 즉 `enabledMcpServers`는 **내장 `computer-use`
 * 한 이름에만** 의미가 있고, 그 외 모든 서버는 `disabledMcpServers`에 있으면 Disabled다(같은 이름이
 * 양쪽에 있어도 Disabled — 우선순위 질문 자체가 없다). 플러그인 서버는 `plugin:<p>:<s>` 형태로만
 * 매칭된다(베어 서버명은 무효). 그래서 여기서는 `computer-use` 외 이름의 `enabledMcpServers`를
 * 읽지 않으며, 양쪽에 있는 이름은 `disabledMcpServers` 출처의 disabled로 판정한다.
 * ⚠️ 예전 이 주석은 AC-0.4(2026-08)의 "append형 토글 이력" 결론을 인용해 `enabledMcpServers`를
 * 일반 enabled 신호로 읽고 `both` 충돌 경로를 뒀다 — 그 결론은 위 실측으로 정정됐다(결과 파일은
 * 현재 플레이스홀더). `McpStateSource`의 `"both"` 값은 이미 저장된 스냅샷이 쓰므로 스키마에 남기되
 * probe는 더 만들지 않는다. `disabledMcpServers`에 없는 이름의 상태는 `null`(판정 안 함 — 특히
 * `.mcp.json` 서버는 승인 전이면 Pending이라 "enabled"로 단정할 수 없다).
 * ③(`*McpjsonServers`, 승인 축)은 이 파일이 읽지 않는다 — 현재 위치는 settings 계층이다.
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
  /**
   * `.mcp.json`이 **있는데 읽거나 파싱하지 못한** 프로젝트의 path_hash(원경로 아님). 파일 없음(ENOENT)은 여기 안 든다.
   * ⚠️ 깨진 파일을 "파일 없음"으로 삼키면 그 서버들이 조용히 사라지고, `ctk mcp`가 엉뚱한 사유로 거부한다(안전 원칙 7).
   */
  unreadableMcpJsonProjectHashes: string[];
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

export function collectMcp(options: CollectMcpOptions): McpSourceResult {
  const { home, machineId, installedPluginNames } = options;

  const claudeJson = readClaudeJsonFile(home);
  const definitions: ServerDefinition[] = [];

  for (const name of Object.keys(claudeJson?.mcpServers ?? {})) {
    definitions.push({ name, installScope: "user", projectPath: null });
  }

  const unreadableMcpJsonProjectHashes: string[] = [];
  const knownProjects = listKnownProjectPaths(home);
  for (const projectPath of knownProjects) {
    const projectEntry = claudeJson?.projects?.[projectPath];
    for (const name of Object.keys(projectEntry?.mcpServers ?? {})) {
      definitions.push({ name, installScope: "local", projectPath });
    }
    const mcpJsonAbs = path.join(projectPath, ".mcp.json");
    try {
      const mcpJson = parseMcpJsonFile(JSON.parse(readFileSync(mcpJsonAbs, "utf8")) as unknown);
      for (const name of Object.keys(mcpJson.mcpServers ?? {})) {
        definitions.push({ name, installScope: "project", projectPath });
      }
    } catch (err) {
      // 파일 없음만 정상(프로젝트에 .mcp.json이 없을 수 있다). 그 외(권한·디렉터리·깨진 JSON·잘못된 모양)는
      // "없음"이 아니라 "못 읽음"이다 — 던지지 않고(프로젝트 하나가 scan 전체를 죽이면 안 된다) 해시만 남긴다.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        unreadableMcpJsonProjectHashes.push(normalizePath(projectPath, home.ctkHome).path_hash);
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
    // 하네스가 enabledMcpServers를 참조하는 이름은 computer-use뿐이다(위 헤더) — 그 외 이름은
    // disabledMcpServers에서만 관측한다.
    const allNames = new Set<string>(disabledNames);
    if (enabledNames.has(COMPUTER_USE)) allNames.add(COMPUTER_USE);
    const projectPathHash = normalizePath(projectPath, home.ctkHome).path_hash;

    for (const name of allNames) {
      const isEnabled = name === COMPUTER_USE && enabledNames.has(name);
      const isDisabled = disabledNames.has(name);

      if (definedNames.has(name)) {
        // 정의를 찾은 MCP 자산 — 해당 프로젝트의 Installation 초안에 mcp_enabled_state를 채운다.
        // 그 프로젝트 스코프로 이미 만든 초안이 있으면 거기에 병합하고, 없으면(예: user 스코프
        // 서버를 프로젝트 단위로 토글) install_scope:null인 새 초안을 추가한다.
        const state: McpEnabledState = isEnabled ? "enabled" : "disabled";
        const source: McpStateSource = isEnabled ? "enabledMcpServers" : "disabledMcpServers";
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

      // 정의를 못 찾은 이름 — 비-Asset 토글 관측(결정 7). computer-use는 두 리스트를 각각 원문 그대로 보존한다.
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

  return { assets: [...assetByName.values()], installations, toggles, unsafeNamesSkipped, unreadableMcpJsonProjectHashes };
}

import type { Asset } from "./schema/asset.js";
import type { Installation, RegistryScope } from "./schema/installation.js";
import { maskedProjectPath, type ClaudeJsonSemanticVerdict, type McpToggleOp } from "./guard/claude-json-semantic.js";
import { CLAUDE_AI_CONNECTOR_PREFIX, COMPUTER_USE, formatPluginMcpName } from "./mcp/names.js";
import { pluginNameFromId } from "./usage/subagent-resolve.js";

/**
 * core/src/mcp-toggle.ts — `ctk mcp <disable|enable>`의 **순수** 절반: 쓸 바이트 계획·적격성·판정 술어.
 * 파일을 읽고 쓰는 것은 actuator 몫이다(이 모듈은 문자열과 파싱된 값만 본다).
 */

/** `.claude.json`을 쓰는 하네스의 직렬화 — 2칸 들여쓰기, 끝 개행 없음(실측: fixtures/claude-json/). */
export function serializeClaudeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `JSON.parse`가 만든 `"__proto__"`는 자기 키다 — 프로토타입 체인으로 새지 않게 자기 소유만 읽는다. */
function own(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export type McpTogglePlan =
  | { kind: "noop" }
  | { kind: "write"; nextRaw: string; before: string[]; after: string[] }
  /** `offset`: 원문과 재직렬화 결과가 처음 달라지는 UTF-16 오프셋. */
  | { kind: "format_unrecognized"; offset: number }
  | { kind: "refused"; reason: "not_json" | "project_key_absent" | "entry_not_object" | "list_not_string_array" };

/**
 * `raw`(S0)에서 `projects[key].disabledMcpServers`에 `name` 하나를 더하거나 뺀 다음 바이트를 계획한다.
 * 전제: `serialize(parse(raw)) === raw` — 아니면 우리가 쓸 바이트가 하네스의 바이트와 다른 곳까지 바꾼다.
 * 키는 **S0에 이미 있어야** 한다(부재 → `{}` 기본값으로 프로젝트 엔트리를 만들지 않는다, risk 4/6).
 * 값은 `JSON.parse` 원본만 쓴다 — zod 출력을 다시 직렬화하지 않는다.
 */
export function planMcpToggle(raw: string, key: string, name: string, op: McpToggleOp): McpTogglePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "refused", reason: "not_json" };
  }
  const roundTrip = serializeClaudeJson(parsed);
  if (roundTrip !== raw) {
    let offset = 0;
    while (offset < raw.length && offset < roundTrip.length && raw[offset] === roundTrip[offset]) offset++;
    return { kind: "format_unrecognized", offset };
  }
  const projects = isPlainObject(parsed) ? own(parsed, "projects") : undefined;
  if (!isPlainObject(projects) || !Object.hasOwn(projects, key)) return { kind: "refused", reason: "project_key_absent" };
  const entry = projects[key];
  if (!isPlainObject(entry)) return { kind: "refused", reason: "entry_not_object" };
  const list = own(entry, "disabledMcpServers");
  if (list !== undefined && !isStringArray(list)) return { kind: "refused", reason: "list_not_string_array" };

  const before = list ?? [];
  if (before.includes(name) === (op === "disable")) return { kind: "noop" };
  const after = op === "disable" ? [...before, name] : before.filter((x) => x !== name);
  entry.disabledMcpServers = after; // 키가 있으면 제자리, 없으면 끝에 추가 — 하네스가 쓰는 위치와 같다.
  return { kind: "write", nextRaw: serializeClaudeJson(parsed), before, after };
}

/** 파싱된 `.claude.json`에서 `projects[key].disabledMcpServers`가 `expected`와 순서까지 정확히 같은가(쓴 뒤 분류용). */
export function ownedSubtreeEquals(value: unknown, key: string, expected: readonly string[]): boolean {
  const projects = isPlainObject(value) ? own(value, "projects") : undefined;
  const entry = isPlainObject(projects) ? own(projects, key) : undefined;
  const list = isPlainObject(entry) ? own(entry, "disabledMcpServers") : undefined;
  return isStringArray(list) && list.length === expected.length && list.every((x, i) => x === expected[i]);
}

/**
 * 판정이 **정확히 그 키의 `disabledMcpServers` 한 경로**만 바꿨고 그것이 허용됐는가. 판정기는 살아 있는
 * 세션의 `pluginUsage` churn을 항상 허용하므로(audit.ts) `allowedChurnKeys=[]`만으로는 "토글 하나뿐"이
 * 보장되지 않는다 — 다른 경로가 하나라도 같이 바뀌었으면 false다.
 */
export function isExactMcpToggleVerdict(verdict: ClaudeJsonSemanticVerdict, projectKey: string): boolean {
  const [only, ...rest] = verdict.changed;
  return (
    only !== undefined &&
    rest.length === 0 &&
    only.path === maskedProjectPath(projectKey, "disabledMcpServers") &&
    only.status === "allowed_churn" &&
    verdict.violations.length === 0
  );
}

/**
 * 자산 id를 터미널·웹·역방향 힌트에 그대로 찍어도 되는가. 코드베이스에 id 문법이 없어 여기서 한 번 정의한다
 * (동기화된 — 신뢰할 수 없는 — 저널에서 온 id가 셸 힌트로 출력되므로 공백·제어문자·셸 메타문자를 거르고, 옵션으로 읽히는 `-`·`..` 시작도 거른다).
 */
export function isDisplayableAssetId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,199}$/.test(id);
}

export type McpToggleRefusalReason =
  | "not_mcp"
  | "connector_or_builtin"
  | "not_defined_for_project"
  | "plugin_not_installed"
  | "plugin_not_installed_for_project"
  | "plugin_name_ambiguous"
  | "plugin_synced_unmeasured"
  | "plugin_manifest_unmeasured"
  | "server_not_in_plugin";

export type McpToggleTarget =
  | { ok: true; harnessName: string; pendingApproval: boolean }
  | { ok: false; reason: McpToggleRefusalReason; hint: string };

/** 설치된 플러그인 한 건(레지스트리 한 엔트리 또는 동기화 키). `projectPathHash`는 project/local 스코프에서만 값이 있다. */
export interface InstalledPluginRef {
  id: string;
  scope: RegistryScope;
  projectPathHash: string | null;
}

export interface McpToggleTargetInput {
  assetId: string;
  /** 카탈로그에서 찾은 자산. 없으면 `undefined`. */
  asset: Asset | undefined;
  projectPathHash: string;
  /** 이 자산의 Installation 행들. **정의는 `install_scope !== null`인 행뿐이다**(상태 전용 초안은 정의가 아니다). */
  installations: readonly Pick<Installation, "asset_id" | "install_scope" | "project_path_hash">[];
  installedPlugins: readonly InstalledPluginRef[];
  /** 부모 플러그인이 번들한 MCP 자산 id 집합. `null` = 동기화 플러그인의 매니페스트를 읽지 못함(미측정). */
  bundledMcpAssetIds: ReadonlySet<string> | null;
}

function refuse(reason: McpToggleRefusalReason, hint: string): McpToggleTarget {
  return { ok: false, reason, hint };
}

/**
 * 자산이 이 프로젝트에서 토글 **가능한** 서버인가, 가능하면 하네스가 읽는 이름은 무엇인가.
 * 하네스는 `disabledMcpServers`를 이름으로 매칭하므로(플러그인 서버는 `plugin:<이름>:<서버>`만 유효) 이름이
 * 틀리거나 서버가 그 프로젝트에 없으면 쓰기가 조용한 무효가 된다 — 그 경우를 전부 여기서 거부한다.
 */
export function resolveMcpToggleTarget(input: McpToggleTargetInput): McpToggleTarget {
  const { assetId, asset, projectPathHash, installations, installedPlugins, bundledMcpAssetIds } = input;
  if (asset === undefined) {
    return assetId === COMPUTER_USE || assetId.startsWith(CLAUDE_AI_CONNECTOR_PREFIX)
      ? refuse("connector_or_builtin", "커넥터·내장 기능은 이 도구로 끄지 않는다 — /mcp 에서 직접 끈다.")
      : refuse("not_mcp", "카탈로그에 없는 자산이다 — `ctk scan` 뒤 다시 시도한다.");
  }
  if (asset.kind !== "mcp") return refuse("not_mcp", `kind=${asset.kind} 자산이다 — MCP 서버만 토글한다.`);
  const parent = asset.parent_asset_id;

  if (parent === undefined) {
    if (asset.name === COMPUTER_USE || asset.name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX)) {
      return refuse("connector_or_builtin", "하네스가 이 이름은 다른 목록으로 판정한다 — disabledMcpServers 쓰기가 무효다. /mcp 에서 직접 끈다.");
    }
    const defs = installations.filter((i) => i.asset_id === asset.id && i.install_scope !== null);
    const forProject = defs.filter((d) => d.install_scope === "user" || d.project_path_hash === projectPathHash);
    if (forProject.length === 0) {
      return refuse("not_defined_for_project", "이 서버는 선택한 프로젝트에 정의돼 있지 않다(다른 프로젝트의 local/.mcp.json 서버). 정의된 프로젝트를 고른다.");
    }
    // `.mcp.json`(project)만이 정의라면 승인 전 Pending일 수 있다(D3) — 토글은 허용하되 알린다.
    return { ok: true, harnessName: asset.name, pendingApproval: forProject.every((d) => d.install_scope === "project") };
  }

  const refs = installedPlugins.filter((p) => p.id === parent);
  if (refs.length === 0) return refuse("plugin_not_installed", `부모 플러그인 ${parent}가 이 머신에 설치돼 있지 않다.`);
  const pluginName = pluginNameFromId(parent);
  if (new Set(installedPlugins.filter((p) => pluginNameFromId(p.id) === pluginName).map((p) => p.id)).size > 1) {
    return refuse("plugin_name_ambiguous", `이름이 같은 플러그인이 둘 이상 설치돼 있어 하네스 이름(plugin:${pluginName}:…)이 모호하다.`);
  }
  // 동기화(synced) 플러그인은 계정 전체 적용이라 user와 같게 본다.
  const forProject = refs.filter(
    (r) => r.scope === "user" || r.scope === "synced" || ((r.scope === "project" || r.scope === "local") && r.projectPathHash === projectPathHash),
  );
  if (forProject.length === 0) {
    return refuse("plugin_not_installed_for_project", "부모 플러그인이 이 프로젝트에 설치돼 있지 않다 — 써도 아무 효과가 없다. 설치된 프로젝트를 고른다.");
  }
  if (bundledMcpAssetIds === null) {
    // 원인이 다르면 처방도 다르다 — 동기화 플러그인은 계정 manifest, 그 외는 설치 디렉터리의 .mcp.json이다.
    return forProject.every((r) => r.scope === "synced")
      ? refuse("plugin_synced_unmeasured", "동기화 플러그인의 매니페스트를 읽지 못해 서버 존재를 확인할 수 없다.")
      : refuse("plugin_manifest_unmeasured", "플러그인 설치 디렉터리의 .mcp.json을 읽지 못해(경로 거부·형태 오류 포함) 서버 존재를 확인할 수 없다.");
  }
  if (!bundledMcpAssetIds.has(asset.id)) {
    return refuse("server_not_in_plugin", "설치된 플러그인 버전에 이 서버가 없다 — `ctk scan`으로 카탈로그를 새로 고친다.");
  }
  return { ok: true, harnessName: formatPluginMcpName(pluginName, asset.name), pendingApproval: false };
}

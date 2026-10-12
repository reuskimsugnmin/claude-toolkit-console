import { hashPath } from "../snapshot/path-normalize.js";

/**
 * core/src/guard/claude-json-semantic.ts — AC-2.7-c "`.claude.json`의 의미 diff 전체" 판정기.
 *
 * `.claude.json`은 파일 바이트로는 Tier-2 churn 허용이다(whitelist.ts의 `TIER2_CHURN_ALLOWLIST`
 * 안 `.claude.json` 항목 — AC-0.8이 이 파일 자체의 바이트 변화까지만 실측했다). 하지만 그 안의
 * JSON **내용**은 "전체가 deep-equal이어야 하며 예외는 실측된 churn 키 집합에 한한다"(F5 —
 * 블랙리스트가 아니라 화이트리스트 방향). 이 모듈이 그 두 번째, 더 엄격한 검사다.
 *
 * MCP 서브트리(`mcpServers` · `projects.*.mcpServers` · `projects.*.{enabled,disabled}McpServers` ·
 * `projects.*.{enabled,disabled}McpjsonServers`)는 **어떤 churn 키 집합으로도 예외를 주지 않는다**
 * — 호출자가 `allowedChurnKeys`에 이 이름들을 넣어도 이 판정기가 무시하고 항상 위반으로 판정한다
 * (AC-2.7-c 원문: "MCP 서브트리는 어떤 실측 결과로도 churn 예외에 넣지 않는다").
 *
 * 순수 함수(I/O 없음) — 파싱된 JSON 값 두 개를 받는다. 파일을 읽는 것은 호출자(actuator/audit.ts)
 * 책임이다(H1과 동형 — 판정과 수집을 분리한다. tree-diff.ts와 같은 설계).
 *
 * ⚠️ `projects` 키는 프로젝트 절대경로 원문이다(AC-1.7). 이 판정기는 project별 변경을 보고할 때
 * 원문 키 대신 `projects.#<path_hash 8자>`로 마스킹한다 — "무엇이 바뀌었나"(서브키 이름)는 정책
 * 판정에 필요하지만 "어느 프로젝트인가"(경로 원문)는 필요하지 않다.
 */

export type ClaudeJsonPathStatus = "allowed_churn" | "violation";

export interface ClaudeJsonPathVerdict {
  /** 정책 판정에 쓰는 마스킹된 경로. project 키는 원문 대신 #<hash>로 치환된다(AC-1.7). */
  path: string;
  status: ClaudeJsonPathStatus;
  /** MCP 서브트리 위반이면 true — 호출자는 이 값으로 forbidden_path_write vs whitelist_violation을 가른다. */
  mcpForbidden: boolean;
}

export interface ClaudeJsonSemanticVerdict {
  changed: ClaudeJsonPathVerdict[];
  violations: ClaudeJsonPathVerdict[];
  overallStatus: "clean" | "allowed_churn" | "violation";
}

/** 프로젝트 엔트리 안에서 절대 churn 예외를 주지 않는 서브키(AC-2.7-c). */
const MCP_PROJECT_SUBTREE_KEYS = new Set([
  "mcpServers",
  "enabledMcpServers",
  "disabledMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
]);

/** 최상위에서 절대 churn 예외를 주지 않는 키(root `mcpServers` — 결정 7). */
const MCP_ROOT_FORBIDDEN_KEYS = new Set(["mcpServers"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 자기 소유 프로퍼티만 읽는다. `JSON.parse`는 `"__proto__"`를 **자기 키**로 만들지만 `o["__proto__"]`는
 * 그 키가 없는 쪽에서 `Object.prototype`을 돌려준다 — `{}`와 deep-equal이 돼 **빈 객체 추가가 통과했다**(보안 심사).
 */
function own(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** 값 기준 재귀 deep-equal — 객체는 키 순서 무관, 배열은 순서 유지. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.hasOwn(b, k) && deepEqual(own(a, k), own(b, k)));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  return false;
}

function classify(
  path: string,
  mcpForbidden: boolean,
  allowedChurnKeys: ReadonlySet<string>,
  matchKey: string,
): ClaudeJsonPathVerdict {
  if (mcpForbidden) {
    return { path, status: "violation", mcpForbidden: true };
  }
  const status: ClaudeJsonPathStatus = allowedChurnKeys.has(matchKey) ? "allowed_churn" : "violation";
  return { path, status, mcpForbidden: false };
}

/**
 * 마스킹된 프로젝트 서브키 경로 — **이 포맷의 유일한 생산자다.** 판정기가 보고하는 경로와
 * `isExactMcpToggleVerdict`(mcp-toggle.ts)가 기대하는 경로가 같은 함수에서 나와야 한쪽만
 * 고쳐져 서로 어긋나지 않는다(사본은 코드처럼 생기지 않은 자리 — 템플릿 문자열 — 에서 생긴다).
 */
export function maskedProjectPath(projectKey: string, subkey?: string): string {
  const entry = `projects.#${hashPath(projectKey).slice(0, 8)}`;
  return subkey === undefined ? entry : `${entry}.${subkey}`;
}

export type McpToggleOp = "disable" | "enable";

/** MCP 토글 한 건의 예외 신청 — 이 키의 `disabledMcpServers`에서 이 이름 하나를 이 방향으로 바꾼 diff만 통과시킨다. */
export interface McpToggleException {
  projectKey: string;
  name: string;
  op: McpToggleOp;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * `disabledMcpServers`의 변경이 **`name` 하나를 `op` 방향으로 토글한 흔적과 정확히 일치하는가**
 * (통과 축은 완전 일치 — 원소 순서·다른 이름·문자열 아닌 원소는 전부 불일치).
 * disable: `after == [...(before ?? []), name]` 이고 `name ∉ before`. enable: `before`가 배열이고
 * `name ∈ before` 이며 `after == before.filter(≠name)`.
 */
export function isMcpDisableToggleTouch(before: unknown, after: unknown, name: string, op: McpToggleOp): boolean {
  if (before !== undefined && !isStringArray(before)) return false;
  if (!isStringArray(after)) return false;
  const present = before?.includes(name) === true;
  if (op === "disable" ? present : !present) return false;
  const expected = op === "disable" ? [...(before ?? []), name] : (before ?? []).filter((x) => x !== name);
  return expected.length === after.length && expected.every((x, i) => x === after[i]);
}

function diffProjectEntry(
  projectKey: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowedChurnKeys: ReadonlySet<string>,
  out: ClaudeJsonPathVerdict[],
  /** 이 프로젝트 키에 **적용 가능한** 토글 예외만 온다(키가 양쪽에 있고 plain object일 때 — 호출자가 확인). */
  mcpToggle: McpToggleException | null,
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (deepEqual(own(before, key), own(after, key))) continue;
    const path = maskedProjectPath(projectKey, key);
    if (
      key === "disabledMcpServers" &&
      mcpToggle !== null &&
      isMcpDisableToggleTouch(own(before, key), own(after, key), mcpToggle.name, mcpToggle.op)
    ) {
      out.push({ path, status: "allowed_churn", mcpForbidden: false });
      continue;
    }
    out.push(classify(path, MCP_PROJECT_SUBTREE_KEYS.has(key), allowedChurnKeys, `projects.*.${key}`));
  }
}

/** `claude plugin enable`이 그 플러그인 항목에서 바꾸는 필드(CLI 2.1.284 실측, docs/harness-facts.md). */
const PLUGIN_ENABLE_TOUCHED_FIELDS = new Set(["lastUsedAt", "lastUsedNumStartups"]);

const LIVE_SESSION_PLUGIN_ENTRY_FIELDS = new Set(["lastUsedAt", "usageCount"]);

/**
 * 다른 살아 있는 세션의 사용 기록 churn — **양쪽에 모두 있는 기존 항목**이 `lastUsedAt`·`usageCount`
 * (숫자)만 바꾼 경우만이다. 항목의 추가·삭제, 다른 필드, 숫자가 아닌 값은 해당되지 않는다.
 */
function isLiveSessionEntryChurn(before: unknown, after: unknown): boolean {
  if (!isPlainObject(before) || !isPlainObject(after)) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (deepEqual(own(before, key), own(after, key))) continue;
    if (!LIVE_SESSION_PLUGIN_ENTRY_FIELDS.has(key)) return false;
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) return false;
    if (typeof own(after, key) !== "number" || !Number.isFinite(own(after, key))) return false;
  }
  return true;
}

/** `pluginUsage` 전체가 "기존 항목의 live-session churn만"으로 설명되는가(항목 집합은 동일해야 한다). */
function isLiveSessionPluginUsageChurn(before: unknown, after: unknown, exceptId: string | null): boolean {
  if (!isPlainObject(before) || !isPlainObject(after)) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === exceptId) continue;
    if (deepEqual(own(before, key), own(after, key))) continue;
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) return false; // 새/삭제 항목은 churn이 아니다
    if (!isLiveSessionEntryChurn(own(before, key), own(after, key))) return false;
  }
  return true;
}

/**
 * `pluginUsage`의 변경이 **`assetId` 하나를 enable한 흔적과 정확히 일치하는가.** 실측(CLI 2.1.284):
 * `enable`은 그 id 항목의 `lastUsedAt`(현재 시각)·`lastUsedNumStartups`(0)만 바꾸고 `usageCount`는
 * 보존하며, 항목이 없으면 `usageCount: 0`으로 만든다. **다른 항목은 건드리지 않는다.** 키 전체를
 * churn으로 열지 않는 이유: 그러면 다른 플러그인의 사용 기록이 바뀌어도 통과한다(통과 축은 완전 일치).
 */
export function isPluginEnableUsageTouch(before: unknown, after: unknown, assetId: string, allowLiveSessionChurn = false): boolean {
  if (before !== undefined && !isPlainObject(before)) return false;
  if (!isPlainObject(after)) return false;
  const b = before ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(after)]);
  if (allowLiveSessionChurn) {
    if (!isLiveSessionPluginUsageChurn(b, after, assetId)) return false;
  } else {
    for (const key of keys) {
      if (key !== assetId && !deepEqual(own(b, key), own(after, key))) return false;
    }
  }
  if (!Object.hasOwn(after, assetId)) return false;
  const afterEntry = after[assetId];
  if (!isPlainObject(afterEntry)) return false;
  // 바뀌는 두 필드도 실측 값의 형태와 정확히 맞아야 한다 — 이름만 맞으면 임의 값·삭제가 통과했다.
  const lastUsedAt = own(afterEntry, "lastUsedAt");
  if (typeof lastUsedAt !== "number" || !Number.isFinite(lastUsedAt) || own(afterEntry, "lastUsedNumStartups") !== 0) return false;
  const beforeEntry = own(b, assetId);
  if (beforeEntry === undefined) {
    return own(afterEntry, "usageCount") === 0 && Object.keys(afterEntry).every((k) => k === "usageCount" || PLUGIN_ENABLE_TOUCHED_FIELDS.has(k));
  }
  if (!isPlainObject(beforeEntry)) return false;
  const entryKeys = new Set([...Object.keys(beforeEntry), ...Object.keys(afterEntry)]);
  for (const key of entryKeys) {
    if (PLUGIN_ENABLE_TOUCHED_FIELDS.has(key)) continue;
    if (!deepEqual(own(beforeEntry, key), own(afterEntry, key))) return false; // usageCount 포함 — 보존돼야 한다
  }
  return true;
}

/**
 * `.claude.json` 의미 diff 판정. `allowedChurnKeys`는 호출자가 넘기는 화이트리스트다(파라미터화
 * — tree-diff.ts의 C2 baseline 파라미터화와 동형). 형식:
 *   - 최상위 키는 키 이름 그대로(예: `"numStartups"`)
 *   - project 엔트리 서브키는 `"projects.*.<subkey>"` 형태(모든 프로젝트에 공통 적용)
 * `homeDir`은 project 키(절대경로)를 해시하기 위해서만 쓰인다 — 결과에 원문이 남지 않는다.
 */
export function claudeJsonSemanticVerdict(
  before: unknown,
  after: unknown,
  allowedChurnKeys: readonly string[] = [],
  /** 플러그인 `move`만 넘긴다 — 이 id를 enable한 `pluginUsage` 흔적만 churn으로 본다(나머지 경로는 그대로 엄격). */
  enabledPluginId: string | null = null,
  /** true면 `pluginUsage`의 **다른** 기존 항목이 `lastUsedAt`·`usageCount`만 바꾼 것(다른 살아 있는 세션의 흔적)을 churn으로 본다. 실측 근거는 호출자가 책임진다. */
  allowLiveSessionPluginUsage = false,
  /** `ctk mcp`만 넘긴다 — 그 프로젝트 키의 `disabledMcpServers` 한 이름 토글만 예외. 나머지 MCP 서브키는 그대로 위반. */
  mcpToggle: McpToggleException | null = null,
): ClaudeJsonSemanticVerdict {
  const allowSet = new Set(allowedChurnKeys);
  const changed: ClaudeJsonPathVerdict[] = [];

  const beforeObj = isPlainObject(before) ? before : {};
  const afterObj = isPlainObject(after) ? after : {};

  const topKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  for (const key of topKeys) {
    if (key === "projects") continue; // 아래에서 별도 처리(원문 경로 마스킹 필요).
    if (deepEqual(own(beforeObj, key), own(afterObj, key))) continue;
    // 단일 관문 — pluginUsage의 churn 허용은 이 조건 하나로만 결정된다.
    if (
      key === "pluginUsage" &&
      ((enabledPluginId !== null && isPluginEnableUsageTouch(own(beforeObj, key), own(afterObj, key), enabledPluginId, allowLiveSessionPluginUsage)) ||
        (enabledPluginId === null && allowLiveSessionPluginUsage && isLiveSessionPluginUsageChurn(own(beforeObj, key), own(afterObj, key), null)))
    ) {
      changed.push({ path: key, status: "allowed_churn", mcpForbidden: false });
      continue;
    }
    changed.push(classify(key, MCP_ROOT_FORBIDDEN_KEYS.has(key), allowSet, key));
  }

  // 최상위 `projects`의 형 변경([]↔{} 등)도 엔트리 비교에서는 `{}`로 읽혀 사라진다.
  if (!(isPlainObject(own(beforeObj, "projects")) && isPlainObject(own(afterObj, "projects"))) && !deepEqual(own(beforeObj, "projects"), own(afterObj, "projects"))) {
    changed.push({ path: "projects", status: "violation", mcpForbidden: false });
  }
  const beforeProjects = isPlainObject(beforeObj.projects) ? beforeObj.projects : {};
  const afterProjects = isPlainObject(afterObj.projects) ? afterObj.projects : {};
  const projectKeys = new Set([...Object.keys(beforeProjects), ...Object.keys(afterProjects)]);
  for (const projectPath of projectKeys) {
    const beforeEntry = own(beforeProjects, projectPath);
    const afterEntry = own(afterProjects, projectPath);
    if (deepEqual(beforeEntry, afterEntry)) continue;
    // 엔트리의 생성·삭제·형 변경은 서브키 diff로 보이지 않는다(부재·비객체를 `{}`로 읽으면 빈 엔트리의 변화가
    // 사라진다) — 엔트리 단위 위반으로 직접 올린다. `own()`은 없는 키에 undefined를 주므로 plain-object 검사가 곧 존재 검사다.
    if (!isPlainObject(beforeEntry) || !isPlainObject(afterEntry)) {
      // 새로 생기거나 사라지는 엔트리가 MCP 서브키를 담고 있으면 예전처럼 mcpForbidden이다(호출자가 사유를 가른다).
      const mcpForbidden = [beforeEntry, afterEntry].some((e) => isPlainObject(e) && Object.keys(e).some((k) => MCP_PROJECT_SUBTREE_KEYS.has(k)));
      changed.push({ path: maskedProjectPath(projectPath), status: "violation", mcpForbidden });
      continue;
    }
    // 예외는 키가 **양쪽에 있고 둘 다 plain object일 때만** 열린다(risk 4) — 위 분기가 이미 보장한다.
    const toggleApplies = mcpToggle !== null && mcpToggle.projectKey === projectPath;
    diffProjectEntry(
      projectPath,
      beforeEntry,
      afterEntry,
      allowSet,
      changed,
      toggleApplies ? mcpToggle : null,
    );
  }

  const violations = changed.filter((v) => v.status === "violation");
  const overallStatus: ClaudeJsonSemanticVerdict["overallStatus"] =
    violations.length > 0 ? "violation" : changed.length > 0 ? "allowed_churn" : "clean";

  return { changed, violations, overallStatus };
}

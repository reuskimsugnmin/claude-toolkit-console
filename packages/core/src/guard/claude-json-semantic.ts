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

/** 값 기준 재귀 deep-equal — 객체는 키 순서 무관, 배열은 순서 유지. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
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

function diffProjectEntry(
  projectPathHash: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowedChurnKeys: ReadonlySet<string>,
  out: ClaudeJsonPathVerdict[],
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (deepEqual(before[key], after[key])) continue;
    const path = `projects.#${projectPathHash}.${key}`;
    out.push(classify(path, MCP_PROJECT_SUBTREE_KEYS.has(key), allowedChurnKeys, `projects.*.${key}`));
  }
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
): ClaudeJsonSemanticVerdict {
  const allowSet = new Set(allowedChurnKeys);
  const changed: ClaudeJsonPathVerdict[] = [];

  const beforeObj = isPlainObject(before) ? before : {};
  const afterObj = isPlainObject(after) ? after : {};

  const topKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  for (const key of topKeys) {
    if (key === "projects") continue; // 아래에서 별도 처리(원문 경로 마스킹 필요).
    if (deepEqual(beforeObj[key], afterObj[key])) continue;
    changed.push(classify(key, MCP_ROOT_FORBIDDEN_KEYS.has(key), allowSet, key));
  }

  const beforeProjects = isPlainObject(beforeObj.projects) ? beforeObj.projects : {};
  const afterProjects = isPlainObject(afterObj.projects) ? afterObj.projects : {};
  const projectKeys = new Set([...Object.keys(beforeProjects), ...Object.keys(afterProjects)]);
  for (const projectPath of projectKeys) {
    const beforeEntry = beforeProjects[projectPath];
    const afterEntry = afterProjects[projectPath];
    if (deepEqual(beforeEntry, afterEntry)) continue;
    const hash = hashPath(projectPath).slice(0, 8);
    diffProjectEntry(
      hash,
      isPlainObject(beforeEntry) ? beforeEntry : {},
      isPlainObject(afterEntry) ? afterEntry : {},
      allowSet,
      changed,
    );
  }

  const violations = changed.filter((v) => v.status === "violation");
  const overallStatus: ClaudeJsonSemanticVerdict["overallStatus"] =
    violations.length > 0 ? "violation" : changed.length > 0 ? "allowed_churn" : "clean";

  return { changed, violations, overallStatus };
}

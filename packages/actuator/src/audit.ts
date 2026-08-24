import { readFileSync } from "node:fs";
import path from "node:path";
import { collectTree, type TreeCollectCache } from "@ctk/probe";
import {
  AC_2_7_C_FORBIDDEN_RULES,
  TIER2_CHURN_ALLOWLIST,
  claudeJsonSemanticVerdict,
  verdict as treeDiffVerdict,
  type AllowlistRule,
  type ClaudeJsonSemanticVerdict,
  type FileEntry,
  type TreeDiffVerdict,
} from "@ctk/core";

/**
 * ⚠️ **Step 5 보안 심사 수정(M5)** — 감사 위반은 이전엔 평문 `Error`로만 던져졌다.
 * `FailureClass`에 `whitelist_violation`·`forbidden_path_write`가 **선언만 되고 아무도 쓰지
 * 않는** 상태였다(security-reviewer 지적의 핵심 — "규칙이 선언만 되고 아무도 쓰지 않는다").
 * 이 두 타입 오류를 호출부(`cli/move.ts`)가 던지게 해, run-log/journal의 `failure_class`가
 * 실제로 이 값을 담게 한다.
 */
export class ForbiddenPathWriteError extends Error {
  readonly failureClass = "forbidden_path_write" as const;
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenPathWriteError";
  }
}

export class WhitelistViolationError extends Error {
  readonly failureClass = "whitelist_violation" as const;
  constructor(message: string) {
    super(message);
    this.name = "WhitelistViolationError";
  }
}

/**
 * 감사 결과를 타입 오류로 변환한다 — 위반 중 하나라도 금지 목록(AC_2_7_C_FORBIDDEN_RULES,
 * `matchedRule` 존재)에 걸렸으면 `forbidden_path_write`(최우선 경보), 아니면(허용목록에 없을
 * 뿐인 일반 위반) `whitelist_violation`이다. `auditPassed(result)`가 false일 때만 호출한다.
 */
export function auditFailureError(result: RootAuditResult, contextMessage: string): ForbiddenPathWriteError | WhitelistViolationError {
  const anyForbidden =
    result.verdict.violations.some((v) => v.matchedRule !== undefined) ||
    (result.claudeJsonSemantic?.violations.some((v) => v.mcpForbidden) ?? false);
  const detail = `${contextMessage}: ${JSON.stringify(result.verdict.violations)}${
    result.claudeJsonSemantic !== null && result.claudeJsonSemantic.overallStatus === "violation"
      ? ` / .claude.json 의미 위반: ${JSON.stringify(result.claudeJsonSemantic.violations)}`
      : ""
  }`;
  return anyForbidden ? new ForbiddenPathWriteError(detail) : new WhitelistViolationError(detail);
}

/**
 * actuator/src/audit.ts — `probe/tree-collect`로 전후 트리를 수집 → `core/guard/{tree-diff,
 * whitelist,forbidden}`에 넘겨 3검사 판정(AC-2.7-a/b/c). 판정 로직은 여기 없다(H1) — 수집과
 * 배선만 한다.
 *
 * **감사 루트는 액션당 최대 2개**(config·project) — 각각 독립적으로 `core/guard/tree-diff.verdict()`를
 * 1회씩 돌린다(단일 루트 판정기 설계를 그대로 재사용, 재구현하지 않는다). Tier-2 churn 허용은
 * **config 루트에만** 적용한다 — AC-0.8이 `plugin list/details/enable/disable`의 부수 효과를
 * 실측한 대상이 `$CLAUDE_CONFIG_DIR`뿐이었고(스파이크 결과 원문), 임의 프로젝트의 `.claude/`
 * 디렉터리에 같은 종류의 harness churn(`.claude.json`·`backups/*`·tmp)이 생긴다는 실측은 없다
 * — 없는 채로 project 루트에도 Tier-2를 적용하면 화이트리스트가 실측 근거 없이 넓어진다
 * (Pre-mortem H).
 *
 * `.claude.json`이 config 루트에서 Tier-2 churn으로 판정되면(바이트는 변경 허용), 추가로
 * **의미(JSON) diff**를 돈다(AC-2.7-c, F5) — `core/guard/claude-json-semantic.ts`. 실측
 * (Step 5, `claude plugin marketplace add`→`install`→`disable`→`enable`→`list --json` 실행
 * 조합, 격리 홈)으로는 최상위 키가 단 하나도 의미상 바뀌지 않았다(바이트만 바뀜 — 재포맷 추정) —
 * 그래서 기본 허용 churn 키 집합은 **빈 배열**이다. 새로 측정되지 않은 키가 바뀌면 그것은 churn이
 * 아니라 위반으로 판정한다(화이트리스트 방향, F5). `.claude.json`의 before **내용**은 쓰기 전에
 * 미리 읽어둬야 한다(쓰기 후에는 재구성 불가능) — 호출자가 `readClaudeJsonRawOrNull`로 액션
 * 시작 전에 캡처해 넘긴다.
 */

export const DEFAULT_CLAUDE_JSON_CHURN_KEYS: readonly string[] = [];

export interface AuditRootConfig {
  /** 감사 대상 절대경로 루트("config"='<config>' 자체, "project"='<project>/.claude'). */
  rootAbs: string;
  /** Tier-1(ctk 소유, 정확 일치) 허용 규칙 — 액션마다 동적으로 구성(예: settings.json, skills/<name>/**). */
  tier1: readonly AllowlistRule[];
  /** true면 이 루트에 TIER2_CHURN_ALLOWLIST를 추가 적용하고 `.claude.json` 의미 diff도 돈다. config 루트만 true. */
  allowTier2Churn: boolean;
}

export interface RootAuditSnapshot {
  entries: FileEntry[];
  /** M3 — 수집 중 읽기 실패 건수. 0보다 크면 이 스냅샷은 불완전한 관측이다. */
  collectErrors: number;
  symlinkCount: number;
  emptyDirCount: number;
  /** M10 — 이 수집에서 관측한 (size, mtimeMs, sha256). 다음 captureRootSnapshot 호출에 캐시로
   * 넘기면(예: after 캡처에 before의 cache를 넘긴다) 안 바뀐 파일은 재해시를 건너뛴다. */
  cache: TreeCollectCache;
}

/**
 * `cache`(M10, 선택)를 넘기면 이전 캡처에서 (size, mtimeMs)가 같았던 파일은 재해시를
 * 건너뛴다 — `ctk move` 1회가 큰 config 트리를 최소 2번(before·after) 전량 재해시하던 비용을
 * 줄인다. 호출자가 넘기지 않으면 항상 전량 재해시한다(옵트인, 기본 동작 불변).
 */
export function captureRootSnapshot(rootAbs: string, cache?: TreeCollectCache): RootAuditSnapshot {
  const result = collectTree(rootAbs, cache);
  return {
    entries: result.entries,
    collectErrors: result.errors,
    symlinkCount: result.symlinkCount,
    emptyDirCount: result.emptyDirCount,
    cache: result.cache,
  };
}

/** Node의 파일시스템 오류 코드만 조회한다(존재 여부와 "읽기 실패"를 구분하기 위해). */
function fsErrorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? (err as { code?: string }).code : undefined;
}

/**
 * M2 수정 — 이전에는 모든 오류(ENOENT뿐 아니라 EISDIR·EACCES 등)를 "파일 없음"으로 뭉갰다.
 * "없음"과 "읽기 실패"를 구분한다(CLAUDE.md 안전 원칙 5) — ENOENT만 null(정상적인 부재)로
 * 취급하고, 그 외 오류는 그대로 던진다.
 */
export function readClaudeJsonRawOrNull(rootAbs: string): string | null {
  try {
    return readFileSync(path.join(rootAbs, ".claude.json"), "utf8");
  } catch (err) {
    if (fsErrorCode(err) === "ENOENT") return null;
    throw err;
  }
}

export interface RootAuditResult {
  verdict: TreeDiffVerdict;
  /** config 루트에서 `.claude.json`이 churn으로 잡혔을 때만 채워진다. 그 외에는 null. */
  claudeJsonSemantic: ClaudeJsonSemanticVerdict | null;
  /** M3 — before/after 수집 중 **읽기 실패**가 있었으면 true. `auditPassed`가 무조건 실패로
   * 취급한다(fail-closed).
   *
   * ⚠️ **심볼릭 링크·빈 디렉터리 개수는 여기 포함하지 않는다(2026-08-24 주석 정정).** 이 주석은
   * 한때 포함한다고 적었으나 구현은 처음부터 제외했고, 그 제외가 의도된 설계다 — `actuator`는
   * 스킬 디렉터리 이동처럼 **정상 조치가** 디렉터리를 만들고 지우므로 개수 델타가 오탐이 된다
   * (아래 구현부 주석). 개수는 `RootAuditSnapshot`으로 반환만 하고 호출자가 판단한다.
   * `gen`은 config dir에 의도적으로 쓰는 파일이 없어 같은 신호를 fail-closed로 쓴다 —
   * 계층이 다르면 같은 신호의 의미도 다르다(gen/src/tree-audit.ts). */
  incompleteObservation: boolean;
}

function claudeJsonTouchedAsChurn(v: TreeDiffVerdict): boolean {
  const all = [...v.added, ...v.modified];
  return all.some((entry) => entry.path === ".claude.json" && entry.status === "allowed_churn");
}

/**
 * M2 수정 — 이전 구현(`readJsonOrEmpty`)은 "파일 없음"과 "파일이 있는데 깨졌다"를 똑같이
 * `{}`로 뭉갰다. before가 `{}`(부재)이고 after도 손상돼 `{}`로 읽히면 deep-equal이 성립해
 * **손상이 감사를 조용히 통과**했다(R7 시나리오 그 자체). ENOENT만 정상적인 부재로 취급하고,
 * 그 외(JSON 구문 오류 등)는 `WhitelistViolationError`로 던져 감사가 실패로 떨어지게 한다.
 */
function readJsonOrThrowOnCorruption(rootAbs: string): unknown {
  const raw = readClaudeJsonRawOrNull(rootAbs);
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new WhitelistViolationError(
      `${path.join(rootAbs, ".claude.json")} 파싱 실패(손상 의심) — 감사를 통과시키지 않는다: ${String(cause)}`,
    );
  }
}

/**
 * 한 루트를 판정한다. `claudeJsonBeforeRaw`는 config 루트에서만 의미가 있다(project 루트는
 * `allowTier2Churn:false`라 애초에 검사하지 않으므로 `null`을 넘기면 된다) — 액션 시작 **전에**
 * `readClaudeJsonRawOrNull(config.rootAbs)`로 미리 캡처해서 넘긴다.
 */
export function auditRoot(
  config: AuditRootConfig,
  before: RootAuditSnapshot,
  after: RootAuditSnapshot,
  claudeJsonBeforeRaw: string | null,
  claudeJsonAllowedChurnKeys: readonly string[] = DEFAULT_CLAUDE_JSON_CHURN_KEYS,
): RootAuditResult {
  const allowlist = config.allowTier2Churn ? [...config.tier1, ...TIER2_CHURN_ALLOWLIST] : config.tier1;
  const verdict = treeDiffVerdict(before.entries, after.entries, allowlist, AC_2_7_C_FORBIDDEN_RULES);

  let claudeJsonSemantic: ClaudeJsonSemanticVerdict | null = null;
  if (config.allowTier2Churn && claudeJsonTouchedAsChurn(verdict)) {
    const beforeValue = claudeJsonBeforeRaw !== null ? (JSON.parse(claudeJsonBeforeRaw) as unknown) : {};
    const afterValue = readJsonOrThrowOnCorruption(config.rootAbs);
    claudeJsonSemantic = claudeJsonSemanticVerdict(beforeValue, afterValue, claudeJsonAllowedChurnKeys);
  }

  // M3 — 수집 자체가 불완전했으면(읽기 실패) "변경 없음"으로 보여도 신뢰할 수 없다 —
  // fail-closed. 심볼릭 링크·빈 디렉터리 개수는 정보로 반환하되(RootAuditSnapshot), 정상적인
  // 조치도 디렉터리 생성/제거로 이 개수를 자연스럽게 바꾸므로(예: 스킬 디렉터리 이동이 목적지에
  // 새 디렉터리를 만듦) 개수 불일치 자체를 자동 위반으로 취급하지 않는다 — 호출자가 필요하면
  // 이 개수로 별도 판정을 내릴 수 있게 반환만 한다(과잉 차단으로 정상 조치를 막지 않는다).
  const incompleteObservation = before.collectErrors > 0 || after.collectErrors > 0;

  return { verdict, claudeJsonSemantic, incompleteObservation };
}

/** 감사 결과 전체가 위반 없이 통과했는가. `.claude.json` 의미 위반·불완전한 관측도 포함한다. */
export function auditPassed(result: RootAuditResult): boolean {
  if (result.incompleteObservation) return false;
  if (result.verdict.overallStatus === "violation") return false;
  if (result.claudeJsonSemantic !== null && result.claudeJsonSemantic.overallStatus === "violation") return false;
  return true;
}

/** 두 루트(config·project) 감사 결과 전부가 통과했는가. project는 없을 수 있다(예: user→user 이동 없음). */
export function auditAllPassed(results: readonly RootAuditResult[]): boolean {
  return results.every(auditPassed);
}

import { readFileSync } from "node:fs";
import path from "node:path";
import { collectTree } from "@ctk/probe";
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
}

export function captureRootSnapshot(rootAbs: string): RootAuditSnapshot {
  return { entries: collectTree(rootAbs).entries };
}

export function readClaudeJsonRawOrNull(rootAbs: string): string | null {
  try {
    return readFileSync(path.join(rootAbs, ".claude.json"), "utf8");
  } catch {
    return null;
  }
}

export interface RootAuditResult {
  verdict: TreeDiffVerdict;
  /** config 루트에서 `.claude.json`이 churn으로 잡혔을 때만 채워진다. 그 외에는 null. */
  claudeJsonSemantic: ClaudeJsonSemanticVerdict | null;
}

function claudeJsonTouchedAsChurn(v: TreeDiffVerdict): boolean {
  const all = [...v.added, ...v.modified];
  return all.some((entry) => entry.path === ".claude.json" && entry.status === "allowed_churn");
}

function readJsonOrEmpty(absPath: string): unknown {
  try {
    return JSON.parse(readFileSync(absPath, "utf8")) as unknown;
  } catch {
    return {};
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
    const afterValue = readJsonOrEmpty(path.join(config.rootAbs, ".claude.json"));
    claudeJsonSemantic = claudeJsonSemanticVerdict(beforeValue, afterValue, claudeJsonAllowedChurnKeys);
  }

  return { verdict, claudeJsonSemantic };
}

/** 감사 결과 전체가 위반 없이 통과했는가. `.claude.json` 의미 위반도 포함한다. */
export function auditPassed(result: RootAuditResult): boolean {
  if (result.verdict.overallStatus === "violation") return false;
  if (result.claudeJsonSemantic !== null && result.claudeJsonSemantic.overallStatus === "violation") return false;
  return true;
}

/** 두 루트(config·project) 감사 결과 전부가 통과했는가. project는 없을 수 있다(예: user→user 이동 없음). */
export function auditAllPassed(results: readonly RootAuditResult[]): boolean {
  return results.every(auditPassed);
}

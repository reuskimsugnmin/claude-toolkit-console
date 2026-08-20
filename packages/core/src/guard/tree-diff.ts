import type { AllowlistRule } from "./whitelist.js";
import { matchesAllowlist } from "./whitelist.js";
import type { ForbiddenRule } from "./forbidden.js";
import { matchesForbidden, FORBIDDEN_RULES } from "./forbidden.js";

/**
 * ⚠️ 착수 조건 C2 (유일한 gen 영향 — plan §4.0/Step 1).
 *
 * 이 파일은 트리 diff 판정기(순수 함수)다. **"어느 홈이냐"를 알아서는 안 된다.** 기대 baseline
 * ("변경 0건"인지 "Tier-2 churn 허용"인지)은 오직 호출자가 넘기는 `allowlist`/`forbidden`으로만
 * 표현된다 — 판정기 소스에 CTK_HOME·CLAUDE_CONFIG_DIR·"실제 홈" 같은 홈 식별 리터럴이 있으면 안
 * 된다(eslint.config.js의 `ctk/no-home-literals`가 packages/core/src/guard/**에서 이를 강제한다).
 *
 * `sealed-live` 세션은 실제 config dir에 churn을 남긴다(R16). "실제 홈 = 변경 0건"을 여기 하드코딩
 * 하면 Step 4(gen)에서 판정기를 다시 써야 한다 — 그래서 baseline은 파라미터다:
 *   - test-isolated 프로파일 판정: `verdict(before, after, [])` (빈 allowlist = 변경 0건 기대)
 *   - sealed-live 프로파일 판정: `verdict(before, after, TIER2_CHURN_ALLOWLIST)`
 */

export interface FileEntry {
  /** allowlist/forbidden 판정 대상 상대경로. 호출자가 이미 config dir 루트 기준으로 상대화해서 넘긴다 */
  path: string;
  sha256: string;
}

export type PathVerdictStatus = "allowed_churn" | "violation" | "tmp_leftover";

export interface PathVerdict {
  path: string;
  status: PathVerdictStatus;
  matchedRule?: string;
}

export interface TreeDiffVerdict {
  added: PathVerdict[];
  removed: PathVerdict[];
  modified: PathVerdict[];
  overallStatus: "clean" | "allowed_churn" | "violation";
  violations: PathVerdict[];
  /** 종료 후에도 잔존한 tmp 파일. churn이 아니라 별도 분류 (착수 조건 C3) */
  tmpLeftover: PathVerdict[];
}

export interface DuplicatePathEntry {
  path: string;
  list: "before" | "after";
}

/**
 * 입력(`before`/`after`)에 동일 경로가 2회 이상 등장할 때 던진다 — test-engineer가 실측으로
 * 발견한 갭(A3)의 수정: `Map` 구성으로 마지막 항목만 채택하고 앞선 항목이 아무 흔적 없이 사라지는
 * silent last-write-wins를 허용하지 않는다. 중복은 수집 버그의 신호이고(symlink 이중 목록·수집
 * 레이스 등), 조용히 하나를 채택하면 판정이 왜곡된다 — P2("판정 불가는 추정으로 채우지 않는다")에
 * 따라 verdict()는 판정을 내리는 대신 거부한다. 호출자(probe/tree-collect.ts 등)는 이 오류를
 * `failure_class: "duplicate_path_input"`으로 기록해야 한다.
 */
export class DuplicatePathVerdictError extends Error {
  readonly failureClass = "duplicate_path_input" as const;
  readonly duplicates: readonly DuplicatePathEntry[];

  constructor(duplicates: readonly DuplicatePathEntry[]) {
    super(
      `verdict()는 중복 경로 입력을 판정 불가로 거부한다 (failure_class: duplicate_path_input): ` +
        duplicates.map((d) => `${d.list}:${d.path}`).join(", "),
    );
    this.name = "DuplicatePathVerdictError";
    this.duplicates = duplicates;
  }
}

function findDuplicatePaths(entries: readonly FileEntry[], list: "before" | "after"): DuplicatePathEntry[] {
  const seen = new Set<string>();
  const duplicates: DuplicatePathEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      duplicates.push({ path: entry.path, list });
    } else {
      seen.add(entry.path);
    }
  }
  return duplicates;
}

/** Tier-2 tmp 임시파일 정규식과 동형 — "여전히 after에 남아있다"는 판단에만 쓴다(잔존 분류). */
const TMP_LEFTOVER_PATTERN = /\.tmp\.\d+\.[A-Za-z0-9]+$/;

function judgePath(
  relPath: string,
  allowlist: readonly AllowlistRule[],
  forbidden: readonly ForbiddenRule[],
  isPresentAfter: boolean,
): PathVerdict {
  const forbiddenMatch = matchesForbidden(relPath, forbidden);
  if (forbiddenMatch) {
    return { path: relPath, status: "violation", matchedRule: forbiddenMatch.note };
  }
  const allowMatch = matchesAllowlist(relPath, allowlist);
  if (!allowMatch) {
    return { path: relPath, status: "violation" };
  }
  if (isPresentAfter && TMP_LEFTOVER_PATTERN.test(relPath)) {
    // after 스냅샷 시점에도 tmp가 존재 = rename으로 정리되지 않고 남았다 → 잔존물 (churn 아님)
    return { path: relPath, status: "tmp_leftover", matchedRule: allowMatch.note };
  }
  return { path: relPath, status: "allowed_churn", matchedRule: allowMatch.note };
}

/**
 * 트리 diff 판정. `(diff, allowlist, forbidden) → verdict` 순수 함수 (착수 조건 C2).
 */
export function verdict(
  before: readonly FileEntry[],
  after: readonly FileEntry[],
  allowlist: readonly AllowlistRule[],
  forbidden: readonly ForbiddenRule[] = FORBIDDEN_RULES,
): TreeDiffVerdict {
  const duplicates = [...findDuplicatePaths(before, "before"), ...findDuplicatePaths(after, "after")];
  if (duplicates.length > 0) {
    throw new DuplicatePathVerdictError(duplicates);
  }

  const beforeMap = new Map(before.map((e) => [e.path, e.sha256]));
  const afterMap = new Map(after.map((e) => [e.path, e.sha256]));

  const added: PathVerdict[] = [];
  for (const path of afterMap.keys()) {
    if (!beforeMap.has(path)) added.push(judgePath(path, allowlist, forbidden, true));
  }

  const removed: PathVerdict[] = [];
  for (const path of beforeMap.keys()) {
    if (!afterMap.has(path)) removed.push(judgePath(path, allowlist, forbidden, false));
  }

  const modified: PathVerdict[] = [];
  for (const [path, beforeSha] of beforeMap) {
    const afterSha = afterMap.get(path);
    if (afterSha !== undefined && afterSha !== beforeSha) {
      modified.push(judgePath(path, allowlist, forbidden, true));
    }
  }

  const all = [...added, ...removed, ...modified];
  const violations = all.filter((v) => v.status === "violation");
  const tmpLeftover = all.filter((v) => v.status === "tmp_leftover");
  const overallStatus: TreeDiffVerdict["overallStatus"] =
    violations.length > 0 ? "violation" : all.length > 0 ? "allowed_churn" : "clean";

  return { added, removed, modified, overallStatus, violations, tmpLeftover };
}

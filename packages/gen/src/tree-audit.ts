import { readFileSync } from "node:fs";
import path from "node:path";
import { collectTree, type TreeCollectCache } from "@ctk/probe";
import {
  claudeJsonSemanticVerdict,
  matchesAllowlist,
  matchesForbidden,
  SEALED_LIVE_CLAUDE_JSON_ALLOWED_CHURN_KEYS,
  SESSION_OWNED_NOT_ATTRIBUTABLE,
  type SessionOwnedRule,
  TIER2_CHURN_ALLOWLIST_SEALED_LIVE,
  verdict as treeDiffVerdict,
  type ClaudeJsonSemanticVerdict,
  type FileEntry,
  type TreeDiffVerdict,
} from "@ctk/core";

/**
 * gen/src/tree-audit.ts — AC-3.7 "gen 실행 전후 config 트리 diff". `gen`은 `actuator`를 import할
 * 수 없으므로(계층 lint) `actuator/src/audit.ts`를 재사용하지 않는다 — 판정기(`core/guard/*`)와
 * 수집기(`probe/tree-collect.ts`)는 공유하되, 배선은 여기서 gen 전용으로 새로 한다(H1: "판정기가
 * core에 있어야 이 AC가 구현 가능하다"는 요구가 바로 이 상황을 가리킨다).
 *
 * `actuator`의 감사와 다른 점: gen은 config 루트 **하나**만 본다(프로젝트 루트를 건드리지
 * 않는다), Tier1(ctk 소유 정확 일치)가 없다 — gen은 config dir에 **의도적으로 쓰는 파일이
 * 하나도 없다**(전부 `claude` 서브프로세스의 부수효과일 뿐이다). 그래서 허용목록은 항상
 * `TIER2_CHURN_ALLOWLIST_SEALED_LIVE`(AC-0.11 실측) 하나뿐이다.
 */

export interface ConfigDirSnapshot {
  entries: FileEntry[];
  collectErrors: number;
  /** 파일 목록에 나타나지 않는 변경을 잡기 위한 개수. `gen`은 이 둘을 **판정에 쓴다**(아래). */
  symlinkCount: number;
  emptyDirCount: number;
  cache: TreeCollectCache;
}

export function captureConfigDirSnapshot(configDirAbs: string, cache?: TreeCollectCache): ConfigDirSnapshot {
  const result = collectTree(configDirAbs, cache);
  return {
    entries: result.entries,
    collectErrors: result.errors,
    symlinkCount: result.symlinkCount,
    emptyDirCount: result.emptyDirCount,
    cache: result.cache,
  };
}

function fsErrorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? (err as { code?: string }).code : undefined;
}

export function readClaudeJsonRawOrNull(configDirAbs: string): string | null {
  try {
    return readFileSync(path.join(configDirAbs, ".claude.json"), "utf8");
  } catch (err) {
    if (fsErrorCode(err) === "ENOENT") return null;
    throw err;
  }
}

export interface SealedLiveAuditResult {
  verdict: TreeDiffVerdict;
  claudeJsonSemantic: ClaudeJsonSemanticVerdict | null;
  incompleteObservation: boolean;
  /**
   * `incompleteObservation`의 **사유**. 진단 없는 fail-closed는 사용자를 가드 우회로 몬다
   * (안전 원칙 6). 비어 있으면 관측은 완전했다는 뜻이다.
   */
  incompleteObservationReasons: string[];
  /**
   * 판정에서 제외된 **다른 세션 소유** 경로 중 **실제로 달라진 것**만. 조용히 지우지 않고
   * 여기 실어 보낸다 — 제외가 실제로 일어났는지를 호출자와 로그가 볼 수 있어야 한다.
   *
   * ⚠️ **"제외 대상으로 매치된 파일 수"가 아니다.** 첫 구현이 그렇게 셌더니 569건이 나왔는데,
   * 그건 "이 머신에 과거 세션 트랜스크립트가 569개 있다"는 뜻일 뿐 이번 실행과 무관했다 —
   * 숫자는 맞는데 진단으로는 쓸모가 없었다(안전 원칙 8과 같은 형태). 창(window) 안에서
   * 추가·수정·삭제된 것만 센다.
   */
  sessionOwnedExcluded: string[];
  /**
   * 다른 세션 churn이 관측됐는데 `allowConcurrentSessions`로 위반을 경고로 낮췄는지 여부.
   * 낮췄다면 **이번 실행의 config 감사는 사실상 무력**이므로 호출자가 반드시 크게 알려야 한다.
   */
  concurrencyOverrideApplied: boolean;
}

/**
 * 다른 세션이 소유한 경로를 스냅샷 양쪽에서 걷어낸다.
 *
 * ⚠️ **양쪽에서 똑같이 걷어내야 한다.** 한쪽만 걸러내면 그 파일이 통째로 "추가됨" 또는
 * "삭제됨"으로 나타나 오히려 새 위반을 만든다.
 */
/**
 * 경로에서 세션 uuid를 뽑는다 — 세션 이름 공간에 속하지 않으면 `undefined`.
 *
 * ⚠️ **forbidden을 먼저 통과시킨다(보안 재심 M1).** `core/guard/tree-diff.ts`의 `judgePath`는
 * forbidden을 어떤 allowlist보다 **먼저** 판정하도록 설계돼 있는데, 이 제외는 `verdict()`
 * **이전에** 항목을 없애므로 그 순서를 뒤집을 수 있다. forbidden에 걸리는 경로는 절대
 * 제외하지 않아 최후 방어선을 그대로 둔다 — 현재 수집기로는 `..`가 세그먼트로 나올 수 없지만,
 * forbidden 계층은 정확히 "수집기가 틀렸을 때"를 위한 것이다.
 */
function sessionOwnedRuleOf(relativePath: string): SessionOwnedRule | undefined {
  if (matchesForbidden(relativePath) !== undefined) return undefined;
  return matchesAllowlist(relativePath, SESSION_OWNED_NOT_ATTRIBUTABLE);
}

/**
 * 경로에서 세션 uuid를 뽑는다 — `path_uuid` 축의 규칙에만 해당한다.
 *
 * ⚠️ **`undefined`가 "세션 소유가 아니다"를 뜻하지 않는다(2026-08-26).** 예전에는 이 함수
 * 하나가 두 질문("세션 소유인가" · "어느 세션인가")에 동시에 답했고, 그래서 경로에 uuid가
 * 없는 등재 항목(`.session-stats.json`)이 **등재돼 있는데도 한 번도 제외되지 못했다.**
 * 두 질문을 갈라 놓는다 — 소속은 `sessionOwnedRuleOf`가, 신원은 여기가 답한다.
 */
function sessionUuidOf(relativePath: string): string | undefined {
  const rule = sessionOwnedRuleOf(relativePath);
  if (rule === undefined || rule.attribution !== "path_uuid") return undefined;
  return /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(relativePath)?.[1];
}

/**
 * 제외 가능한 경로인지 판정한다.
 *
 * ⚠️ **경로 모양만으로는 부족하다(보안 재심 H1).** 실측이 보여준 현상은 전부 `before`에 이미
 * 있던 파일의 **수정·삭제**였다. 그런데 그 모양의 파일이 **새로 생기는 것**은 전혀 다른
 * 사건이다 — 봉인 안에서 `hooks/state/<uuid>.start`가 새로 생겼다면 훅이 **실행**된 것이고,
 * `projects/<봉인 cwd>/<uuid>.jsonl`이 새로 생겼다면 자식이 세션을 **영속**한 것이다. 둘 다
 * 봉인 파손의 1차 신호이므로 제외하면 안 된다.
 *
 * 그래서 **`before`에서 이미 관측된 세션 uuid**에만 귀속 불가를 인정한다. 부모가 대화를 이어
 * 쓰는 경우는 그 uuid가 이미 `before`에 있고, 새 uuid는 위반으로 남는다.
 */
function makeExcludableCheck(
  before: readonly FileEntry[],
  after: readonly FileEntry[],
): (relativePath: string) => boolean {
  const knownSessions = new Set<string>();
  for (const e of before) {
    const uuid = sessionUuidOf(e.path);
    if (uuid !== undefined) knownSessions.add(uuid);
  }
  const beforePaths = new Set(before.map((e) => e.path));
  const afterPaths = new Set(after.map((e) => e.path));
  return (relativePath) => {
    const rule = sessionOwnedRuleOf(relativePath);
    if (rule === undefined) return false;
    switch (rule.attribution) {
      case "path_uuid": {
        const uuid = sessionUuidOf(relativePath);
        return uuid !== undefined && knownSessions.has(uuid);
      }
      case "preexisting_file":
        // **양쪽에 있을 때의 수정만** 인정한다. 신규 생성은 자식이 쓴 것이고(H1), 삭제도
        // 정상 동작이 아니다 — 어느 쪽이든 제외하지 않아 위반으로 남는다.
        return beforePaths.has(relativePath) && afterPaths.has(relativePath);
    }
  };
}

function stripSessionOwned(
  entries: readonly FileEntry[],
  isExcludable: (relativePath: string) => boolean,
): { kept: FileEntry[]; excluded: Map<string, string> } {
  const kept: FileEntry[] = [];
  const excluded = new Map<string, string>();
  for (const entry of entries) {
    if (isExcludable(entry.path)) {
      excluded.set(entry.path, entry.sha256);
      continue;
    }
    kept.push(entry);
  }
  return { kept, excluded };
}

/** 제외된 것 중 **실제로 달라진** 경로만 — 존재만 하고 그대로인 파일은 진단이 아니다. */
function changedAmongExcluded(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [p, sha] of before) if (after.get(p) !== sha) changed.add(p);
  for (const [p, sha] of after) if (before.get(p) !== sha) changed.add(p);
  return [...changed].sort();
}

/**
 * 제외된 트랜스크립트가 **append로만 자랐는지** 확인한다(보안 재심 H1 후단).
 *
 * 부모가 대화를 이어 쓰는 것은 append다. 자식이 기존 파일을 **덮어쓰는** 것은 경로만으로는
 * 구분되지 않지만 **크기가 줄면 append가 아니다.** `collectTree`의 캐시가 이미 `size`를 들고
 * 있어 추가 I/O 없이 검사된다. 줄어든 경로는 제외하지 않고 위반으로 되돌린다.
 */
function nonAppendPaths(
  configDirAbs: string,
  beforeCache: TreeCollectCache,
  afterCache: TreeCollectCache,
  excludedPaths: readonly string[],
): Set<string> {
  const shrunk = new Set<string>();
  for (const rel of excludedPaths) {
    // ⚠️ **append 규칙은 `path_uuid` 축(트랜스크립트)의 성질이다.** 하네스가 통째로 다시 쓰는
    // 파일에 적용하면 정상 동작이 위반이 된다 — 같은 판정 함수를 두 축이 쓸 때는 각 축에서
    // 그 규칙이 여전히 옳은지 따로 물어야 한다(CLAUDE.md).
    //
    // **`switch`로 쓴다(2026-08-26 재심 L2).** `!== "path_uuid"` 한 줄이면 세 번째 축이 생겼을 때
    // 아무도 결정하지 않은 채 **조용히 면제**된다. `makeExcludableCheck`는 이미 축이 늘면
    // 컴파일이 깨지는데 여기만 default-open이면 두 자리 중 한 자리만 고정한 꼴이다.
    const rule = sessionOwnedRuleOf(rel);
    if (rule === undefined) continue;
    const appendChecked = ((): boolean => {
      switch (rule.attribution) {
        case "path_uuid":
          return true; // 트랜스크립트 — append로만 자란다
        case "preexisting_file":
          return false; // 하네스가 통째로 다시 쓴다 — 줄어드는 것이 정상이다
      }
    })();
    if (!appendChecked) continue;
    const abs = path.join(configDirAbs, rel);
    const b = beforeCache.get(abs);
    const a = afterCache.get(abs);
    if (b === undefined || a === undefined) continue; // 한쪽에만 있으면 추가·삭제 — 크기 비교 대상이 아니다
    if (a.size < b.size) shrunk.add(rel);
  }
  return shrunk;
}

function claudeJsonTouchedAsChurn(v: TreeDiffVerdict): boolean {
  const all = [...v.added, ...v.modified];
  return all.some((entry) => entry.path === ".claude.json" && entry.status === "allowed_churn");
}

function readJsonOrThrow(configDirAbs: string): unknown {
  const raw = readClaudeJsonRawOrNull(configDirAbs);
  if (raw === null) return {};
  return JSON.parse(raw) as unknown;
}

/**
 * `sealed-live` 세션 1회(또는 배치) 전후의 실제 `CLAUDE_CONFIG_DIR` 스냅샷을 판정한다.
 * baseline은 항상 `TIER2_CHURN_ALLOWLIST_SEALED_LIVE`다(C2 — "실제 홈 변경 0건"이 아니라
 * 허용목록 기준).
 */
export interface SealedLiveAuditOptions {
  /**
   * **명시적 옵트아웃.** 살아 있는 다른 Claude Code 세션이 config dir에 쓰는 churn을 위반으로
   * 보지 않는다.
   *
   * ⚠️ **이 플래그를 켜면 이번 실행의 config 감사는 사실상 무력하다.** 자식이 config dir을
   * 바꿔도 잡히지 않는다. 봉인의 다른 층(env 화이트리스트 · `--safe-mode` · `--tools ""` ·
   * 인젝션 후검증 · 프롬프트 봉투)은 그대로 살아 있지만, "자식이 실제로 무엇을 썼나"라는
   * 마지막 확인은 사라진다.
   *
   * **왜 열거로 대신할 수 없나(2026-08-24 실측).** config dir에 쓰는 주체는 하네스만이 아니다 —
   * 설치된 **서드파티 플러그인의 훅**도 임의 경로에 쓴다(관측 사례: 어떤 보안 플러그인이 매
   * PostToolUse마다 자기 로그 파일을 갱신). 그 경로는 사용자마다 다르므로 제품 코드에 열거할
   * 수 없고, 열거하려 들면 개인 환경 정보를 저장소에 박게 된다.
   *
   * 기본값은 `false`다 — fail-closed를 기본으로 두고, 위험을 아는 사용자만 명시로 켠다.
   */
  allowConcurrentSessions?: boolean;
}

export function auditSealedLiveConfigDir(
  configDirAbs: string,
  before: ConfigDirSnapshot,
  after: ConfigDirSnapshot,
  claudeJsonBeforeRaw: string | null,
  options: SealedLiveAuditOptions = {},
): SealedLiveAuditResult {
  // 다른 세션이 소유한 경로는 **판정 이전에** 양쪽에서 걷어낸다 — 자식에게 귀속할 수 없는
  // 변경을 자식의 위반으로 보고하지 않기 위해서다(2026-08-24 실측, core/guard/whitelist.ts).
  const isExcludable = makeExcludableCheck(before.entries, after.entries);
  const beforeProbe = stripSessionOwned(before.entries, isExcludable);
  const afterProbe = stripSessionOwned(after.entries, isExcludable);
  // append가 아닌(크기가 줄어든) 경로는 제외에서 되돌린다 — 덮어쓰기를 눈감지 않는다.
  const shrunk = nonAppendPaths(
    configDirAbs,
    before.cache,
    after.cache,
    changedAmongExcluded(beforeProbe.excluded, afterProbe.excluded),
  );
  const finalExcludable = (rel: string): boolean => isExcludable(rel) && !shrunk.has(rel);
  const beforeFiltered = stripSessionOwned(before.entries, finalExcludable);
  const afterFiltered = stripSessionOwned(after.entries, finalExcludable);
  const sessionOwnedExcluded = changedAmongExcluded(beforeFiltered.excluded, afterFiltered.excluded);

  const verdict = treeDiffVerdict(beforeFiltered.kept, afterFiltered.kept, TIER2_CHURN_ALLOWLIST_SEALED_LIVE);

  let claudeJsonSemantic: ClaudeJsonSemanticVerdict | null = null;
  if (claudeJsonTouchedAsChurn(verdict)) {
    const beforeValue = claudeJsonBeforeRaw !== null ? (JSON.parse(claudeJsonBeforeRaw) as unknown) : {};
    const afterValue = readJsonOrThrow(configDirAbs);
    claudeJsonSemantic = claudeJsonSemanticVerdict(beforeValue, afterValue, SEALED_LIVE_CLAUDE_JSON_ALLOWED_CHURN_KEYS);
  }

  // ⚠️ **개수 델타를 fail-closed로 승격한다(보안 재심 M5).** `collectTree`는 심볼릭 링크를
  // 따라가지 않고 `entries`에서 빼므로, 자식이 `skills/x/SKILL.md`를 **링크로** 심으면 파일
  // 목록에는 아무 변화가 없다. `gen`은 config dir에 **의도적으로 쓰는 파일이 하나도 없으므로**
  // (이 파일 머리 주석) 개수가 달라졌다는 것 자체가 신호다.
  //
  // `actuator`는 같은 판단을 하지 않는다 — 그쪽은 스킬 디렉터리 이동처럼 **정상 조치가**
  // 디렉터리를 만들고 지우므로 개수 델타가 오탐이 된다(actuator/src/audit.ts의 의도된 설계).
  // 계층이 다르면 같은 신호의 의미도 다르다.
  const incompleteObservationReasons: string[] = [];
  if (before.collectErrors > 0 || after.collectErrors > 0) {
    incompleteObservationReasons.push(`collect_errors(before=${before.collectErrors},after=${after.collectErrors})`);
  }
  if (before.symlinkCount !== after.symlinkCount) {
    incompleteObservationReasons.push(`symlink_count(${before.symlinkCount}→${after.symlinkCount})`);
  }
  // ⚠️ **`emptyDirCount`는 여기 넣지 않는다.** 보안 재심은 두 개수를 함께 승격하라고 했지만,
  // 그대로 넣었더니 **정상 churn이 위반이 됐다** — 허용된 `sessions/<pid>.json`을 만들면 그
  // 디렉터리가 새로 생기며 개수가 변한다(테스트 3건이 이 오탐으로 깨졌다).
  // 둘은 성격이 다르다: **심볼릭 링크는 파일을 `entries`에서 숨기지만**(그게 공격 경로다)
  // **빈 디렉터리는 아무것도 숨기지 않는다.** 개수는 진단용으로만 스냅샷에 남긴다.
  const incompleteObservation = incompleteObservationReasons.length > 0;
  // 옵트아웃은 **위반이 실제로 있을 때만** "적용됐다"고 기록한다 — 켜 두기만 하고 아무것도
  // 낮추지 않은 실행까지 "감사 무력"으로 표시하면 진짜 위험한 실행이 그 잡음에 묻힌다.
  const hasViolation = verdict.overallStatus === "violation";
  const concurrencyOverrideApplied = options.allowConcurrentSessions === true && hasViolation;
  return {
    verdict,
    claudeJsonSemantic,
    incompleteObservation,
    incompleteObservationReasons,
    sessionOwnedExcluded,
    concurrencyOverrideApplied,
  };
}

export function sealedLiveAuditPassed(result: SealedLiveAuditResult): boolean {
  // ⚠️ 불완전한 관측은 옵트아웃으로도 통과시키지 않는다. `--allow-concurrent-sessions`가
  // 무르게 하는 것은 **"누가 썼는지 모른다"**이지 **"관측 자체가 실패했다"**가 아니다 —
  // 둘은 다른 상태이고, 후자를 통과시키면 아무것도 보지 못한 실행이 통과로 기록된다.
  if (result.incompleteObservation) return false;
  if (result.verdict.overallStatus === "violation" && !result.concurrencyOverrideApplied) return false;
  if (result.claudeJsonSemantic !== null && result.claudeJsonSemantic.overallStatus === "violation") return false;
  return true;
}

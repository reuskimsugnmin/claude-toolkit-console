import { exitCodeContribution, type AssetOutcome, type ResolveResult } from "./resolve.js";

/**
 * 갈래별 요약 (B4-c · D-2 · D-5).
 *
 * ⚠️ **값을 갈라 놓고 요약이 뭉개면 갈랐다는 사실이 사라진다.** 이 저장소의 R12가 정확히
 * 그 형태였다 — 인덱스는 `policy_blocked`로 갈랐는데 화면은 `stale`이라 말해 **재시도 루프를
 * 끊어 놓고도 사용자에게 재시도를 권했다.** 여기서는 6갈래를 각각, `no_description`의 두 하위축을
 * 각각, 무부모 행 수를 따로 낸다.
 *
 * ⚠️ **합이 입력 건수와 같은지 검사한다.** 개별 카운터만 단언하면 "어디에도 안 잡힘"이 통과한다.
 */

export interface OutcomeSummary {
  readonly total: number;
  readonly resolved: number;
  readonly noCatalog: number;
  readonly indexCorrupted: number;
  readonly notInstalled: number;
  readonly noDescription: number;
  /** `no_description`의 하위축 — 합치면 "설명이 사라진 회귀"와 "원래 없던 자산"을 구분할 수 없다. */
  readonly noDescriptionEmptyString: number;
  readonly noDescriptionFieldAbsent: number;
  readonly ambiguous: number;
  /** 색인에 못 들어간 무부모 행 수. 카탈로그가 없으면 `null` — **0이 아니다.** */
  readonly parentlessRows: number | null;
  /** 자산 전체의 max로 접은 종료 코드. */
  readonly exitCode: 0 | 1 | 2 | 3;
}

export function summarizeOutcomes(result: ResolveResult): OutcomeSummary {
  const counts = {
    resolved: 0,
    noCatalog: 0,
    indexCorrupted: 0,
    notInstalled: 0,
    noDescriptionEmptyString: 0,
    noDescriptionFieldAbsent: 0,
    ambiguous: 0,
  };

  let exitCode: 0 | 1 | 2 | 3 = 0;
  for (const outcome of result.outcomes) {
    bump(counts, outcome);
    const contribution = exitCodeContribution(outcome);
    if (contribution > exitCode) exitCode = contribution;
  }

  const noDescription = counts.noDescriptionEmptyString + counts.noDescriptionFieldAbsent;
  return {
    total: result.outcomes.length,
    resolved: counts.resolved,
    noCatalog: counts.noCatalog,
    indexCorrupted: counts.indexCorrupted,
    notInstalled: counts.notInstalled,
    noDescription,
    noDescriptionEmptyString: counts.noDescriptionEmptyString,
    noDescriptionFieldAbsent: counts.noDescriptionFieldAbsent,
    ambiguous: counts.ambiguous,
    parentlessRows: result.parentlessRows,
    exitCode,
  };
}

/** `switch`가 exhaustive라 **갈래가 늘면 컴파일이 깨진다** — 새 갈래가 어디에도 안 잡히는 일이 없다. */
function bump(counts: Record<string, number>, outcome: AssetOutcome): void {
  switch (outcome.tag) {
    case "resolved":
      counts.resolved = (counts.resolved ?? 0) + 1;
      return;
    case "no_catalog":
      counts.noCatalog = (counts.noCatalog ?? 0) + 1;
      return;
    case "index_corrupted":
      counts.indexCorrupted = (counts.indexCorrupted ?? 0) + 1;
      return;
    case "not_installed":
      counts.notInstalled = (counts.notInstalled ?? 0) + 1;
      return;
    case "no_description":
      if (outcome.reason === "empty_string") {
        counts.noDescriptionEmptyString = (counts.noDescriptionEmptyString ?? 0) + 1;
      } else {
        counts.noDescriptionFieldAbsent = (counts.noDescriptionFieldAbsent ?? 0) + 1;
      }
      return;
    case "ambiguous":
      counts.ambiguous = (counts.ambiguous ?? 0) + 1;
      return;
    default: {
      const exhaustive: never = outcome;
      void exhaustive;
    }
  }
}

/**
 * 사람이 읽는 한 줄. **미측정을 "0"으로 보이게 만들지 않는다** — 카탈로그가 없으면 갈래별 숫자
 * 대신 그 사실을 먼저 말한다(21건이 전부 `no_catalog`인 것을 "미설치 21건"처럼 읽히게 두지 않는다).
 */
export function formatSummary(summary: OutcomeSummary): string {
  if (summary.noCatalog === summary.total && summary.total > 0) {
    return `미측정 — 카탈로그가 없다(자산 ${summary.total}건 전부). \`ctk scan\`을 먼저 돌린다`;
  }
  if (summary.indexCorrupted === summary.total && summary.total > 0) {
    return `미측정 — 카탈로그 인덱스가 손상됐다(자산 ${summary.total}건 전부)`;
  }

  const parts = [
    `자산 ${summary.total}건`,
    `해석됨 ${summary.resolved}`,
    `미설치 ${summary.notInstalled}`,
    `설명없음 ${summary.noDescription}(빈문자열 ${summary.noDescriptionEmptyString} · 필드부재 ${summary.noDescriptionFieldAbsent})`,
    `판정불가 ${summary.ambiguous}`,
  ];
  if (summary.noCatalog > 0) parts.push(`카탈로그없음 ${summary.noCatalog}`);
  if (summary.indexCorrupted > 0) parts.push(`인덱스손상 ${summary.indexCorrupted}`);
  parts.push(
    summary.parentlessRows === null
      ? "무부모 행 미측정"
      : `무부모 행 ${summary.parentlessRows}(색인 밖 — 동명 독립 자산은 보이지 않는다)`,
  );
  return parts.join(" · ");
}

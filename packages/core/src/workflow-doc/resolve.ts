import { buildTupleIndex, lookupCandidates, type IndexRowForLookup, type TupleIndex } from "./index-3tuple.js";
import { lookupKeyFor } from "./exceptions.js";
import type { AssetRef } from "./table-locate.js";

/**
 * 자산 참조 → 6갈래 판별 유니온 (B4-c · D-2 · D-5).
 *
 * ⚠️ **"붙었나"를 `boolean`이나 `string | null`로 뭉개지 않는다.** 이 저장소는 그 형태로 두 번
 * 값을 치렀다 — `empty: boolean` 하나가 다섯 갈래를 뭉갰고, `string | null`이 "목록에 없다"와
 * "안전하지 않다"를 뭉개 **거부를 드리프트 조사로 돌려보냈다.**
 *
 * `core`는 I/O를 하지 않는다 — 카탈로그 상태와 설명 조회는 **주입**받는다.
 */

/** 카탈로그 자체의 상태. **"없음"과 "실패"를 합치지 않는다** — 상류(`readCatalogIndexOrNull`)가
 * 이미 `{index, corrupted}`로 갈라 주는데 하류가 뭉개면 상류가 애써 가른 것을 지운다. */
export type CatalogState =
  | { readonly kind: "available"; readonly rows: readonly IndexRowForLookup[] }
  | { readonly kind: "absent" }
  | { readonly kind: "corrupted" };

/** 설명 조회 결과. `""`(값이 비었다)와 필드 부재는 **다른 사건**이다(D-2). */
export type DescriptionLookup =
  | { readonly kind: "found"; readonly description: string }
  | { readonly kind: "empty_string" }
  | { readonly kind: "field_absent" };

export type AssetOutcome =
  | { readonly tag: "resolved"; readonly ref: AssetRef; readonly assetId: string; readonly description: string }
  | { readonly tag: "no_catalog"; readonly ref: AssetRef }
  | { readonly tag: "index_corrupted"; readonly ref: AssetRef }
  | { readonly tag: "not_installed"; readonly ref: AssetRef }
  | {
      readonly tag: "no_description";
      readonly ref: AssetRef;
      readonly assetId: string;
      /** **두 하위축을 뭉개지 않는다** — "설명이 사라진 회귀"와 "원래 없던 자산"은 다른 사건이다. */
      readonly reason: "empty_string" | "field_absent";
    }
  | { readonly tag: "ambiguous"; readonly ref: AssetRef; readonly candidates: readonly string[] };

export interface ResolveResult {
  readonly outcomes: readonly AssetOutcome[];
  /** 색인에 못 들어간 무부모 행 수 — 카탈로그가 없으면 `null`(0이 아니다). */
  readonly parentlessRows: number | null;
}

/**
 * 셀에 찍히는 문구 — **서버가 만든다.** 브라우저나 다른 계층이 따로 조립하면 이원화된다.
 *
 * `switch`가 exhaustive하므로 **갈래가 늘면 컴파일이 깨진다** — `filter(...).length`로 세다가
 * 새 갈래가 어디에도 안 잡혀 요약에서 통째로 사라졌던 전례(R12)를 구조로 막는다.
 */
export function describeOutcome(outcome: AssetOutcome): string {
  switch (outcome.tag) {
    case "resolved":
      return outcome.description;
    case "no_catalog":
      return "(미측정 · 카탈로그 없음)";
    case "index_corrupted":
      return "(미측정 · 인덱스 손상)";
    case "not_installed":
      return "(이 머신에 없음 · 마지막 스캔 시점 기준)";
    case "no_description":
      return "(원문에 설명 없음)";
    case "ambiguous":
      return "(동명 자산 여럿 — 판정 불가)";
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/**
 * 갈래별 종료 코드 기여. **최종 종료 코드는 자산 전체의 max로 접는다** — 행이 아니라 자산 축이다.
 * `3`은 **구조적 실패**이고 `2`(미측정)와 합치지 않는다: 미측정을 실패로, 실패를 미측정으로
 * 보고하면 둘 다 거짓이 된다(안전 원칙 7).
 */
export function exitCodeContribution(outcome: AssetOutcome): 0 | 1 | 2 | 3 {
  switch (outcome.tag) {
    case "resolved":
      return 0;
    case "not_installed":
    case "no_description":
      return 1;
    case "no_catalog":
    case "index_corrupted":
      return 2;
    case "ambiguous":
      return 3;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/**
 * 참조를 해석한다.
 *
 * @param describe 자산 id로 설명을 찾는 **주입된** 함수 — `core`는 파일을 읽지 않는다.
 */
export function resolveWorkflowAssets(
  refs: readonly AssetRef[],
  catalog: CatalogState,
  describe: (assetId: string) => DescriptionLookup,
): ResolveResult {
  if (catalog.kind === "absent") {
    return { outcomes: refs.map((ref) => ({ tag: "no_catalog", ref }) as const), parentlessRows: null };
  }
  if (catalog.kind === "corrupted") {
    return { outcomes: refs.map((ref) => ({ tag: "index_corrupted", ref }) as const), parentlessRows: null };
  }

  const index: TupleIndex = buildTupleIndex(catalog.rows);
  const outcomes = refs.map((ref): AssetOutcome => {
    const { key } = lookupKeyFor(ref);
    const candidates = lookupCandidates(index, key.kind, key.pluginName, key.name);

    // **후보가 정확히 하나일 때만 잇는다** — 0건은 미설치, 2건 이상은 조용히 첫 건을 고르지 않는다.
    if (candidates.length === 0) return { tag: "not_installed", ref };
    if (candidates.length > 1) return { tag: "ambiguous", ref, candidates };

    const assetId = candidates[0] ?? "";
    const lookup = describe(assetId);
    switch (lookup.kind) {
      case "found":
        return { tag: "resolved", ref, assetId, description: lookup.description };
      case "empty_string":
        return { tag: "no_description", ref, assetId, reason: "empty_string" };
      case "field_absent":
        return { tag: "no_description", ref, assetId, reason: "field_absent" };
      default: {
        const exhaustive: never = lookup;
        return exhaustive;
      }
    }
  });

  return { outcomes, parentlessRows: index.parentlessRows };
}

import type { Asset } from "../schema/asset.js";
import {
  ASSET_SEPARATOR,
  DEFAULT_ASSET_CELL_LIMIT,
  DEFAULT_ROW_CELL_LIMIT,
  renderWorkflowAssetCell,
} from "./asset-cell.js";

/**
 * 다중 자산 행의 **두 번째 관문** (B4-c · D-6).
 *
 * 표는 **16행인데 자산은 21건**이다 — 한 행이 자산 2~3개를 담는 행이 4개 있다(디버깅 행은 3개).
 * 판정(6갈래)은 **자산 단위**로 유지하고, 셀 조립만 여기서 한다. 판정을 행 단위로 접으면
 * 한 행 안에서 `resolved`와 `not_installed`가 섞일 때 무엇을 찍을지 정의되지 않는다.
 */

/**
 * 셀 한 칸에 들어갈 자산 하나의 입력.
 *
 * `described`만 렌더러를 타고, 나머지 갈래(미설치·설명 없음·카탈로그 없음 …)는 호출부가
 * **이미 문구로 바꿔서** 넘긴다 — 렌더러가 "비었다"를 만들어 내지 않게 하는 D-2의 배선이다.
 */
export type RowCellInput =
  | { readonly kind: "described"; readonly asset: Pick<Asset, "description"> }
  | { readonly kind: "placeholder"; readonly text: string };

/** 자산당 상한이 이 아래로 내려가면 자르지 않고 통째로 생략한다 — 반토막 설명은 없느니만 못하다. */
export const MIN_ASSET_CELL_GRAPHEMES = 24;

/**
 * **max-min fair (water-filling)** — `Σ min(len_i, c) ≤ budget`을 만족하는 **최대 `c`**를 찾는다.
 *
 * ⚠️ **"자산당 상한을 균등하게 낮춘다"는 구현 가능한 규칙이 아니었다 (F-3).**
 * 길이 250/40/30 · 총합 300에서 자산당을 100으로 "균등" 적용하면 A만 잘려 총합 170이 되고
 * **예산 130을 버리면서 가장 긴 자산만 가장 세게 자른다** — 피하려던 비대칭을 그대로 만든다.
 * water-filling은 **짧은 설명을 절대 자르지 않고** 긴 것들만 같은 상한을 나눠 갖게 한다.
 */
export function fairShareLimit(lengths: readonly number[], budget: number): number {
  if (lengths.length === 0) return 0;
  const ascending = [...lengths].sort((a, b) => a - b);
  let remaining = budget;
  let unassigned = ascending.length;
  for (const length of ascending) {
    const share = Math.floor(remaining / unassigned);
    if (length > share) return share;
    remaining -= length;
    unassigned -= 1;
  }
  return Number.POSITIVE_INFINITY; // 전부 예산 안에 들어간다
}

function graphemeLength(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

function renderAt(inputs: readonly RowCellInput[], limit: number): string {
  return inputs
    .map((input) =>
      input.kind === "placeholder"
        ? input.text
        : limit < MIN_ASSET_CELL_GRAPHEMES
          ? ""
          : renderWorkflowAssetCell(input.asset, limit),
    )
    .filter((cell) => cell.length > 0)
    .join(ASSET_SEPARATOR);
}

/**
 * 한 행의 마지막 셀 문자열을 만든다.
 *
 * **두 상한의 단위가 다르다** — 자산당은 **이스케이프 전 자소 수**, 총합은 **이스케이프 후
 * 문자 수**(구분자와 `…` 포함)다. 절단이 이스케이프보다 앞에 오므로 최종 폭은 자산당 상한을
 * 넘을 수 있고, 그래서 총합은 **렌더 결과를 실제로 재서** 확인한다. 렌더 길이는 `c`에 대해
 * 단조 증가하므로 `c`를 낮추는 탐색이 수렴한다.
 */
export function renderWorkflowAssetRow(
  inputs: readonly RowCellInput[],
  assetLimit: number = DEFAULT_ASSET_CELL_LIMIT,
  rowLimit: number = DEFAULT_ROW_CELL_LIMIT,
): string {
  if (inputs.length === 0) {
    throw new Error("renderWorkflowAssetRow에 자산이 0건 들어왔다 — 호출부가 행당 0건을 이미 걸렀어야 한다");
  }

  const described = inputs.filter(
    (i): i is Extract<RowCellInput, { kind: "described" }> => i.kind === "described",
  );
  const placeholderWidth = inputs
    .filter((i) => i.kind === "placeholder")
    .reduce((sum, i) => sum + (i.kind === "placeholder" ? i.text.length : 0), 0);
  const separatorWidth = ASSET_SEPARATOR.length * Math.max(0, inputs.length - 1);

  // 1단계: 자소 축에서 공정 분배 상한을 구한다.
  const graphemeLengths = described.map((i) => graphemeLength(i.asset.description ?? ""));
  const graphemeBudget = Math.max(0, rowLimit - placeholderWidth - separatorWidth);
  const fair = fairShareLimit(graphemeLengths, graphemeBudget);
  let limit = Math.min(assetLimit, Number.isFinite(fair) ? fair : assetLimit);

  // 2단계: 이스케이프 후 실제 폭으로 검산하고 넘으면 `c`를 낮춘다(단조라 수렴한다).
  let rendered = renderAt(inputs, limit);
  while (rendered.length > rowLimit && limit > MIN_ASSET_CELL_GRAPHEMES) {
    limit = Math.max(MIN_ASSET_CELL_GRAPHEMES, Math.floor(limit * 0.8));
    rendered = renderAt(inputs, limit);
    if (limit === MIN_ASSET_CELL_GRAPHEMES) break;
  }

  if (rendered.length === 0) {
    // 전부 생략된 경우 — **빈 셀을 내지 않는다.** 무엇이 일어났는지 셀에 남긴다.
    return `(설명 생략 · ${inputs.length}건)`;
  }
  return rendered;
}

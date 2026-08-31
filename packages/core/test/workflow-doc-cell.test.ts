import { describe, expect, it } from "vitest";
import { parseAsset, type Asset } from "../src/schema/asset.js";
import {
  ASSET_SEPARATOR,
  DEFAULT_ASSET_CELL_LIMIT,
  renderWorkflowAssetCell,
} from "../src/workflow-doc/asset-cell.js";
import { fairShareLimit, renderWorkflowAssetRow, type RowCellInput } from "../src/workflow-doc/asset-row.js";
import { locateTable, unescapedPipeIndexes } from "../src/workflow-doc/table-locate.js";

/**
 * ⚠️ **오늘의 표본으로는 공허하다는 것을 전제로 짠 테스트다.**
 * 화이트리스트 21건의 `description`은 **전부 깨끗하다**(실측 2026-08-31: 최대 172자 · 중앙값 73,
 * `|`·개행·`<`·백틱 0건). 실제 값으로 이스케이프를 시험하면 **동어반복**이므로 반드시 **합성
 * description을 주입**한다. 상한 절단도 마찬가지다 — 최대 172자라 상한 200에 닿지 않는다.
 *
 * ⚠️ **이스케이프가 표를 살렸는지는 "문자열이 같다"로 확인하지 않는다.** 렌더 결과를 실제 표
 * 안에 넣고 `locateTable`로 **되파싱**해 열 경계가 보존됐는지로 확인한다 — 문자열 비교는 깨진
 * 표도 통과시킨다.
 */

/** 픽스처는 실제 zod 파서를 통과시킨다 — **`as Asset` 금지.** skill은 `parent_asset_id` 선택이다. */
function syntheticAsset(description: string): Asset {
  return parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: "example-plugin@example-market:skill:example",
    kind: "skill",
    name: "example",
    parent_asset_id: "example-plugin@example-market",
    description,
  });
}

/** 렌더 결과를 실제 3열 표에 넣고 되파싱한다 — 구조 보존 확인의 유일한 방법이다. */
function roundTripThroughTable(cell: string): { columns: number; lastCell: string } {
  const doc = ["| 단계 | 스폰할 것 | 설명 |", "|---|---|---|", `| 구현 | \`Agent(example:executor)\` | ${cell} |`].join(
    "\n",
  );
  const located = locateTable(doc);
  const row = located.rows[0];
  if (row === undefined) throw new Error("되파싱 실패 — 데이터 행이 없다");
  return {
    columns: unescapedPipeIndexes(row.line).length,
    lastCell: row.line.slice(row.lastCellStart, row.lastCellEnd).trim(),
  };
}

describe("renderWorkflowAssetCell — 합성 주입 (실제 값으로는 동어반복이다)", () => {
  it("파이프를 이스케이프하고 열 수를 보존한다", () => {
    const cell = renderWorkflowAssetCell(syntheticAsset("a | b"));
    expect(cell).toBe("a \\| b");
    expect(roundTripThroughTable(cell).columns).toBe(4); // 3열 = 파이프 4개
  });

  it("개행을 한 줄로 접는다 — 행 수가 늘지 않는다", () => {
    const cell = renderWorkflowAssetCell(syntheticAsset("첫 줄\n\n둘째 줄\r\n셋째"));
    expect(cell).toBe("첫 줄 둘째 줄 셋째");
    expect(cell).not.toContain("\n");
  });

  it("상한 초과 장문을 자르고 `…`를 붙인다 — 표가 깨지지 않는다", () => {
    const cell = renderWorkflowAssetCell(syntheticAsset("가".repeat(500)));
    expect(cell.endsWith("…")).toBe(true);
    expect(roundTripThroughTable(cell).columns).toBe(4);
  });

  it("`<script>`를 엔티티로 바꾼다", () => {
    expect(renderWorkflowAssetCell(syntheticAsset("<script>x</script>"))).toBe(
      "&lt;script&gt;x&lt;/script&gt;",
    );
  });

  it("**이미 엔티티인 `&lt;script&gt;`는 복원되지 않는다** — `&`를 가장 먼저 이스케이프한다", () => {
    // `&`를 빠뜨리면 이 입력이 `<`·`>` 규칙을 그냥 통과하고 렌더 시점에 `<script>`가 된다.
    expect(renderWorkflowAssetCell(syntheticAsset("&lt;script&gt;"))).toBe("&amp;lt;script&amp;gt;");
  });

  it("백틱 3개가 코드펜스를 열지 않는다 — 셀을 코드 스팬으로 감싸지 않는다", () => {
    const cell = renderWorkflowAssetCell(syntheticAsset("```"));
    expect(cell).toBe("```");
    expect(cell.startsWith("`") && cell.endsWith("`") && cell.length > 3).toBe(false);
    expect(roundTripThroughTable(cell).columns).toBe(4);
  });

  it("파이프·개행·백틱이 **동시**에 있어도 전부 성립한다 (축을 하나씩만 보면 상호작용을 놓친다)", () => {
    const cell = renderWorkflowAssetCell(syntheticAsset("a | b\n`c|d`\n<e>"));
    expect(cell).toBe("a \\| b `c\\|d` &lt;e&gt;");
    expect(roundTripThroughTable(cell).columns).toBe(4);
  });

  it("상한 경계에 `\\`가 와도 홑 역슬래시가 남지 않는다 — 행이 깨지지 않는다", () => {
    // 절단이 이스케이프 **뒤**에 있으면 `\|`가 `\`로 반토막 나 셀 닫는 `|`를 이스케이프한다.
    const cell = renderWorkflowAssetCell(syntheticAsset(`${"가".repeat(9)}\\|`), 10);
    expect(roundTripThroughTable(cell).columns).toBe(4);
    // 절단이 먼저이므로 남은 역슬래시는 반드시 짝을 이룬다.
    expect(/(?<!\\)\\(?!\\|\|)/.test(cell)).toBe(false);
  });

  it("ZWJ 이모지가 상한 경계에 와도 자소가 반토막 나지 않는다", () => {
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"; // 가족 이모지 = 자소 1개
    const cell = renderWorkflowAssetCell(syntheticAsset(`${family}${family}${family}`), 2);
    expect(cell).toBe(`${family}${family}…`);
    expect(cell).not.toContain("\u{200D}…"); // 끝에 ZWJ가 남아 `…`와 결합하지 않는다
  });

  it("빈 설명은 렌더러가 만들어 내지 않는다 — 던진다 (호출부가 no_description으로 가른다)", () => {
    expect(() => renderWorkflowAssetCell({ description: "" })).toThrow(/no_description/);
    expect(() => renderWorkflowAssetCell({ description: undefined })).toThrow(/no_description/);
    expect(() => renderWorkflowAssetCell({ description: "   \n  " })).toThrow(/no_description/);
  });

  it("기본 상한은 실측 모집단(최대 172)보다 크다 — 오늘 표본은 절단되지 않는다", () => {
    expect(DEFAULT_ASSET_CELL_LIMIT).toBeGreaterThan(172);
  });
});

describe("renderWorkflowAssetRow — 다중 자산 행 (D-6 · F-3)", () => {
  it("자산 여럿을 ` · `로 잇는다", () => {
    const inputs: RowCellInput[] = [
      { kind: "described", asset: syntheticAsset("첫째") },
      { kind: "described", asset: syntheticAsset("둘째") },
    ];
    expect(renderWorkflowAssetRow(inputs)).toBe(`첫째${ASSET_SEPARATOR}둘째`);
  });

  it("placeholder 갈래는 렌더러를 타지 않는다", () => {
    const inputs: RowCellInput[] = [
      { kind: "described", asset: syntheticAsset("있음") },
      { kind: "placeholder", text: "—(이 머신 미설치)" },
    ];
    expect(renderWorkflowAssetRow(inputs)).toBe(`있음${ASSET_SEPARATOR}—(이 머신 미설치)`);
  });

  it("**max-min fair** — 짧은 설명은 절대 잘리지 않고 긴 것들만 상한을 나눠 갖는다", () => {
    // F-3의 반례: 250/40/30 · 예산 300. "균등 축소"라면 A만 100으로 잘려 총합 170이 된다.
    expect(fairShareLimit([250, 40, 30], 300)).toBe(230); // 300-40-30 = 230을 A가 전부 갖는다
    expect(fairShareLimit([100, 100, 100], 300)).toBe(Number.POSITIVE_INFINITY); // 전부 들어간다
    expect(fairShareLimit([500, 500], 300)).toBe(150); // 둘 다 길면 균등하게 나눈다
  });

  it("총합 상한을 넘으면 줄이되 표는 살아 있다", () => {
    const inputs: RowCellInput[] = [
      { kind: "described", asset: syntheticAsset("가".repeat(300)) },
      { kind: "described", asset: syntheticAsset("나".repeat(300)) },
    ];
    const cell = renderWorkflowAssetRow(inputs, 200, 120);
    expect(cell.length).toBeLessThanOrEqual(120);
    expect(roundTripThroughTable(cell).columns).toBe(4);
  });

  it("자산 0건이면 던진다 — 호출부가 이미 걸렀어야 한다", () => {
    expect(() => renderWorkflowAssetRow([])).toThrow(/0건/);
  });
});

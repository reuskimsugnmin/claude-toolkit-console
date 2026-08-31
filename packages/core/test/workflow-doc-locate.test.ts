import { describe, expect, it } from "vitest";
import { WorkflowDocError } from "../src/workflow-doc/errors.js";
import {
  extractAssetRefs,
  locateTable,
  replaceLastCell,
  unescapedPipeIndexes,
} from "../src/workflow-doc/table-locate.js";

const HEADER = "| 단계 | 스폰할 것 | 설명 |";
const SEP = "|---|---|---|";

function doc(...rows: string[]): string {
  return [HEADER, SEP, ...rows].join("\n");
}

function failureClassOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof WorkflowDocError) return err.failureClass;
    return `unexpected:${String(err)}`;
  }
  return "did-not-throw";
}

describe("unescapedPipeIndexes — GFM 규약 (F-4)", () => {
  it("이스케이프된 `\\|`는 구분자가 아니다", () => {
    expect(unescapedPipeIndexes("| a \\| b |")).toEqual([0, 9]);
  });

  it("**백틱 안의 `|`도 구분자다** — GFM에서 백틱은 파이프를 보호하지 않는다", () => {
    // `` | a | `x|y` | b | ``는 렌더러가 4셀로 읽는다. 스캐너가 백틱을 보면 렌더러와 다르게 센다.
    expect(unescapedPipeIndexes("| a | `x|y` |").length).toBe(4);
  });

  it("연속 역슬래시의 홀짝을 센다 — `\\\\|`는 구분자다", () => {
    expect(unescapedPipeIndexes("a\\\\|b")).toEqual([3]);
  });
});

describe("extractAssetRefs — 규칙을 뒤집었다 (M-7)", () => {
  it("완전 일치하는 백틱 스팬만 자산 참조로 본다", () => {
    const refs = extractAssetRefs("| 구현 | `Agent(oh-my-claudecode:executor)` |");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kindLabel: "Agent", plugin: "oh-my-claudecode", name: "executor" });
  });

  it("**`actuator` 같은 산문 백틱 스팬은 무시한다 — 던지지 않는다** (오늘 문서의 보안 검토 행)", () => {
    const line = "| 보안 검토 | `Agent(oh-my-claudecode:security-reviewer)` — `actuator` 변경 시 **필수** |";
    const refs = extractAssetRefs(line);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.name).toBe("security-reviewer");
  });

  it("한 행의 자산 여럿을 전부 뽑는다", () => {
    const line = "| 디버깅 | `Skill(omc:debug)` · `Agent(omc:debugger)` · `Agent(omc:tracer)` |";
    expect(extractAssetRefs(line).map((r) => r.name)).toEqual(["debug", "debugger", "tracer"]);
  });

  it("부분 일치는 참조가 아니다 — 통과 축은 완전 일치다", () => {
    expect(extractAssetRefs("| x | `보라: Agent(omc:executor) 를` |")).toHaveLength(0);
  });
});

describe("locateTable — 경계는 마지막 두 파이프 *사이*다 (F-1)", () => {
  const ROW = "| 구현 | `Agent(omc:executor)` | 기존 설명 |";

  it("마지막 셀 본문을 정확히 집는다 — 마지막 파이프 '이후'가 아니다", () => {
    const row = locateTable(doc(ROW)).rows[0];
    if (row === undefined) throw new Error("행 없음");
    expect(row.line.slice(row.lastCellStart, row.lastCellEnd)).toBe(" 기존 설명 ");
    // rev1대로 "마지막 파이프 이후"였다면 빈 문자열이었다.
    expect(row.line.slice(row.lastCellEnd + 1)).toBe("");
  });

  it("replaceLastCell이 **접두사 바이트를 보존한다** — 정렬 공백·굵게·산문 전부", () => {
    const padded = "| 보안 검토   | `Agent(omc:security-reviewer)` — `actuator` 시 **필수** | 옛 설명 |";
    const row = locateTable(doc(padded)).rows[0];
    if (row === undefined) throw new Error("행 없음");
    const rewritten = replaceLastCell(row, "새 설명");
    // 끝에서 두 번째 파이프(포함)까지가 원본과 바이트 동일이다.
    expect(rewritten.slice(0, row.lastCellStart)).toBe(padded.slice(0, row.lastCellStart));
    expect(rewritten).toContain("보안 검토   |"); // 정렬 공백 살아 있다
    expect(rewritten).toContain("**필수**"); // 굵게 살아 있다
    expect(rewritten.endsWith("| 새 설명 |")).toBe(true);
  });

  it("두 번 치환해도 열이 늘지 않는다 — 멱등 (F-1 회귀 방지)", () => {
    const once = replaceLastCell(locateTable(doc(ROW)).rows[0]!, "새 설명");
    const twice = replaceLastCell(locateTable(doc(once)).rows[0]!, "새 설명");
    expect(twice).toBe(once);
    expect(unescapedPipeIndexes(twice).length).toBe(4);
  });
});

describe("locateTable — 전제 가드는 삼키지 않고 던진다", () => {
  it("표 행이 0개면 `parse_failed` — '0건 일치'가 아니다", () => {
    expect(failureClassOf(() => locateTable("표가 없는 본문"))).toBe("workflow_doc_parse_failed");
  });

  it("2열 행(파이프 3개)은 `parse_failed` — 3열 골격이 없으면 치환할 구간이 없다", () => {
    expect(
      failureClassOf(() => locateTable(["| 단계 | 스폰할 것 |", "|---|---|", "| 구현 | `Agent(omc:executor)` |"].join("\n"))),
    ).toBe("workflow_doc_parse_failed");
  });

  it("**말미 파이프가 없는 GFM 행**은 `parse_failed` — 남은 유일한 파괴 경로를 막는다", () => {
    expect(failureClassOf(() => locateTable(doc("| 구현 | `Agent(omc:executor)` | 설명")))).toBe(
      "workflow_doc_parse_failed",
    );
  });

  it("행당 자산 참조가 0건이면 `parse_failed` — 조용한 누락을 막는다", () => {
    expect(failureClassOf(() => locateTable(doc("| 구현 | 아직 안 정함 | 설명 |")))).toBe(
      "workflow_doc_parse_failed",
    );
  });

  it("자산 수 상한을 넘으면 `whitelist_overflow`로 중단한다 (D-9)", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `| 단계${i} | \`Agent(omc:a${i})\` | 설명 |`);
    expect(failureClassOf(() => locateTable(doc(...rows), 3))).toBe("workflow_doc_whitelist_overflow");
  });

  it("구분자 행이 없으면 `parse_failed`", () => {
    expect(failureClassOf(() => locateTable([HEADER, "| 구현 | `Agent(omc:executor)` | 설명 |"].join("\n")))).toBe(
      "workflow_doc_parse_failed",
    );
  });

  it("헤더·구분자 행은 데이터 행에 포함되지 않는다 — 참조 0건 규칙에 걸리지 않는다", () => {
    const located = locateTable(doc("| 구현 | `Agent(omc:executor)` | 설명 |"));
    expect(located.rows).toHaveLength(1);
    expect(located.headerLineIndex).toBe(0);
    expect(located.separatorLineIndex).toBe(1);
  });
});

describe("D-1′의 구조적 보장", () => {
  it("table-locate은 표를 조립하는 함수를 노출하지 않는다", async () => {
    const mod = await import("../src/workflow-doc/table-locate.js");
    const assemblers = Object.keys(mod).filter((k) => /^(render|build|format)/.test(k));
    expect(assemblers, "파서가 출력 경로에 관여하면 1·2열 보존이 테스트에 의존하게 된다").toEqual([]);
  });
});

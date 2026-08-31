import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findGeneratedRegion,
  findWorkflowDocLeaks,
  GENERATED_OUTPUT_AXES,
  GENERATED_REGION_END,
  GENERATED_REGION_START,
  outsideGeneratedRegion,
} from "@ctk/core";
import { describe, expect, it } from "vitest";

/**
 * `docs/workflow-assets.md`가 생성기(B4-c)의 입력으로 지켜야 할 불변식 — **카탈로그가 없어도 돈다.**
 * 그래서 `pnpm test`에 그대로 들어가고 **CI가 실제로 부른다**(CI는 `pnpm verify`를 부르지 않는다 —
 * `.github/workflows/ci.yml`이 그 사실을 주석으로 경고한다. 등재 ≠ 도달).
 *
 * ⚠️ **여기에 표 파서를 두지 않는다.** 정본 파서는 Step 2에서 생기고, 그 전에 사본을 만들면
 * 원본의 정정이 사본에 도달하지 않는다. 행 수는 **파싱이 아니라 `^|`로 시작하는 줄 수**로 잰다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC_PATH = path.join(repoRoot, "docs/workflow-assets.md");
const DOC = readFileSync(DOC_PATH, "utf8");

/** 마커 밖에 살아남아야 하는 절 — 카탈로그에서 나올 수 없는 **정책**이다. */
const HAND_MAINTAINED_SECTIONS = [
  "## 세션 간 컨텍스트",
  "## 쓰지 않는 것 — 워크플로우 플러그인",
  "## 서브에이전트 운용 실측",
] as const;

/** 헤더 1 + 구분자 1 + 데이터 16. 표가 통째로 사라지는 것을 막는 하한이다. */
const MIN_TABLE_LINES = 18;

function pipeLineCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.startsWith("|")).length;
}

describe("docs/workflow-assets.md — 마커", () => {
  it("생성 구간 마커가 각각 정확히 1회이고 순서가 맞다", () => {
    const region = findGeneratedRegion(DOC);
    expect(region.kind, `마커 판정 실패: ${JSON.stringify(region)}`).toBe("ok");
  });

  it("마커가 표를 감싼다 — 구간 안에 표 줄이 하한 이상 있다", () => {
    const region = findGeneratedRegion(DOC);
    if (region.kind !== "ok") throw new Error("마커 판정 실패");
    expect(pipeLineCount(region.text)).toBeGreaterThanOrEqual(MIN_TABLE_LINES);
  });
});

describe("docs/workflow-assets.md — 정책 절은 마커 밖에 있다", () => {
  it.each(HAND_MAINTAINED_SECTIONS)("`%s`가 마커 **밖**에 있다", (heading) => {
    const region = findGeneratedRegion(DOC);
    const outside = outsideGeneratedRegion(DOC, region);
    expect(outside, "마커 판정이 실패하면 이 검사는 성립하지 않는다").not.toBeNull();
    // "문서 어딘가에 있다"가 아니다 — 안에 있으면 다음 `--write`가 지운다.
    expect(outside).toContain(heading);
  });
});

describe("docs/workflow-assets.md — 생성 구간 위생", () => {
  it("생성 구간에 개인 환경 데이터가 없다 (6축)", () => {
    const region = findGeneratedRegion(DOC);
    if (region.kind !== "ok") throw new Error("마커 판정 실패");
    // 생성 구간은 서드파티 `description`이 흘러드는 자리라 경로 축까지 본다.
    expect(findWorkflowDocLeaks(region.text, GENERATED_OUTPUT_AXES)).toEqual([]);
  });
});

/**
 * ⚠️ **양성 대조군** — 위 단언들이 **실제로 막는지** 오염된 합성 문서로 확인한다.
 * 이것이 없으면 "규칙 존재 ≠ 규칙이 막음"이다. 문자열은 전부 합성이고 개인 데이터가 아니다.
 */
describe("양성 대조군 — 오염된 합성 문서에서 각 단언이 실제로 실패한다", () => {
  const SYNTHETIC = [
    GENERATED_REGION_START,
    "| 단계 | 스폰할 것 |",
    "|---|---|",
    "| 구현 | `Agent(example:executor)` |",
    GENERATED_REGION_END,
    "",
    "## 쓰지 않는 것 — 워크플로우 플러그인",
    "",
    "예시 정책 절.",
  ].join("\n");

  it("합성 문서 자체는 마커 판정을 통과한다 (음성 대조군)", () => {
    expect(findGeneratedRegion(SYNTHETIC).kind).toBe("ok");
  });

  it("`:start` 마커가 없으면 `marker_missing`", () => {
    const broken = SYNTHETIC.replace(GENERATED_REGION_START, "");
    expect(findGeneratedRegion(broken)).toEqual({ kind: "marker_missing", which: "start" });
  });

  it("마커가 중복되면 `marker_duplicated` — 조용히 첫 것을 고르지 않는다", () => {
    const broken = `${SYNTHETIC}\n${GENERATED_REGION_START}`;
    expect(findGeneratedRegion(broken)).toMatchObject({ kind: "marker_duplicated", which: "start", count: 2 });
  });

  it("마커 순서가 뒤집히면 `marker_out_of_order`", () => {
    const broken = [GENERATED_REGION_END, "| a | b |", GENERATED_REGION_START].join("\n");
    expect(findGeneratedRegion(broken)).toEqual({ kind: "marker_out_of_order" });
  });

  it("표 줄이 하한 미만이면 행수 단언이 실패한다", () => {
    const region = findGeneratedRegion(SYNTHETIC);
    if (region.kind !== "ok") throw new Error("마커 판정 실패");
    expect(pipeLineCount(region.text)).toBeLessThan(MIN_TABLE_LINES);
  });

  it("정책 절이 마커 **안**에 있으면 실패한다 — 문서 어딘가에 있는 것으로는 부족하다", () => {
    const moved = [
      GENERATED_REGION_START,
      "## 쓰지 않는 것 — 워크플로우 플러그인",
      "| 단계 | 스폰할 것 |",
      GENERATED_REGION_END,
    ].join("\n");
    const outside = outsideGeneratedRegion(moved, findGeneratedRegion(moved));
    expect(moved).toContain("## 쓰지 않는 것 — 워크플로우 플러그인"); // 문서에는 있다
    expect(outside).not.toContain("## 쓰지 않는 것 — 워크플로우 플러그인"); // 그러나 밖에는 없다
  });

  it("생성 구간에 개인 환경 데이터가 들어가면 위생 단언이 실패한다", () => {
    const polluted = SYNTHETIC.replace(
      "| 구현 | `Agent(example:executor)` |",
      "| 구현 | 설정은 ~/.config/ctk에 있다 · id는 some-plugin@some-market |",
    );
    const region = findGeneratedRegion(polluted);
    if (region.kind !== "ok") throw new Error("마커 판정 실패");
    const leaks = findWorkflowDocLeaks(region.text, GENERATED_OUTPUT_AXES);
    expect(leaks.map((l) => l.axis).sort()).toEqual(["marketplace_asset_id", "tilde_home"]);
  });
});

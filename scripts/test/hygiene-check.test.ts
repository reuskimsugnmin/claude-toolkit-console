import { describe, expect, it } from "vitest";
import { buildConsoleViewModel, buildProjectChoices } from "@ctk/core";
import { scanFileContent, runHygieneCheck, isExempt, buildPatterns, scanStructuredExport } from "../hygiene-check.mjs";

// 실제 구현이 쓰는 패턴을 그대로 재사용한다 — 테스트가 구현과 따로 노는 사본 정규식을 들고
// 있으면 구현이 바뀌어도 테스트가 계속 통과하는 드리프트가 생긴다.
const PATTERNS = buildPatterns();

/**
 * ⚠️ **손으로 쓴 JSON을 쓰지 않는다.** 서명은 뷰모델의 최상위 키에 걸려 있으므로, 픽스처를
 * 직접 적으면 나중에 뷰모델 키가 바뀌었을 때 **픽스처만 옛 모양을 유지한 채 계속 통과한다.**
 * 프로덕션이 쓰는 조립 함수를 그대로 돌려 진짜 export 본문을 만든다.
 */
const EXPORTED_VIEW_MODEL = JSON.stringify(
  buildConsoleViewModel({
    machineId: "synthetic-machine",
    projects: buildProjectChoices({ absolutePaths: ["/synthetic/dev/synth-app"], hashPrefixOf: () => "abc123" }),
    projectsUnavailable: null,
    assets: [],
    installations: [],
    occupancy: [],
    usage: [],
    lastScanAt: null,
    docPresence: new Map(),
    unusedExpensiveLimit: 5,
    now: new Date("2026-08-22T00:00:00.000Z"),
  }),
  null,
  2,
);

describe("scripts/hygiene-check — 공개 저장소 위생 가드", () => {
  it("합성 위반 문자열(/Users/실사용자명/...)을 검출한다", () => {
    const violations = scanFileContent(
      "fake/fixture.ts",
      `const p = "/Users/real-person/secret-project";`,
      PATTERNS,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.pattern).toBe("macos_home_path");
  });

  it("/home/ 리눅스 홈 경로도 검출한다", () => {
    const violations = scanFileContent(
      "fake/fixture.ts",
      `const p = "/home/real-person/secret-project";`,
      PATTERNS,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.pattern).toBe("linux_home_path");
  });

  it("/synthetic/ 접두 합성 경로는 위반으로 잡지 않는다 (오탐 없음)", () => {
    const violations = scanFileContent(
      "fake/fixture.ts",
      `const p = "/synthetic/projects/alpha";`,
      PATTERNS,
    );
    expect(violations).toHaveLength(0);
  });

  it("상대경로 세그먼트 안의 우연한 '/home/' 부분 문자열은 오탐하지 않는다 (경계 검사)", () => {
    const violations = scanFileContent(
      "fake/fixture.sh",
      `cp -R "$ROOT/fixtures/home/.claude/." "$DEST/"`,
      PATTERNS,
    );
    expect(violations).toHaveLength(0);
  });

  it("면제 경로(.omc/ 등)는 스캔하지 않는다", () => {
    expect(isExempt(".omc/state/whatever.md")).toBe(true);
    expect(isExempt("packages/core/src/index.ts")).toBe(false);
  });

  it("정규식만으로는 뷰모델 export를 잡지 못한다 — 이 사각지대가 실재함을 먼저 보인다 (심사 L4)", () => {
    // 안 B 덕분에 export에는 절대경로가 **하나도 없다.** 그래서 경로 패턴 검사는 통과한다 —
    // 구조 검출기를 새로 만든 이유가 이것이고, 이 단언이 그 전제를 고정한다.
    expect(scanFileContent("out/view-model.json", EXPORTED_VIEW_MODEL, PATTERNS)).toHaveLength(0);
  });

  it("뷰모델 export는 구조 서명으로 잡힌다", () => {
    const violations = scanStructuredExport("out/view-model.json", EXPORTED_VIEW_MODEL);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.pattern).toBe("exported_view_model");
  });

  it("확장자가 없어도 잡는다 — `--export-view-model`은 임의 경로를 받는다", () => {
    expect(scanStructuredExport("out/dump", EXPORTED_VIEW_MODEL)).toHaveLength(1);
  });

  it("키가 하나라도 빠지면 잡지 않는다 — 서명은 전체 일치다(오탐 방지)", () => {
    const partial = JSON.stringify({ schema_version: 1, assets: [], usage: {}, freshness: {} });
    expect(scanStructuredExport("fixtures/partial.json", partial)).toHaveLength(0);
  });

  it("평범한 JSON·JSON이 아닌 파일은 잡지 않는다", () => {
    expect(scanStructuredExport("package.json", `{"name":"ctk","version":"0.1.0"}`)).toHaveLength(0);
    expect(scanStructuredExport("README.md", "# ctk\n\n{ 이건 JSON이 아니다")).toHaveLength(0);
  });

  it("실제 저장소(git ls-files 기준)를 스캔했을 때 위반 0건이다 — 지금까지 작성한 코드가 위생 규칙을 지킨다", () => {
    const { violations } = runHygieneCheck();
    if (violations.length > 0) {
      // 실패 원인을 바로 보여준다 — CI 로그에서 어떤 파일/패턴인지 즉시 알 수 있어야 한다
      console.error(violations.slice(0, 20));
    }
    expect(violations).toHaveLength(0);
  });
});

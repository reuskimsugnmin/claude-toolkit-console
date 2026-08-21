import { describe, expect, it } from "vitest";
import { scanFileContent, runHygieneCheck, isExempt, buildPatterns } from "../hygiene-check.mjs";

// 실제 구현이 쓰는 패턴을 그대로 재사용한다 — 테스트가 구현과 따로 노는 사본 정규식을 들고
// 있으면 구현이 바뀌어도 테스트가 계속 통과하는 드리프트가 생긴다.
const PATTERNS = buildPatterns();

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

  it("실제 저장소(git ls-files 기준)를 스캔했을 때 위반 0건이다 — 지금까지 작성한 코드가 위생 규칙을 지킨다", () => {
    const { violations } = runHygieneCheck();
    if (violations.length > 0) {
      // 실패 원인을 바로 보여준다 — CI 로그에서 어떤 파일/패턴인지 즉시 알 수 있어야 한다
      console.error(violations.slice(0, 20));
    }
    expect(violations).toHaveLength(0);
  });
});

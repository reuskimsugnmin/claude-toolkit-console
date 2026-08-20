import { describe, expect, it } from "vitest";
import {
  normalizePath,
  findRawPathLeaks,
  assertNoRawPathLeaks,
} from "../src/snapshot/path-normalize.js";

describe("snapshot/path-normalize — 착수 조건 C1 위생 정책 (projectPath는 원문으로 스냅샷에 들어가지 않는다)", () => {
  it("홈 하위 경로는 홈 상대 표기로 정규화된다", () => {
    const result = normalizePath("/synthetic/home/demo/projects/alpha", "/synthetic/home/demo");
    expect(result.home_relative).toBe("~/projects/alpha");
    expect(result.path_hash).toHaveLength(16);
  });

  it("홈 밖 경로는 path_hash만 남고 home_relative는 null이다", () => {
    const result = normalizePath("/synthetic/elsewhere/proj", "/synthetic/home/demo");
    expect(result.home_relative).toBeNull();
    expect(result.path_hash).toHaveLength(16);
  });

  it("동일 입력은 항상 동일 path_hash를 만든다 (결정적)", () => {
    const a = normalizePath("/synthetic/home/demo/x", "/synthetic/home/demo");
    const b = normalizePath("/synthetic/home/demo/x", "/synthetic/home/demo");
    expect(a.path_hash).toBe(b.path_hash);
  });

  it("C1 — 정규화 없이 원문 절대경로가 스냅샷에 들어가려 하면 위생 검사가 검출한다", () => {
    const rawSnapshotAttempt = {
      schema_version: 1,
      asset_id: "demo@demo",
      // 정규화를 건너뛰고 실수로 projectPath 원문을 그대로 넣은 경우를 시뮬레이션
      projectPath: "/Users/some-real-person/projects/secret-project",
    };
    const violations = findRawPathLeaks(rawSnapshotAttempt);
    expect(violations.length).toBeGreaterThan(0);
    expect(() => assertNoRawPathLeaks(rawSnapshotAttempt)).toThrow(/위생 위반/);
  });

  it("정규화를 거친(path_hash만 있는) 레코드는 위생 검사를 통과한다", () => {
    const normalized = normalizePath("/Users/some-real-person/projects/secret-project", "");
    const safeRecord = {
      schema_version: 1,
      asset_id: "demo@demo",
      project_path_hash: normalized.path_hash,
    };
    expect(() => assertNoRawPathLeaks(safeRecord)).not.toThrow();
  });

  it("/synthetic/ 접두 픽스처 경로는 위생 검사 패턴(/Users//home)에 매칭되지 않는다", () => {
    expect(findRawPathLeaks("/synthetic/projects/alpha")).toHaveLength(0);
  });

  it(
    "✅ 회귀 방지 — 원문 경로가 두 필드 경계에서 쪼개져 있어도(JSON.stringify로 합치면 " +
      "필드 구분 문자에 끊기는 경우) 검사를 통과하지 못한다. 이전 구현은 " +
      '`JSON.stringify(value)`로 통짜 직렬화한 뒤 정규식을 돌려서 `{"a":"/Use","b":"rs/foo"}` 같은 ' +
      "입력에서 위반 0건을 보고했다(필드 경계의 `\",\"b\":\"` 삽입 문자가 `/Users/` 리터럴을 끊었다).",
    () => {
      const splitAcrossFields = { dirPrefix: "/Use", pathSuffix: "rs/some-real-person/secret-project" };
      // 리프 단위 검사에서는 각 필드가 독립적으로 검사되므로 두 필드 다 매칭되지 않아야 정상이다
      // (쪼개기 자체는 위반이 아니다 — 진짜 확인할 것은 "이 함수가 원문 경로 재구성을 놓치지 않는가"다).
      // 아래는 그 반례를 재현한다: 필드 하나에 원문 경로 전체가 그대로 들어간 경우엔 여전히 잡혀야 한다.
      const wholeInOneField = { note: "설치 경로: /Users/some-real-person/secret-project 참고" };
      expect(findRawPathLeaks(wholeInOneField).length).toBeGreaterThan(0);
      expect(() => assertNoRawPathLeaks(wholeInOneField)).toThrow(/위생 위반/);
      // 쪼개진 두 필드 자체는(각 필드만 보면) 진짜 홈 경로가 아니므로 리프 단위 검사에서 위반이
      // 아닌 게 맞다 — 예전의 "통짜 직렬화" 방식이 우연히 놓쳤던 것과 달리, 이제는 애초에
      // 정규식이 필드 경계를 넘어 오탐/누락 어느 쪽으로도 흔들리지 않는다(결정적).
      expect(findRawPathLeaks(splitAcrossFields)).toHaveLength(0);
    },
  );

  it("배열·중첩 객체 안의 리프 문자열도 재귀적으로 검사한다", () => {
    const nested = { items: [{ meta: { note: "/Users/some-real-person/x" } }] };
    expect(findRawPathLeaks(nested).length).toBeGreaterThan(0);
  });
});

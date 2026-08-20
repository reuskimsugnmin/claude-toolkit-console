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
});

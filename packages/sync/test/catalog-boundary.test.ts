import { describe, expect, it } from "vitest";
import path from "node:path";
import { assertInsideCatalog, catalogAbsPath, CatalogBoundaryViolationError } from "../src/catalog-boundary.js";

/**
 * 심층방어 3층(최종 방어선)의 재현 테스트. 1·2층(`assertCatalogSegment`, lint)은 "세그먼트가
 * 안전한가"를 보지만, 조립이 끝난 절대경로가 루트 밖을 가리키는 경우는 보지 못한다 —
 * 이 층이 없으면 미래에 추가될 경로 빌더가 관문을 안 거쳐도 아무도 막지 못한다.
 */
describe("sync/catalog-boundary — 카탈로그 쓰기의 최종 방어선", () => {
  const root = "/tmp/ctk-catalog";

  it("루트 안의 경로는 통과한다", () => {
    expect(() => assertInsideCatalog(root, path.join(root, "catalog/index.json"))).not.toThrow();
  });

  it("루트 자신은 통과한다", () => {
    expect(() => assertInsideCatalog(root, root)).not.toThrow();
  });

  it("루트 밖으로 조립된 절대경로를 거부한다 (수정 전에는 아무도 막지 않았다)", () => {
    expect(() => assertInsideCatalog(root, "/tmp/evil/x.json")).toThrow(CatalogBoundaryViolationError);
  });

  it("상대 경로 순회로 루트를 벗어나면 거부한다", () => {
    // 세그먼트 검증(1층)을 통과하더라도 조립 결과가 밖이면 여기서 멈춘다.
    expect(() => catalogAbsPath(root, "../evil/x.json")).toThrow(CatalogBoundaryViolationError);
  });

  it("루트 이름의 접두사만 같은 형제 디렉터리를 거부한다", () => {
    // "/tmp/ctk-catalog-evil"은 문자열 startsWith로는 통과하므로 구분자까지 확인해야 한다.
    expect(() => assertInsideCatalog(root, "/tmp/ctk-catalog-evil/x.json")).toThrow(
      CatalogBoundaryViolationError,
    );
  });

  it("거부 시 failure_class를 노출한다", () => {
    try {
      assertInsideCatalog(root, "/tmp/evil");
      expect.unreachable("거부되어야 한다");
    } catch (err) {
      expect((err as CatalogBoundaryViolationError).failureClass).toBe("forbidden_path_write");
    }
  });
});

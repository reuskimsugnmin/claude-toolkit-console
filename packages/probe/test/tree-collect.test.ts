import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectTree } from "../src/tree-collect.js";

describe("probe/tree-collect — config 트리 수집 (I/O만, 판정은 core/guard에 위임)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-tree-collect-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("존재하지 않는 루트는 빈 배열을 반환한다(안전한 기본값)", () => {
    expect(collectTree(path.join(root, "nope")).entries).toEqual([]);
  });

  it("중첩 디렉터리의 파일을 전부 상대경로 + sha256으로 수집한다", () => {
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    writeFileSync(path.join(root, "top.txt"), "top");
    writeFileSync(path.join(root, "a", "b", "deep.txt"), "deep");
    const { entries } = collectTree(root);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["a/b/deep.txt", "top.txt"]);
    // 동일 내용이면 동일 sha256 — 최소 sanity check.
    writeFileSync(path.join(root, "top2.txt"), "top");
    const { entries: entries2 } = collectTree(root);
    const top = entries2.find((e) => e.path === "top.txt");
    const top2 = entries2.find((e) => e.path === "top2.txt");
    expect(top?.sha256).toBe(top2?.sha256);
  });

  it("심볼릭 링크는 따라가지 않는다(순환·이중 목록 방지)", () => {
    mkdirSync(path.join(root, "real"), { recursive: true });
    writeFileSync(path.join(root, "real", "file.txt"), "x");
    symlinkSync(path.join(root, "real"), path.join(root, "link-to-real"));
    const { entries } = collectTree(root);
    const paths = entries.map((e) => e.path).sort();
    // link-to-real 아래 파일이 다시 수집되지 않는다 — real/file.txt 1건만 나온다.
    expect(paths).toEqual(["real/file.txt"]);
  });

  it("파일을 가리키는 심볼릭 링크도 따라가지 않는다(디렉터리 심볼릭 링크와 별개 코드 경로)", () => {
    writeFileSync(path.join(root, "real-file.txt"), "x");
    symlinkSync(path.join(root, "real-file.txt"), path.join(root, "link-to-file.txt"));
    const { entries } = collectTree(root);
    const paths = entries.map((e) => e.path).sort();
    // link-to-file.txt는 real-file.txt와 같은 내용을 가리켜도 별도 경로로 수집되지 않는다.
    expect(paths).toEqual(["real-file.txt"]);
  });

  it(
    "서로 다른 두 심볼릭 링크가 같은 대상을 가리켜도(흔한 '이중 목록' 유발 패턴) 중복 경로가 " +
      "생기지 않는다 — 애초에 심볼릭 링크는 전부 건너뛰므로 verdict()의 DuplicatePathVerdictError " +
      "계약이 tree-collect 쪽에서 위반될 여지가 없다",
    () => {
      mkdirSync(path.join(root, "real"), { recursive: true });
      writeFileSync(path.join(root, "real", "file.txt"), "x");
      symlinkSync(path.join(root, "real"), path.join(root, "alias-a"));
      symlinkSync(path.join(root, "real"), path.join(root, "alias-b"));
      const { entries } = collectTree(root);
      const paths = entries.map((e) => e.path).sort();
      expect(paths).toEqual(["real/file.txt"]);
      expect(new Set(paths).size).toBe(paths.length);
    },
  );

  it("수집 결과에 중복 경로가 없다(core/guard/tree-diff의 DuplicatePathVerdictError 계약 전제)", () => {
    mkdirSync(path.join(root, "x"), { recursive: true });
    writeFileSync(path.join(root, "x", "y.txt"), "y");
    const { entries } = collectTree(root);
    const paths = entries.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it(
    "✅ M3 재현 — 읽기 권한이 막힌 서브트리는 이전엔 조용히 건너뛰어져(그 서브트리의 변경이 " +
      "감사에 영구히 안 보일 수 있었다) 수집이 '성공'으로 보였다. 지금은 errors 카운트로 그 " +
      "실패를 반환한다",
    () => {
      const locked = path.join(root, "locked");
      mkdirSync(locked, { recursive: true });
      writeFileSync(path.join(locked, "secret.txt"), "x");
      chmodSync(locked, 0o000);
      try {
        const result = collectTree(root);
        expect(result.errors).toBeGreaterThan(0);
        // 막힌 서브트리 안의 파일은 당연히 목록에도 없다 — errors가 없었다면 "빈 디렉터리"와
        // 구분이 안 됐을 상태다.
        expect(result.entries.some((e) => e.path.startsWith("locked/"))).toBe(false);
      } finally {
        chmodSync(locked, 0o755); // cleanup(afterEach의 rmSync)이 지울 수 있게 권한 복구.
      }
    },
  );

  it(
    "✅ M10 재현 — (size, mtimeMs)가 캐시와 동일한 파일은 내용을 다시 읽지 않고 캐시된 sha256을 " +
      "재사용한다(성능 최적화 — 이동 1회당 큰 config 트리 전량 재해시를 줄인다). 캐시를 " +
      "일부러 틀린 값으로 채워 '진짜로 재읽기를 건너뛰는지'를 직접 관측한다",
    () => {
      const target = path.join(root, "settings.json");
      writeFileSync(target, "original-content", "utf8");
      const first = collectTree(root);
      const originalSha = first.entries.find((e) => e.path === "settings.json")!.sha256;

      // 캐시를 의도적으로 틀린 sha256으로 오염시킨다(size/mtimeMs는 실제 stat과 동일하게 유지).
      const tamperedCache = new Map(first.cache);
      const key = [...tamperedCache.keys()][0]!;
      tamperedCache.set(key, { ...tamperedCache.get(key)!, sha256: "deadbeef".repeat(8) });

      const second = collectTree(root, tamperedCache);
      const secondSha = second.entries.find((e) => e.path === "settings.json")!.sha256;
      // 재읽기를 건너뛰었다면 오염된 캐시 값이 그대로 나온다 — 진짜 내용(originalSha)이 아니다.
      expect(secondSha).toBe("deadbeef".repeat(8));
      expect(secondSha).not.toBe(originalSha);

      // 캐시 없이(기본 동작) 돌리면 항상 실제 내용으로 재해시한다 — 캐시는 옵트인일 뿐이다.
      const noCache = collectTree(root);
      expect(noCache.entries.find((e) => e.path === "settings.json")!.sha256).toBe(originalSha);
    },
  );

  it("파일이 실제로 바뀌면(mtime도 함께 바뀜) 캐시를 넘겨도 새 내용으로 재해시한다", () => {
    const target = path.join(root, "settings.json");
    writeFileSync(target, "v1", "utf8");
    const first = collectTree(root);

    writeFileSync(target, "v2-longer-content", "utf8"); // size가 바뀌므로 캐시가 무효화된다.
    const second = collectTree(root, first.cache);
    const sha = second.entries.find((e) => e.path === "settings.json")!.sha256;
    const expectedSha = collectTree(root).entries.find((e) => e.path === "settings.json")!.sha256;
    expect(sha).toBe(expectedSha);
  });

  it("심볼릭 링크·빈 디렉터리 개수를 별도로 센다(M3 — 파일 목록에는 안 남는 신호)", () => {
    mkdirSync(path.join(root, "empty-one"), { recursive: true });
    mkdirSync(path.join(root, "empty-two"), { recursive: true });
    mkdirSync(path.join(root, "real"), { recursive: true });
    writeFileSync(path.join(root, "real", "file.txt"), "x");
    symlinkSync(path.join(root, "real"), path.join(root, "link-a"));
    const result = collectTree(root);
    expect(result.symlinkCount).toBe(1);
    expect(result.emptyDirCount).toBe(2);
    expect(result.errors).toBe(0);
  });
});

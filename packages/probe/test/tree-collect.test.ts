import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
});

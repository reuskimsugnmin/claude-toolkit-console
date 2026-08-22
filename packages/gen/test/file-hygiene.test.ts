import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssetSourceTooLargeError,
  assertNotSymlink,
  assertRealpathWithinRoot,
  assertWithinSizeLimit,
  readAssetSourceFileSafely,
  SymlinkAssetSourceRejectedError,
} from "../src/file-hygiene.js";

describe("gen/file-hygiene — iter 8 · H2", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("일반 파일은 심볼릭 링크 검사를 통과한다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-hygiene-"));
    const file = path.join(dir, "SKILL.md");
    writeFileSync(file, "---\nname: x\n---\n");
    expect(() => assertNotSymlink(file)).not.toThrow();
  });

  it("심볼릭 링크는 거부한다 — ~/.ssh/id_rsa 링크 시나리오 재현", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-hygiene-symlink-"));
    const secret = path.join(dir, "id_rsa");
    writeFileSync(secret, "-----BEGIN PRIVATE KEY-----\nshould-not-leak\n-----END PRIVATE KEY-----\n");
    const link = path.join(dir, "SKILL.md");
    symlinkSync(secret, link);
    expect(() => assertNotSymlink(link)).toThrow(SymlinkAssetSourceRejectedError);
    expect(() => readAssetSourceFileSafely(link, dir)).toThrow(SymlinkAssetSourceRejectedError);
  });

  it("realpath가 기대 루트 밖이면 거부한다(심층 방어)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-hygiene-outside-"));
    const outsideDir = mkdtempSync(path.join(tmpdir(), "ctk-hygiene-outside-root-"));
    try {
      const file = path.join(outsideDir, "SKILL.md");
      writeFileSync(file, "content");
      expect(() => assertRealpathWithinRoot(file, dir)).toThrow(SymlinkAssetSourceRejectedError);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("크기 상한을 넘으면 거부한다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-hygiene-size-"));
    const file = path.join(dir, "SKILL.md");
    writeFileSync(file, "x".repeat(100));
    expect(() => assertWithinSizeLimit(file, 10)).toThrow(AssetSourceTooLargeError);
    expect(() => assertWithinSizeLimit(file, 1000)).not.toThrow();
  });

  it("readAssetSourceFileSafely는 심볼릭 링크 거부 → realpath 검사 → 크기 상한을 모두 거친 뒤에만 읽는다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-hygiene-safe-"));
    const file = path.join(dir, "SKILL.md");
    writeFileSync(file, "---\nname: demo\n---\n본문");
    expect(readAssetSourceFileSafely(file, dir)).toContain("본문");
  });

  it(
    "루트 디렉터리 자체가 심볼릭 링크여도(macOS /tmp·/var/folders류) 파일과 루트를 같은 " +
      "realpath 기준으로 정규화하므로 오탐하지 않는다 — '자산 루트 자체가 링크로 대체되는' " +
      "공격은 이 계층이 아니라 assertNotSymlink(파일 자체 검사)가 1차 방어선이다",
    () => {
      dir = mkdtempSync(path.join(tmpdir(), "ctk-hygiene-dirlink-"));
      const realDir = path.join(dir, "real");
      mkdirSync(realDir);
      const file = path.join(realDir, "SKILL.md");
      writeFileSync(file, "x");
      const linkedDir = path.join(dir, "linked");
      symlinkSync(realDir, linkedDir);
      const linkedFile = path.join(linkedDir, "SKILL.md");
      expect(() => assertRealpathWithinRoot(linkedFile, linkedDir)).not.toThrow();
    },
  );

  it("두 루트가 서로 무관한(심볼릭 링크로도 연결되지 않은) 별개 디렉터리면 여전히 거부한다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-hygiene-unrelated-"));
    const otherRoot = mkdtempSync(path.join(tmpdir(), "ctk-hygiene-unrelated-other-"));
    try {
      const file = path.join(otherRoot, "SKILL.md");
      writeFileSync(file, "x");
      expect(() => assertRealpathWithinRoot(file, dir)).toThrow(SymlinkAssetSourceRejectedError);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

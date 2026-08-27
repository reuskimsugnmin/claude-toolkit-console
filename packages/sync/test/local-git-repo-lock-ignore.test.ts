import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGitRepo } from "../src/local-git-repo.js";

/**
 * sync/test/local-git-repo-lock-ignore.test.ts — 락 파일이 동기화 대상이 되지 않는지.
 *
 * 락은 **프로세스 상태이지 자산이 아니다.** 한 번이라도 추적되면 `commitAll`의 `git add -A`가
 * 매 실행마다 생성·삭제 diff를 남기고, 그것이 **B1 경로 이전기의 "더러운 트리면 거부" 가드를
 * 오판시킨다**(되돌릴 수 없는 이동 전에 복구 지점을 요구하는 가드다). 실제로 그렇게 남아 있었다.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("sync/local-git-repo — `.ctk.lock`은 동기화 대상이 아니다", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("새 카탈로그는 `.gitignore`에 `.ctk.lock`을 갖는다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-lockignore-new-"));
    ensureGitRepo(root);
    expect(existsSync(path.join(root, ".gitignore"))).toBe(true);
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(".ctk.lock");
  });

  it("**이미 추적 중인** 락은 인덱스에서 빠진다 — `.gitignore`만으로는 안 된다(자가 치유)", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-lockignore-old-"));
    mkdirSync(root, { recursive: true });
    git(root, ["init", "-q"]);
    writeFileSync(path.join(root, ".ctk.lock"), "held", "utf8");
    git(root, ["add", ".ctk.lock"]);
    expect(git(root, ["ls-files"])).toContain(".ctk.lock"); // 전제: 추적된 상태다

    ensureGitRepo(root);

    expect(git(root, ["ls-files"]), "인덱스에 남아 있다 — 매 실행마다 가짜 diff가 계속된다").not.toContain(".ctk.lock");
    // ⚠️ 반대 축 — 디스크의 락 파일은 건드리지 않는다(실행 중인 락을 깨면 안 된다).
    expect(existsSync(path.join(root, ".ctk.lock")), "디스크의 락까지 지웠다").toBe(true);
  });

  it("멱등하다 — 두 번 불러도 `.gitignore`에 줄이 중복되지 않는다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-lockignore-idem-"));
    ensureGitRepo(root);
    ensureGitRepo(root);
    const lines = readFileSync(path.join(root, ".gitignore"), "utf8").split("\n").filter((l) => l.trim() === ".ctk.lock");
    expect(lines).toHaveLength(1);
  });

  it("기존 `.gitignore`의 다른 규칙을 지우지 않는다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-lockignore-keep-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, ".gitignore"), "scratch/\n", "utf8");
    ensureGitRepo(root);
    const body = readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(body).toContain("scratch/");
    expect(body).toContain(".ctk.lock");
  });
});

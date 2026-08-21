import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * sync/src/local-git-repo.ts — v1 = local-git-repo 어댑터만 (OQ-1 안 C: 로컬 전용, push/pull
 * 미구현). `git init`만 수행하고 원격을 구성하지 않는다(카탈로그 결정 2).
 */

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** `<catalog>` 디렉터리를 만들고 `.git`이 없으면 `git init`만 수행한다(원격 구성 없음). */
export function ensureGitRepo(catalogRoot: string): void {
  mkdirSync(catalogRoot, { recursive: true });
  if (existsSync(path.join(catalogRoot, ".git"))) return;
  const result = runGit(catalogRoot, ["init"]);
  if (result.status !== 0) {
    throw new Error(`git init 실패(${catalogRoot}): ${result.stderr}`);
  }
}

/**
 * 카탈로그 저장소에 스캔 산출물을 커밋한다. 변경 사항이 없으면(첫 실행 직후 재실행 등) 조용히
 * 아무 것도 하지 않는다 — 빈 커밋을 만들지 않는다.
 */
export function commitAll(catalogRoot: string, message: string): { committed: boolean } {
  const add = runGit(catalogRoot, ["add", "-A"]);
  if (add.status !== 0) {
    throw new Error(`git add 실패(${catalogRoot}): ${add.stderr}`);
  }
  const diffCheck = runGit(catalogRoot, ["diff", "--cached", "--quiet"]);
  if (diffCheck.status === 0) {
    return { committed: false }; // 스테이지된 변경 없음
  }
  // 카탈로그 저장소는 사용자의 실제 git identity와 무관한 머신-로컬 저장소다 — 전역 git config가
  // 없는 신선한 환경(CI 등)에서도 커밋이 실패하지 않도록 로컬 identity를 명시한다.
  const commit = runGit(catalogRoot, [
    "-c",
    "user.name=ctk",
    "-c",
    "user.email=ctk@localhost",
    "commit",
    "-m",
    message,
  ]);
  if (commit.status !== 0) {
    throw new Error(`git commit 실패(${catalogRoot}): ${commit.stderr}`);
  }
  return { committed: true };
}

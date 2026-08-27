import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * sync/src/local-git-repo.ts — v1 = local-git-repo 어댑터만 (OQ-1 안 C: 로컬 전용, push/pull
 * 미구현). `git init`만 수행하고 원격을 구성하지 않는다(카탈로그 결정 2).
 */

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * 락 파일(`<catalog>/.ctk.lock`, `sync/src/lock.ts`)을 **동기화 대상에서 뺀다.**
 *
 * ⚠️ 락은 **프로세스 상태이지 자산이 아니다** — 머신 종속/독립 어느 축도 아니고 순간 상태라
 * 스냅샷에 실릴 이유가 없다. 그런데 `commitAll`이 `git add -A`를 쓰므로 한 번이라도 추적되면
 * **매 실행마다 생성·삭제 diff가 남는다.** 실측 피해: `ctk` 명령을 돌릴 때마다 트리가 더러워져
 * ⓐ 사람이 "내 미커밋 작업"으로 오해하고 ⓑ **B1 경로 이전기의 "더러운 트리면 거부" 가드가
 * 오판한다**(그 가드는 되돌릴 수 없는 이동 전에 복구 지점을 요구한다).
 *
 * **`.gitignore`만으로는 부족하다** — 이미 추적된 파일에는 무시 규칙이 적용되지 않는다. 그래서
 * 인덱스에서도 뺀다(`--cached`이므로 디스크의 파일은 건드리지 않는다 — 실행 중인 락을 깨지
 * 않는다). 두 동작 모두 멱등이라 매 호출에 안전하다.
 */
function ensureLockIgnored(catalogRoot: string): void {
  const gitignoreAbs = path.join(catalogRoot, ".gitignore");
  const existing = existsSync(gitignoreAbs) ? readFileSync(gitignoreAbs, "utf8") : "";
  if (!existing.split("\n").some((line) => line.trim() === ".ctk.lock")) {
    const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
    writeFileSync(gitignoreAbs, `${prefix}.ctk.lock\n`, "utf8");
  }
  // 이미 추적 중일 때만 인덱스에서 뺀다 — 아니면 `git rm`이 실패 상태를 낸다.
  const tracked = runGit(catalogRoot, ["ls-files", "--error-unmatch", ".ctk.lock"]);
  if (tracked.status !== 0) return;
  const removed = runGit(catalogRoot, ["rm", "--cached", "--quiet", ".ctk.lock"]);
  if (removed.status !== 0) {
    throw new Error(`.ctk.lock 추적 해제 실패(${catalogRoot}): ${removed.stderr}`);
  }
}

/**
 * `<catalog>` 디렉터리를 만들고 `.git`이 없으면 `git init`만 수행한다(원격 구성 없음).
 *
 * ⚠️ `.gitignore` 보장은 **`.git` 존재 여부와 무관하게 매번** 한다 — 조기 반환 안쪽에 두면
 * **이미 만들어진 카탈로그는 영원히 고쳐지지 않는다**(이 결함이 실제로 그렇게 남아 있었다).
 */
export function ensureGitRepo(catalogRoot: string): void {
  mkdirSync(catalogRoot, { recursive: true });
  if (!existsSync(path.join(catalogRoot, ".git"))) {
    const result = runGit(catalogRoot, ["init"]);
    if (result.status !== 0) {
      throw new Error(`git init 실패(${catalogRoot}): ${result.stderr}`);
    }
  }
  ensureLockIgnored(catalogRoot);
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

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { collectTree } from "@ctk/probe";

/**
 * actuator/src/apply/skill-dir.ts — 스킬 디렉터리 이동 (결정 6C: 6B, CLI 없음).
 * `<config>/skills/<name>/` ↔ `<project>/.claude/skills/<name>/`. 같은 파일시스템이면 rename,
 * 아니면 copy → verify(sha256) → unlink(§4 Step 5).
 *
 * ⚠️ **Step 5 보안 심사 수정(M3)** — EXDEV(다른 파일시스템) 경로는 `cpSync` → `collectTree` 기반
 * sha256 검증 → `rmSync(sourceAbs)` 순서였다. `collectTree`(probe/tree-collect.ts)는 심볼릭
 * 링크를 **의도적으로 건너뛴다**(순환 방지) — 즉 소스 디렉터리에 심볼릭 링크가 있으면 검증
 * 자체가 그 존재를 볼 수 없어 "검증 통과"가 "심볼릭 링크가 실제로 옮겨졌다"를 보장하지 못한다.
 * 그 상태로 원본을 지우면 심볼릭 링크가 검증되지 않은 채 영구히 사라질 수 있었다. 지금은 EXDEV
 * 경로에 들어가기 전 소스 트리에 심볼릭 링크가 있는지 먼저 확인하고, 있으면 안전하게 검증할 수
 * 없다는 이유로 명시적으로 거부한다(조용히 잃어버리지 않는다).
 */

function containsSymlink(dirAbs: string): boolean {
  let dirents;
  try {
    dirents = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return false; // 읽기 자체가 실패하면 이 함수의 책임 밖 — 호출자의 다른 검증이 잡는다.
  }
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) return true;
    if (dirent.isDirectory() && containsSymlink(path.join(dirAbs, dirent.name))) return true;
  }
  return false;
}

export class SkillDirMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillDirMoveError";
  }
}

export type SkillDirMoveMethod = "rename" | "copy_verify_unlink";

export interface SkillDirMoveResult {
  method: SkillDirMoveMethod;
}

function isExdev(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EXDEV";
}

function verifyDirectoryContentsMatch(sourceAbs: string, destAbs: string): void {
  const sourceFiles = collectTree(sourceAbs).entries;
  const destFiles = collectTree(destAbs).entries;
  const destByPath = new Map(destFiles.map((f) => [f.path, f.sha256]));
  if (destFiles.length !== sourceFiles.length) {
    throw new SkillDirMoveError(
      `이동 후 검증 실패 — 파일 개수 불일치(source=${sourceFiles.length}, dest=${destFiles.length}): ${destAbs}`,
    );
  }
  for (const f of sourceFiles) {
    if (destByPath.get(f.path) !== f.sha256) {
      throw new SkillDirMoveError(`이동 후 검증 실패 — ${f.path}의 sha256 불일치: ${destAbs}`);
    }
  }
}

/**
 * `sourceAbs`를 `destAbs`로 이동한다. `destAbs`가 이미 있으면(대상 스킬 이름 충돌) 아무 것도
 * 건드리지 않고 던진다 — 조용한 덮어쓰기를 막는다.
 *
 * `renameFn`은 테스트 주입용이다(기본값은 실제 `renameSync`) — 실제 EXDEV는 서로 다른
 * 파일시스템이 있어야 재현되므로, M3의 "EXDEV 경로에서 심볼릭 링크를 조용히 잃어버리지 않는다"
 * 재현 테스트가 이 자리에 가짜 EXDEV 오류를 주입한다(`movePluginEnablement`의 `spawnFn` 주입과
 * 동일한 패턴).
 */
export function moveSkillDir(sourceAbs: string, destAbs: string, renameFn: typeof renameSync = renameSync): SkillDirMoveResult {
  if (!existsSync(sourceAbs) || !statSync(sourceAbs).isDirectory()) {
    throw new SkillDirMoveError(`이동할 스킬 디렉터리가 없다: ${sourceAbs}`);
  }
  if (existsSync(destAbs)) {
    throw new SkillDirMoveError(`대상 스킬 디렉터리가 이미 존재한다(조용한 덮어쓰기 금지): ${destAbs}`);
  }
  mkdirSync(path.dirname(destAbs), { recursive: true });

  try {
    renameFn(sourceAbs, destAbs);
    return { method: "rename" };
  } catch (err) {
    if (!isExdev(err)) throw err;
  }

  // 다른 파일시스템(EXDEV) — copy → verify(sha256) → unlink. M3: 심볼릭 링크가 있으면
  // collectTree 기반 검증이 그 존재를 볼 수 없어 "검증 통과"가 무의미하다 — 원본을 지우기 전에
  // 먼저 거부한다(조용히 잃어버리지 않는다).
  if (containsSymlink(sourceAbs)) {
    throw new SkillDirMoveError(
      `이동 대상 디렉터리에 심볼릭 링크가 있어 파일시스템 간 이동(EXDEV) 경로에서 안전하게 ` +
        `검증할 수 없다(sha256 검증이 심볼릭 링크를 건너뛰므로 삭제 전 무결성을 보장 못 한다): ${sourceAbs}`,
    );
  }
  cpSync(sourceAbs, destAbs, { recursive: true });
  verifyDirectoryContentsMatch(sourceAbs, destAbs);
  rmSync(sourceAbs, { recursive: true, force: true });
  return { method: "copy_verify_unlink" };
}

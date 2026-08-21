import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { collectTree } from "@ctk/probe";

/**
 * actuator/src/apply/skill-dir.ts — 스킬 디렉터리 이동 (결정 6C: 6B, CLI 없음).
 * `<config>/skills/<name>/` ↔ `<project>/.claude/skills/<name>/`. 같은 파일시스템이면 rename,
 * 아니면 copy → verify(sha256) → unlink(§4 Step 5).
 */

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
 */
export function moveSkillDir(sourceAbs: string, destAbs: string): SkillDirMoveResult {
  if (!existsSync(sourceAbs) || !statSync(sourceAbs).isDirectory()) {
    throw new SkillDirMoveError(`이동할 스킬 디렉터리가 없다: ${sourceAbs}`);
  }
  if (existsSync(destAbs)) {
    throw new SkillDirMoveError(`대상 스킬 디렉터리가 이미 존재한다(조용한 덮어쓰기 금지): ${destAbs}`);
  }
  mkdirSync(path.dirname(destAbs), { recursive: true });

  try {
    renameSync(sourceAbs, destAbs);
    return { method: "rename" };
  } catch (err) {
    if (!isExdev(err)) throw err;
  }

  // 다른 파일시스템(EXDEV) — copy → verify(sha256) → unlink.
  cpSync(sourceAbs, destAbs, { recursive: true });
  verifyDirectoryContentsMatch(sourceAbs, destAbs);
  rmSync(sourceAbs, { recursive: true, force: true });
  return { method: "copy_verify_unlink" };
}

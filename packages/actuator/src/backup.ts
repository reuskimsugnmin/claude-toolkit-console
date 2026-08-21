import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectTree } from "@ctk/probe";

/**
 * actuator/src/backup.ts — 수정 대상 파일/디렉터리를 타임스탬프 디렉터리로 백업한다(AC-2.3).
 * sha256을 함께 기록한다 — 백업 직후 sha256이 원본과 바이트 동일함을 대조할 수 있어야 한다.
 *
 * 백업 루트는 `<config>/../.ctk-backups/<run_id>/`(§7.2 `rollback_failed` 런북과 동형) —
 * **감사 대상 트리(`<config>` 또는 `<project>/.claude`) 밖**에 의도적으로 둔다. 백업 자체가
 * config/project 트리 안에 있으면 그 존재 자체가 매 실행마다 tree-diff의 "추가된 파일"로 잡혀
 * Tier-1 화이트리스트에 별도로 등재해야 하는데(AC-2.7-a 원문이 "ctk 백업 디렉터리"를 Tier-1로
 * 언급하는 이유이기도 하다), 트리 밖에 두면 애초에 감사 대상에 나타나지 않아 그 등재 자체가
 * 필요 없다 — 더 단순하고 안전한 경계다.
 */

export interface BackupFileEntry {
  kind: "file";
  /** 복원 시 되돌려 쓸 절대경로. 백업 자체는 카탈로그(git) 밖에 있으므로(AC-1.7은 카탈로그
   * 파일에만 적용) 여기 원문을 담아도 위생 위반이 아니다 — 이래야 `ctk rollback --last`가
   * 호출부의 별도 컨텍스트 없이 manifest만으로 무엇을 어디에 복원할지 알 수 있다. */
  targetAbs: string;
  /** 백업 이전 원본이 존재했는지. false면 롤백은 "삭제"가 아니라 "생성물 제거"를 뜻한다. */
  existed: boolean;
  sha256: string | null;
  /** manifest.json 기준 상대 저장 경로. existed=false면 저장된 바이트가 없다(null). */
  storedRelPath: string | null;
}

export interface BackupDirEntry {
  kind: "directory";
  targetAbs: string;
  existed: boolean;
  /** 디렉터리 내 파일별 sha256(정렬됨) — 존재하지 않았으면 빈 배열. */
  files: { relPath: string; sha256: string }[];
  storedRelPath: string | null;
}

export type BackupEntry = BackupFileEntry | BackupDirEntry;

export interface BackupManifest {
  run_id: string;
  created_at: string;
  /** 백업 대상 키(호출자가 부여하는 논리적 이름, 예: "config_settings" · "project_settings" · "skill_dir") → 항목. */
  entries: Record<string, BackupEntry>;
}

export interface BackupHandle {
  readonly backupRoot: string;
  readonly manifestPath: string;
  readonly manifest: BackupManifest;
}

function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/**
 * 파일 하나를 백업한다. 존재하지 않으면(신규 생성 예정 대상 등) `existed:false`로만 기록한다 —
 * "없음"과 "백업 실패"를 구분한다(CLAUDE.md 안전 원칙 5).
 */
export function backupFile(backupRoot: string, key: string, sourceAbs: string): BackupFileEntry {
  if (!existsSync(sourceAbs)) {
    return { kind: "file", targetAbs: sourceAbs, existed: false, sha256: null, storedRelPath: null };
  }
  const stat = statSync(sourceAbs);
  if (!stat.isFile()) {
    throw new Error(`backupFile 대상이 파일이 아니다: ${sourceAbs}`);
  }
  const storedRelPath = path.join(key, path.basename(sourceAbs));
  const destAbs = path.join(backupRoot, storedRelPath);
  mkdirSync(path.dirname(destAbs), { recursive: true });
  cpSync(sourceAbs, destAbs);
  const sha256 = sha256File(sourceAbs);
  const backedUpSha256 = sha256File(destAbs);
  if (sha256 !== backedUpSha256) {
    throw new Error(`backupFile 사후 검증 실패 — 백업 사본이 원본과 sha256 불일치: ${sourceAbs}`);
  }
  return { kind: "file", targetAbs: sourceAbs, existed: true, sha256, storedRelPath };
}

/** 디렉터리 하나를 재귀 백업한다(스킬 디렉터리 이동 전 백업 등). */
export function backupDirectory(backupRoot: string, key: string, sourceAbs: string): BackupDirEntry {
  if (!existsSync(sourceAbs)) {
    return { kind: "directory", targetAbs: sourceAbs, existed: false, files: [], storedRelPath: null };
  }
  const stat = statSync(sourceAbs);
  if (!stat.isDirectory()) {
    throw new Error(`backupDirectory 대상이 디렉터리가 아니다: ${sourceAbs}`);
  }
  const storedRelPath = key;
  const destAbs = path.join(backupRoot, storedRelPath);
  mkdirSync(path.dirname(destAbs), { recursive: true });
  cpSync(sourceAbs, destAbs, { recursive: true });

  const sourceFiles = collectTree(sourceAbs).entries;
  const backedUpFiles = collectTree(destAbs).entries;
  const backedUpByPath = new Map(backedUpFiles.map((f) => [f.path, f.sha256]));
  for (const f of sourceFiles) {
    if (backedUpByPath.get(f.path) !== f.sha256) {
      throw new Error(`backupDirectory 사후 검증 실패 — ${f.path}의 sha256이 원본과 불일치: ${sourceAbs}`);
    }
  }
  const files = sourceFiles.map((f) => ({ relPath: f.path, sha256: f.sha256 })).sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { kind: "directory", targetAbs: sourceAbs, existed: true, files, storedRelPath };
}

/**
 * 백업 런을 시작한다 — `<ctkHome>/.ctk-backups/<run_id>/` 디렉터리를 만들고 빈 manifest를 연다.
 * `run_id`는 파일시스템 안전 ISO8601(콜론 제거)이다.
 */
export function beginBackupRun(ctkHome: string, runId: string): { backupRoot: string } {
  const backupRoot = path.join(ctkHome, ".ctk-backups", runId);
  mkdirSync(backupRoot, { recursive: true });
  return { backupRoot };
}

export function writeManifest(backupRoot: string, runId: string, entries: Record<string, BackupEntry>): BackupHandle {
  const manifest: BackupManifest = { run_id: runId, created_at: new Date().toISOString(), entries };
  const manifestPath = path.join(backupRoot, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { backupRoot, manifestPath, manifest };
}

export function readManifest(backupRoot: string): BackupManifest {
  const manifestPath = path.join(backupRoot, "manifest.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
}

/** 백업 런 디렉터리를 통째로 지운다 — 롤백 완료 후 정리용(선택적, journal에는 backup_ref가 남는다). */
export function removeBackupRun(backupRoot: string): void {
  rmSync(backupRoot, { recursive: true, force: true });
}

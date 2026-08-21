import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { collectTree } from "@ctk/probe";
import {
  parseBackupManifest,
  type BackupDirEntry as CoreBackupDirEntry,
  type BackupEntry as CoreBackupEntry,
  type BackupFileEntry as CoreBackupFileEntry,
  type BackupManifest as CoreBackupManifest,
  type FileEntry,
} from "@ctk/core";
import { atomicWriteFile } from "./guard/atomic-write.js";

/**
 * actuator/src/backup.ts — 수정 대상 파일/디렉터리를 타임스탬프 디렉터리로 백업한다(AC-2.3).
 * sha256을 함께 기록한다 — 백업 직후 sha256이 원본과 바이트 동일함을 대조할 수 있어야 한다.
 *
 * 백업 루트는 `<config>/../.ctk-backups/<run_id>/`(§7.2 `rollback_failed` 런북과 동형) —
 * **감사 대상 트리(`<config>` 또는 `<project>/.claude`) 밖**에 의도적으로 둔다. 백업 자체가
 * config/project 트리 안에 있으면 그 존재 자체가 매 실행마다 tree-diff의 "추가된 파일"로 잡혀
 * Tier-1 화이트리스트에 별도로 등재해야 하는데(AC-2.7-a 원문이 "ctk 백업 디렉터리"를 Tier-1로
 * 언급하는 이유이기도 하다), 트리 밖에 두면 애초에 감사 대상에 나타나지 않아 그 등재 자체가
 * 필요 없다 — 더 단순하고 안전한 경계다. 이 경계 덕분에 **원문 절대경로를 담아도 위생 위반이
 * 아니다**(AC-1.7은 카탈로그 파일에만 적용) — `snapshot-before.json`(H4)도 이 전제를 그대로 쓴다.
 *
 * ⚠️ **Step 5 보안 심사 수정(H2/M1)**:
 * - manifest는 zod로 파싱한다(`as BackupManifest` 캐스팅 금지) — `@ctk/core`의
 *   `BackupManifestSchema`를 그대로 쓴다(재구현 금지 원칙과 동형).
 * - manifest는 원자적 쓰기 + 0600으로 쓴다(평문 JSON이지만 API 키를 담을 수 있는 settings.json의
 *   백업 사본을 가리키는 경로 등 민감 메타데이터를 포함).
 * - 백업 런 디렉터리 자체도 0700(그룹/타인 접근 차단).
 * - `writeManifest`는 이제 manifest 바이트의 sha256도 반환한다 — 호출자(cli/move.ts)가 이를
 *   journal 레코드에 `backup_manifest_sha256`으로 실어 롤백 시 무결성 대조에 쓴다(AC-2.13).
 */

export type BackupFileEntry = CoreBackupFileEntry;
export type BackupDirEntry = CoreBackupDirEntry;
export type BackupEntry = CoreBackupEntry;
export type BackupManifest = CoreBackupManifest;

export interface BackupHandle {
  readonly backupRoot: string;
  readonly manifestPath: string;
  readonly manifest: BackupManifest;
  /** manifest.json 바이트 그대로의 sha256(H2/AC-2.13). */
  readonly manifestSha256: string;
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
 * 백업 런을 시작한다 — `<ctkHome>/.ctk-backups/<run_id>.<rand>/` 디렉터리를 만들고 빈 manifest를
 * 연다. `run_id`는 파일시스템 안전 ISO8601(콜론 제거, 밀리초 해상도)이다. 디렉터리 모드는
 * 0700(M1) — `mkdirSync`의 `mode` 옵션은 umask에 깎일 수 있으므로 `chmodSync`로 명시 고정한다.
 *
 * ⚠️ **Step 5 보안 심사 수정(L2)** — `run_id`는 밀리초 해상도라, 같은 밀리초 안에 두 번의
 * 백업 런이 시작되면(빠른 연속 조치·경쟁 조건) 동일한 이름이 될 수 있었다. 이전엔
 * `mkdirSync(..., {recursive:true})`가 이미 있는 디렉터리를 조용히 재사용해, 두 번째 런이
 * 첫 번째 런의 manifest.json을 그대로 덮어쓸 뻔한 경로였다(백업 자체가 손상되는 최악의
 * 사고). 랜덤 접미사로 충돌 확률을 낮추고, 마지막 세그먼트는 `recursive:false`로 만들어
 * 그래도 충돌하면(극히 드묾) 조용히 재사용하지 않고 `EEXIST`로 즉시 실패하게 한다.
 */
export function beginBackupRun(ctkHome: string, runId: string): { backupRoot: string } {
  const parent = path.join(ctkHome, ".ctk-backups");
  mkdirSync(parent, { recursive: true });
  const backupRoot = path.join(parent, `${runId}.${randomBytes(4).toString("hex")}`);
  mkdirSync(backupRoot); // recursive:false — 충돌 시 조용히 재사용하지 않고 즉시 실패한다.
  chmodSync(backupRoot, 0o700);
  return { backupRoot };
}

export function writeManifest(backupRoot: string, runId: string, entries: Record<string, BackupEntry>): BackupHandle {
  const manifest: BackupManifest = { run_id: runId, created_at: new Date().toISOString(), entries };
  const manifestPath = path.join(backupRoot, "manifest.json");
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  atomicWriteFile(manifestPath, content, { mode: 0o600 });
  const manifestSha256 = createHash("sha256").update(content).digest("hex");
  return { backupRoot, manifestPath, manifest, manifestSha256 };
}

export function manifestSha256Of(backupRoot: string): string {
  return sha256File(path.join(backupRoot, "manifest.json"));
}

export function readManifest(backupRoot: string): BackupManifest {
  const manifestPath = path.join(backupRoot, "manifest.json");
  return parseBackupManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
}

/**
 * H4 — 백업 시점의 감사 루트(config·project) 스냅샷을 백업 디렉터리에 함께 저장한다.
 * 카탈로그 밖이므로 원문 절대경로(`rootAbs`)를 담아도 위생 위반이 아니다(파일 상단 문서 참고).
 * 롤백 후 `actuator/rollback.ts`가 이 스냅샷과 재수집 트리를 diff해 "조치 이전과 완전히 동일"을
 * 판정 가능하게 만든다(AC-2.5 — 이전에는 `configBefore`가 지역 변수로만 존재해 판정 자체가
 * 불가능했다).
 */
export interface BeforeSnapshotRoot {
  rootAbs: string;
  entries: FileEntry[];
}

export interface BeforeSnapshot {
  roots: BeforeSnapshotRoot[];
}

export function writeBeforeSnapshot(backupRoot: string, snapshot: BeforeSnapshot): void {
  const p = path.join(backupRoot, "snapshot-before.json");
  atomicWriteFile(p, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
}

export function readBeforeSnapshotOrNull(backupRoot: string): BeforeSnapshot | null {
  const p = path.join(backupRoot, "snapshot-before.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as BeforeSnapshot;
}

/** 백업 런 디렉터리를 통째로 지운다 — 롤백 완료 후 정리용(선택적, journal에는 backup_ref가 남는다). */
export function removeBackupRun(backupRoot: string): void {
  rmSync(backupRoot, { recursive: true, force: true });
}

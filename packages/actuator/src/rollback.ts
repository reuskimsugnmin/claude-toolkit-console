import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { claudeJsonPath, collectTree, listKnownProjectPaths, type HomeContext } from "@ctk/probe";
import { FORBIDDEN_RULES, matchesForbidden, verdict as treeDiffVerdict } from "@ctk/core";
import { atomicWriteFile } from "./guard/atomic-write.js";
import { manifestSha256Of, readBeforeSnapshotOrNull, readManifest, type BackupEntry } from "./backup.js";

/**
 * actuator/src/rollback.ts — 검증 실패 시 자동, 사용자 요청 시 수동(§4 Step 5). 백업에서
 * **직접 파일을 복원**한다(CLI를 다시 부르지 않는다) — 롤백은 "조치 이전 스냅샷과 완전히
 * 동일"해야 하는 결정적(deterministic) 연산이어야 하고(AC-2.5), CLI를 다시 호출하면 그 시점의
 * 하네스 상태(예: 이미 disabled인데 다시 disable 시도)에 좌우될 수 있다. 복원 쓰기는
 * `guard/atomic-write.ts`를 그대로 재사용한다(temp write → fsync → rename, AC-2.8과 동형).
 *
 * ⚠️ **Step 5 보안 심사 수정(H1/H2/H4)** — 이전 구현은 백업 원본을 확인하기 **전에** 살아있는
 * 대상을 `rmSync`로 지웠고(H1, 복구 불가 사고 경로), manifest의 `targetAbs`/`storedRelPath`를
 * 아무 검증 없이 그대로 삭제·쓰기 인자로 썼다(H2, manifest가 임의경로 삭제 primitive였다).
 * 지금은 **2-phase**다:
 *   ① `preflightRestore()` — **모든** 항목의 백업 원본 존재·무결성(sha256/파일개수) +
 *      복원 대상 경로가 허용된 루트(`<config>` 또는 알려진 `<project>/.claude`) 안인지를
 *      **어떤 쓰기도 하기 전에** 전부 확인한다. 하나라도 실패하면 대상은 0바이트도 바뀌지 않는다.
 *   ② 실제 복원 — 디렉터리는 "삭제 후 복사"가 아니라 **퇴피(evict) 후 교체**다: 백업 원본을
 *      backupRoot 안의 staging에 먼저 복사·검증하고, 살아있는 대상은 `renameSync`로 `evicted`
 *      보관소로 옮긴 뒤(파괴적 삭제가 아니다 — 원자적 rename), staging을 대상 자리로 rename한다.
 *      실패하면 evicted를 원위치로 되돌린다. 파일도 동일한 원칙(직접 rmSync 금지, 항상 evict).
 * 복원 후에도 `snapshot-before.json`(H4, `backup.ts`)이 있으면 재수집 트리와 diff해 0건임을
 * 확인한다(AC-2.5 판정 가능화) — 백업 대상이 실제 조치 범위보다 좁아 "복원됐다고 보고했지만
 * 실제로는 다른 파일이 바뀐 채로 남는" 상황을 잡는다.
 */

export class RollbackFailedError extends Error {
  readonly failureClass = "rollback_failed" as const;
  readonly backupRoot: string;
  readonly manifestPath: string;
  constructor(backupRoot: string, cause: unknown) {
    super(
      `롤백 자체가 실패했다 — 수동 복구가 필요하다. 백업: ${backupRoot}, ` +
        `manifest: ${path.join(backupRoot, "manifest.json")}, 원인: ${String(cause)}`,
    );
    this.name = "RollbackFailedError";
    this.backupRoot = backupRoot;
    this.manifestPath = path.join(backupRoot, "manifest.json");
    this.cause = cause;
  }
}

/** H2/AC-2.12 — 복원 대상·백업 저장 경로가 허용된 루트 밖이거나 금지 패턴과 일치할 때. */
export class ForbiddenRestoreTargetError extends Error {
  readonly failureClass = "forbidden_path_write" as const;
  constructor(kind: "target" | "stored", value: string, note?: string) {
    super(
      kind === "target"
        ? `복원 대상이 허용된 루트(config 또는 알려진 project/.claude) 밖이다 — 변조된 manifest일 ` +
          `수 있다: ${value}`
        : `백업 저장 경로가 금지된 패턴과 일치한다(${note ?? "경로 순회 의심"}): ${value}`,
    );
    this.name = "ForbiddenRestoreTargetError";
  }
}

/**
 * M8 — 백업~롤백 사이(특히 self-rollback의 짧은 창) 사용자가 대화형 세션에서 대상 파일을
 * 별도로 바꾸면, 복원이 현재 내용을 확인하지 않고 그대로 덮어써 그 변경을 조용히 잃어버릴 수
 * 있었다(lost update). 복원 직전 현재 sha256을 "조치 직후 우리가 남긴 값"과 대조해 다르면
 * 이 오류로 중단한다 — 무엇을 덮어쓰려 했는지 알 수 있게 상신한다.
 */
export class ConfigClobberedError extends Error {
  readonly failureClass = "config_clobbered" as const;
  constructor(targetAbs: string) {
    super(
      `복원 직전 ${targetAbs}의 현재 내용이 우리 조치 직후 남긴 값과 다르다 — 그 사이 다른 ` +
        `세션이 이 파일을 바꿨을 수 있다. 그 변경을 조용히 덮어쓰지 않기 위해 복원을 중단한다.`,
    );
    this.name = "ConfigClobberedError";
  }
}

/** H2/AC-2.13 — manifest.json의 실측 sha256이 journal에 기록된 값과 다르다(백업 저장소 변조 의심). */
export class BackupManifestTamperedError extends Error {
  readonly failureClass = "backup_manifest_tampered" as const;
  constructor(backupRoot: string, expected: string, actual: string) {
    super(
      `백업 manifest.json의 실측 sha256(${actual})이 journal에 기록된 값(${expected})과 다르다 — ` +
        `백업 저장소(${backupRoot})가 롤백 사이 변조됐을 수 있다. 어떤 쓰기도 하지 않았다.`,
    );
    this.name = "BackupManifestTamperedError";
  }
}

function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function isWithinRoot(targetAbs: string, root: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(targetAbs);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

/** 단일 관문 — 이 파일 안의 모든 targetAbs 검증은 이 함수를 거친다(H2 원칙: 판정 재구현 금지). */
function assertRestorableTarget(targetAbs: string, allowedRoots: readonly string[]): void {
  if (!path.isAbsolute(targetAbs) || !allowedRoots.some((root) => isWithinRoot(targetAbs, root))) {
    throw new ForbiddenRestoreTargetError("target", targetAbs);
  }
}

function assertSafeStoredRelPath(storedRelPath: string | null): void {
  if (storedRelPath === null) return;
  if (path.isAbsolute(storedRelPath)) {
    throw new ForbiddenRestoreTargetError("stored", storedRelPath, "절대경로는 상대 저장 경로로 쓰일 수 없다");
  }
  const posixLike = storedRelPath.split(path.sep).join("/");
  const forbidden = matchesForbidden(posixLike, FORBIDDEN_RULES);
  if (forbidden) {
    throw new ForbiddenRestoreTargetError("stored", storedRelPath, forbidden.note);
  }
}

function allowedRestoreRoots(home: HomeContext): string[] {
  const projectClaudeDirs = listKnownProjectPaths(home).map((p) => path.join(p, ".claude"));
  // H4 — `.claude.json`은 `ctkConfigDir` 밖(HOME 바로 아래, `configDirExplicit`이면
  // `ctkConfigDir` 안)에 있을 수 있다(probe/home.ts `claudeJsonPath()`와 동일 계산). 트리
  // 전체를 허용하지 않고 이 **정확히 한 파일**만 예외로 화이트리스트에 추가한다(디렉터리
  // prefix가 아니라 exact match — `isWithinRoot`의 동등 비교로 성립).
  return [home.ctkConfigDir, claudeJsonPath(home), ...projectClaudeDirs];
}

/** 백업 저장소(디스크상의 사본)가 manifest가 주장하는 내용과 실제로 일치하는지 — 복원 전 최종 확인. */
function verifyBackupStoreEntry(key: string, entry: BackupEntry, backupRoot: string): void {
  if (!entry.existed) return; // 저장된 바이트가 없다 — 검증 대상 없음.
  const storedAbs = path.join(backupRoot, entry.storedRelPath!);
  if (!existsSync(storedAbs)) {
    throw new Error(`키 '${key}' — 백업 저장 사본이 존재하지 않는다: ${storedAbs}`);
  }
  if (entry.kind === "file") {
    const sha = sha256File(storedAbs);
    if (sha !== entry.sha256) {
      throw new Error(`키 '${key}' — 백업 저장 사본 sha256이 manifest와 다르다(백업 저장소 손상 의심): ${storedAbs}`);
    }
    return;
  }
  const files = collectTree(storedAbs).entries;
  if (files.length !== entry.files.length) {
    throw new Error(`키 '${key}' — 백업 저장 사본 파일 개수가 manifest와 다르다: ${storedAbs}`);
  }
  const byPath = new Map(files.map((f) => [f.path, f.sha256]));
  for (const f of entry.files) {
    if (byPath.get(f.relPath) !== f.sha256) {
      throw new Error(`키 '${key}' — 백업 저장 사본 ${f.relPath}의 sha256이 manifest와 다르다: ${storedAbs}`);
    }
  }
}

/**
 * H1/AC-2.11 — **어떤 쓰기도 하기 전에** manifest의 모든 항목을 검증한다. 통과해야만 phase 2
 * (실제 복원)가 시작된다. 하나라도 실패하면 대상 파일은 이 함수 호출 시점까지 0바이트도
 * 바뀌지 않은 상태다(preflight는 읽기 전용).
 */
export function preflightRestore(backupRoot: string, home: HomeContext, expectedManifestSha256?: string): Record<string, BackupEntry> {
  let manifest;
  try {
    manifest = readManifest(backupRoot);
  } catch (cause) {
    throw new RollbackFailedError(backupRoot, cause);
  }

  if (expectedManifestSha256 !== undefined) {
    const actual = manifestSha256Of(backupRoot);
    if (actual !== expectedManifestSha256) {
      throw new BackupManifestTamperedError(backupRoot, expectedManifestSha256, actual);
    }
  }

  const allowedRoots = allowedRestoreRoots(home);

  for (const [key, entry] of Object.entries(manifest.entries)) {
    assertSafeStoredRelPath(entry.storedRelPath);
    assertRestorableTarget(entry.targetAbs, allowedRoots);
    try {
      verifyBackupStoreEntry(key, entry, backupRoot);
    } catch (cause) {
      throw new RollbackFailedError(backupRoot, cause);
    }
  }

  return manifest.entries;
}

function stagingPathFor(backupRoot: string, key: string): string {
  return path.join(backupRoot, ".restore-staging", key);
}
function evictedPathFor(backupRoot: string, key: string): string {
  return path.join(backupRoot, ".restore-evicted", key);
}

function verifyRestoredFile(absPath: string, expectedSha256: string): void {
  const actual = sha256File(absPath);
  if (actual !== expectedSha256) {
    throw new Error(`복원 후 sha256 불일치(기대 ${expectedSha256}, 실제 ${actual}): ${absPath}`);
  }
}

function verifyRestoredDirectory(absPath: string, entry: Extract<BackupEntry, { kind: "directory" }>): void {
  const restored = collectTree(absPath).entries;
  const restoredByPath = new Map(restored.map((f) => [f.path, f.sha256]));
  if (restored.length !== entry.files.length) {
    throw new Error(`복원 후 파일 개수 불일치(기대 ${entry.files.length}, 실제 ${restored.length}): ${absPath}`);
  }
  for (const f of entry.files) {
    if (restoredByPath.get(f.relPath) !== f.sha256) {
      throw new Error(`복원 후 ${f.relPath}의 sha256 불일치: ${absPath}`);
    }
  }
}

/**
 * H1 — 파일 복원. `existed:false`(생성물 제거) 케이스도 `rmSync`가 아니라 **퇴피(rename)**로
 * 처리한다 — "살아있는 대상을 무조건 삭제"하는 코드 경로를 이 파일 전체에서 없앤다.
 *
 * `expectedCurrentSha256`(M8)이 주어지고 대상이 존재하면, 복원 직전 실측 sha256과 대조한다 —
 * 다르면 다른 세션이 그 사이 파일을 바꿨다는 뜻이므로 `ConfigClobberedError`로 중단한다
 * (`undefined`면 검사를 생략한다 — 호출자가 "조치 직후 값"을 모르는 경로, 예: 구버전 백업).
 */
function restoreFileEntry(
  key: string,
  entry: Extract<BackupEntry, { kind: "file" }>,
  backupRoot: string,
  expectedCurrentSha256: string | undefined,
): void {
  const targetAbs = entry.targetAbs;

  if (expectedCurrentSha256 !== undefined && existsSync(targetAbs)) {
    if (sha256File(targetAbs) !== expectedCurrentSha256) {
      throw new ConfigClobberedError(targetAbs);
    }
  }

  const evictedAbs = evictedPathFor(backupRoot, key);
  mkdirSync(path.dirname(evictedAbs), { recursive: true });
  rmSync(evictedAbs, { recursive: true, force: true }); // 이전 시도의 잔존물 정리(멱등).

  if (!entry.existed) {
    if (existsSync(targetAbs)) {
      renameSync(targetAbs, evictedAbs); // 삭제가 아니라 퇴피 — evicted에 원본이 안전하게 남는다.
    }
    return;
  }

  const storedAbs = path.join(backupRoot, entry.storedRelPath!);
  const content = readFileSync(storedAbs, "utf8");
  const hadTarget = existsSync(targetAbs);
  if (hadTarget) {
    renameSync(targetAbs, evictedAbs);
  }
  try {
    atomicWriteFile(targetAbs, content);
    verifyRestoredFile(targetAbs, entry.sha256!);
  } catch (cause) {
    // 실패 — 가능하면 퇴피본을 원위치로 되돌린다(best-effort, "롤백의 롤백"까지는 하지 않는다).
    if (hadTarget && existsSync(evictedAbs)) {
      try {
        rmSync(targetAbs, { recursive: true, force: true });
        renameSync(evictedAbs, targetAbs);
      } catch {
        // best-effort — 여기서도 실패하면 evicted 보관소에 원본이 남아있다(수동 복구 가능).
      }
    }
    throw cause;
  }
}

/**
 * H1 — 디렉터리 복원. staging(백업 원본 사본) → 대상을 evicted로 퇴피 → staging을 대상으로
 * rename하는 3단계다. "대상을 먼저 지우고 그 다음 복사"하는 옛 경로(살아있는 유일한 사본을
 * 백업 확인 전에 지우는 사고 경로, H1)를 제거한다.
 */
function restoreDirectoryEntry(key: string, entry: Extract<BackupEntry, { kind: "directory" }>, backupRoot: string): void {
  const targetAbs = entry.targetAbs;
  const stagingAbs = stagingPathFor(backupRoot, key);
  const evictedAbs = evictedPathFor(backupRoot, key);
  rmSync(stagingAbs, { recursive: true, force: true });
  rmSync(evictedAbs, { recursive: true, force: true });

  if (!entry.existed) {
    if (existsSync(targetAbs)) {
      mkdirSync(path.dirname(evictedAbs), { recursive: true });
      renameSync(targetAbs, evictedAbs); // 생성물 제거도 퇴피로 — 직접 rm 금지.
    }
    return;
  }

  const storedAbs = path.join(backupRoot, entry.storedRelPath!);
  mkdirSync(path.dirname(stagingAbs), { recursive: true });
  cpSync(storedAbs, stagingAbs, { recursive: true });
  verifyRestoredDirectory(stagingAbs, entry); // staging 사본 자체를 먼저 검증(대상은 아직 안 건드림).

  const hadTarget = existsSync(targetAbs);
  if (hadTarget) {
    mkdirSync(path.dirname(evictedAbs), { recursive: true });
    renameSync(targetAbs, evictedAbs); // 대상이 살아있는 상태에서 삭제하지 않는다 — 원자적 퇴피뿐.
  }

  try {
    renameSync(stagingAbs, targetAbs);
    verifyRestoredDirectory(targetAbs, entry);
  } catch (cause) {
    if (hadTarget && existsSync(evictedAbs)) {
      try {
        rmSync(targetAbs, { recursive: true, force: true });
        renameSync(evictedAbs, targetAbs);
      } catch {
        // best-effort — evicted 보관소에 원본이 남아있다(수동 복구 가능).
      }
    }
    throw cause;
  }
}

/** H4/AC-2.5 — 복원 후 `snapshot-before.json`이 있으면 재수집 트리와 diff해 0건임을 확인한다. */
function verifyNoResidualDiff(backupRoot: string): void {
  const snapshot = readBeforeSnapshotOrNull(backupRoot);
  if (snapshot === null) return; // 이 백업 런에 before 스냅샷이 없다(구버전 호환) — 판정 생략.
  for (const root of snapshot.roots) {
    if (!existsSync(root.rootAbs)) continue; // 루트 자체가 원래 없었을 수 있다(project 미해당 등).
    const after = collectTree(root.rootAbs).entries;
    const v = treeDiffVerdict(root.entries, after, []); // 빈 allowlist = 어떤 churn도 기대하지 않는다.
    if (v.overallStatus !== "clean") {
      throw new Error(
        `롤백 후 잔존 diff 발견(AC-2.5 위반) — 루트 ${root.rootAbs}: ${JSON.stringify(v.violations)}`,
      );
    }
  }
}

/**
 * `backupRoot`의 manifest에 있는 **모든** 항목을 각자의 `targetAbs`로 복원한다. preflight를
 * 통과해야만 phase 2가 시작된다(H1). `expectedManifestSha256`는 `ctk rollback --last`처럼
 * journal 레코드를 이미 갖고 있는 호출자만 넘긴다 — move.ts의 즉시 자기-롤백(같은 런 안에서
 * 아직 journal을 쓰기 전)은 비교 대상이 없으므로 생략(undefined)한다.
 *
 * `expectedCurrentShas`(M8)는 manifest 키 → "조치 직후 우리가 남긴 sha256"이다. 주어지면
 * 파일 복원 직전 실측값과 대조해, 백업~롤백 사이 다른 세션이 그 파일을 바꿨으면
 * `ConfigClobberedError`로 중단한다(그 변경을 조용히 덮어쓰지 않는다). 키가 없거나 값이
 * `undefined`면(예: 아직 대상이 없었던 항목) 검사를 생략한다.
 *
 * 하나라도 phase 2 도중 실패하면 즉시 `RollbackFailedError`로 던진다(부분 복원 상태를 성공으로
 * 보고하지 않는다) — 이미 복원된 항목들은 그대로 남는다(추가 되돌리기 시도는 하지 않는다,
 * "롤백의 롤백"은 더 큰 손상 위험). `ConfigClobberedError`는 이 규칙의 예외다 — 그대로
 * 재throw해 호출자가 정확한 failure_class를 볼 수 있게 한다(RollbackFailedError로 뭉개지 않는다).
 */
export function restoreFromBackup(
  backupRoot: string,
  home: HomeContext,
  expectedManifestSha256?: string,
  expectedCurrentShas?: Readonly<Record<string, string | undefined>>,
): void {
  const entries = preflightRestore(backupRoot, home, expectedManifestSha256);

  for (const [key, entry] of Object.entries(entries)) {
    try {
      if (entry.kind === "file") {
        restoreFileEntry(key, entry, backupRoot, expectedCurrentShas?.[key]);
      } else {
        restoreDirectoryEntry(key, entry, backupRoot);
      }
    } catch (cause) {
      if (cause instanceof ConfigClobberedError) throw cause;
      throw new RollbackFailedError(backupRoot, new Error(`키 '${key}' 복원 실패: ${String(cause)}`));
    }
  }

  try {
    verifyNoResidualDiff(backupRoot);
  } catch (cause) {
    throw new RollbackFailedError(backupRoot, cause);
  }
}

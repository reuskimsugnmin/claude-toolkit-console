import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { claudeJsonPath, collectTree, listKnownProjectPaths, type HomeContext } from "@ctk/probe";
import { BackupManifestSchema, FORBIDDEN_RULES, matchesForbidden, verdict as treeDiffVerdict, type ClaudeJsonPathVerdict } from "@ctk/core";
import { atomicWriteFile, describeCause, describePath } from "./guard/atomic-write.js";
import { judgeClaudeJson } from "./audit.js";
import { CLAUDE_JSON_BACKUP_KEY, manifestSha256Of, readBeforeSnapshotOrNull, readManifest, type BackupEntry } from "./backup.js";

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
  /** N1 — 복원 루프에서 **이미 복원이 끝난** manifest 키. 비어 있지 않으면 부분 롤백 상태다. */
  readonly restoredKeys: readonly string[];
  /** N1 — 복원하지 못한(시도 전이거나 시도 중 실패한) manifest 키. */
  readonly unrestoredKeys: readonly string[];
  constructor(backupRoot: string, cause: unknown, progress?: { restoredKeys: readonly string[]; unrestoredKeys: readonly string[] }) {
    // 절대경로 원문 대신 백업 런 이름만 싣는다(N4) — 위치는 journal의 backup_ref(`~/.ctk-backups/<런>`)가 알려준다.
    super(
      `롤백 자체가 실패했다 — 수동 복구가 필요하다. 백업 런: ${path.basename(backupRoot)}(manifest.json 포함), ` +
        (progress !== undefined ? `복원됨: [${progress.restoredKeys.join(", ")}] / 미복원: [${progress.unrestoredKeys.join(", ")}], ` : "") +
        `원인: ${describeCause(cause)}`,
    );
    this.name = "RollbackFailedError";
    this.backupRoot = backupRoot;
    this.manifestPath = path.join(backupRoot, "manifest.json");
    this.restoredKeys = progress?.restoredKeys ?? [];
    this.unrestoredKeys = progress?.unrestoredKeys ?? [];
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
          `수 있다: ${describePath(value)}`
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
      `복원 직전 ${describePath(targetAbs)}의 현재 내용이 우리 조치 직후 남긴 값과 다르다 — 그 사이 다른 ` +
        `세션이 이 파일을 바꿨을 수 있다. 그 변경을 조용히 덮어쓰지 않기 위해 복원을 중단한다.`,
    );
    this.name = "ConfigClobberedError";
  }
}

/**
 * 파일 복원 대상이 심볼릭 링크일 때. sha256 판정(`readFileSync`)은 링크가 가리키는 파일을 보지만 복원(rename+쓰기)은
 * 링크 자체를 일반 파일로 바꾼다 — X를 판정하고 Y를 쓰는 어긋남이므로 한 바이트도 쓰기 전에 중단한다.
 */
export class RestoreTargetSymlinkError extends Error {
  readonly failureClass = "restore_target_symlink" as const;
  constructor(targetAbs: string) {
    super(
      `복원 대상 ${describePath(targetAbs)}이(가) 심볼릭 링크다 — 링크를 일반 파일로 바꿔치기하지 않기 위해 ` +
        `ctk는 복원을 거부한다. 이 대상에는 아무것도 쓰지 않았다.`,
    );
    this.name = "RestoreTargetSymlinkError";
  }
}

/** H2/AC-2.13 — manifest.json의 실측 sha256이 journal에 기록된 값과 다르다(백업 저장소 변조 의심). */
export class BackupManifestTamperedError extends Error {
  readonly failureClass = "backup_manifest_tampered" as const;
  constructor(backupRoot: string, expected: string, actual: string) {
    super(
      `백업 manifest.json의 실측 sha256(${actual})이 journal에 기록된 값(${expected})과 다르다 — ` +
        `백업 저장소(런 ${path.basename(backupRoot)})가 롤백 사이 변조됐을 수 있다. 어떤 쓰기도 하지 않았다.`,
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
    throw new Error(`키 '${key}' — 백업 저장 사본이 존재하지 않는다: ${describePath(storedAbs)}`);
  }
  if (entry.kind === "file") {
    const sha = sha256File(storedAbs);
    if (sha !== entry.sha256) {
      throw new Error(`키 '${key}' — 백업 저장 사본 sha256이 manifest와 다르다(백업 저장소 손상 의심): ${describePath(storedAbs)}`);
    }
    return;
  }
  const files = collectTree(storedAbs).entries;
  if (files.length !== entry.files.length) {
    throw new Error(`키 '${key}' — 백업 저장 사본 파일 개수가 manifest와 다르다: ${describePath(storedAbs)}`);
  }
  const byPath = new Map(files.map((f) => [f.path, f.sha256]));
  for (const f of entry.files) {
    if (byPath.get(f.relPath) !== f.sha256) {
      throw new Error(`키 '${key}' — 백업 저장 사본 ${f.relPath}의 sha256이 manifest와 다르다: ${describePath(storedAbs)}`);
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
    throw new Error(`복원 후 sha256 불일치(기대 ${expectedSha256}, 실제 ${actual}): ${describePath(absPath)}`);
  }
}

function verifyRestoredDirectory(absPath: string, entry: Extract<BackupEntry, { kind: "directory" }>): void {
  const restored = collectTree(absPath).entries;
  const restoredByPath = new Map(restored.map((f) => [f.path, f.sha256]));
  if (restored.length !== entry.files.length) {
    throw new Error(`복원 후 파일 개수 불일치(기대 ${entry.files.length}, 실제 ${restored.length}): ${describePath(absPath)}`);
  }
  for (const f of entry.files) {
    if (restoredByPath.get(f.relPath) !== f.sha256) {
      throw new Error(`복원 후 ${f.relPath}의 sha256 불일치: ${describePath(absPath)}`);
    }
  }
}

/**
 * 복원기가 거부할 대상인가 — `move`가 쓰기 전에 같은 판정으로 거부한다(판정이 둘이면 이동은 되고 복원만 막힌다).
 */
export function isSymlink(abs: string): boolean {
  return lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() === true;
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

  // 어떤 rename보다 앞서 — 한 번 퇴피하면 링크는 이미 옮겨져 이 검사가 "없음"을 본다. 사전 패스 이후 끼어든 교체(경쟁 창)용.
  if (isSymlink(targetAbs)) throw new RestoreTargetSymlinkError(targetAbs);

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
function verifyNoResidualDiff(backupRoot: string, leftUntouchedAbs: readonly string[]): void {
  const snapshot = readBeforeSnapshotOrNull(backupRoot);
  if (snapshot === null) return; // 이 백업 런에 before 스냅샷이 없다(구버전 호환) — 판정 생략.
  for (const root of snapshot.roots) {
    if (!existsSync(root.rootAbs)) continue; // 루트 자체가 원래 없었을 수 있다(project 미해당 등).
    // 의도적으로 복원하지 않은 파일(M1)은 양쪽에서 뺀다 — 안 뺀 채 두면 "남긴 것"이 잔존 diff로 읽힌다.
    const skippedRel = new Set(
      leftUntouchedAbs.map((abs) => path.relative(root.rootAbs, abs).split(path.sep).join("/")),
    );
    const after = collectTree(root.rootAbs).entries.filter((e) => !skippedRel.has(e.path));
    const v = treeDiffVerdict(root.entries.filter((e) => !skippedRel.has(e.path)), after, []); // 빈 allowlist = 어떤 churn도 기대하지 않는다.
    if (v.overallStatus !== "clean") {
      throw new Error(
        `롤백 후 잔존 diff 발견(AC-2.5 위반) — 루트 ${describePath(root.rootAbs)}: ${JSON.stringify(v.violations)}`,
      );
    }
  }
}

export interface RestoreOptions {
  /** 플러그인 `move`/롤백 대상 id — `.claude.json` 점검(`judgeClaudeJson`)에서 그 `pluginUsage` enable 흔적을 허용하는 데 쓴다. */
  readonly enabledPluginId?: string | null;
}

/**
 * **테스트 전용 이음매** — `restoreFromBackupWithSeam`으로만 넘긴다(공개 옵션 타입에는 없다). 각 항목 복원 직전(CAS
 * 사전 검사 이후)에 호출돼, 사전 검사와 실제 복원 사이에 다른 세션이 쓰는 경쟁(N1)을 결정적으로 재현한다.
 */
export interface RestoreTestSeam {
  readonly onBeforeRestoreEntry?: (key: string) => void;
}

/** `.claude.json` 점검 결과 — 이 파일은 **어떤 경로로도 복원하지 않는다**(N2). */
export interface ClaudeJsonLeftover {
  /** `ok`=백업 대비 diff가 없거나 허용 churn뿐 · `violation`=허용 밖 변경(사람이 직접 확인) · `unjudgeable`=읽기/파싱 실패. */
  readonly status: "ok" | "violation" | "unjudgeable";
  /** `violation`일 때의 위반 경로(프로젝트는 해시로 마스킹돼 있다). */
  readonly violations: readonly ClaudeJsonPathVerdict[];
  /** 위반에 MCP 서브트리가 있다 — 가장 먼저 사람이 봐야 한다. */
  readonly mcpForbidden: boolean;
}

export interface RestoreReport {
  /** 의도적으로 복원하지 않은 파일의 manifest 키 — 지금은 `.claude.json`(`claudeJsonPath(home)`)뿐이다. */
  readonly leftUntouchedKeys: readonly string[];
  /** 실제로 복원한 manifest 키(run-log 기록용). */
  readonly restoredKeys: readonly string[];
  /** manifest에 `.claude.json` 항목이 없으면(스킬 이동 등) null. */
  readonly claudeJson: ClaudeJsonLeftover | null;
}

/**
 * N2 — **`.claude.json`은 어떤 롤백에서도 복원하지 않는다.** ctk move가 이 파일에 남기는 것은 무해한
 * `pluginUsage[assetId]` 흔적뿐이고 enable 상태는 settings.json에 있으므로, 이 파일을 두고 가도 enable 상태가
 * 어긋나지 않는다. 반면 통째 복원은 백업~현재 사이(몇 초든 며칠이든) 다른 세션의 정당한 쓰기를 지운다.
 * 대신 `judgeClaudeJson`(사후 감사와 같은 판정)으로 백업 대비 diff를 점검해 **보고**한다.
 */
function inspectClaudeJson(
  entry: Extract<BackupEntry, { kind: "file" }>,
  backupRoot: string,
  enabledPluginId: string | null,
): ClaudeJsonLeftover {
  if (!entry.existed || !existsSync(entry.targetAbs)) return { status: "unjudgeable", violations: [], mcpForbidden: false };
  try {
    const backupValue = JSON.parse(readFileSync(path.join(backupRoot, entry.storedRelPath!), "utf8")) as unknown;
    const currentValue = JSON.parse(readFileSync(entry.targetAbs, "utf8")) as unknown;
    const verdict = judgeClaudeJson(backupValue, currentValue, enabledPluginId);
    return {
      status: verdict.overallStatus === "violation" ? "violation" : "ok",
      violations: verdict.violations,
      mcpForbidden: verdict.violations.some((v) => v.mcpForbidden),
    };
  } catch {
    return { status: "unjudgeable", violations: [], mcpForbidden: false };
  }
}

/** 복원 보고 중 `.claude.json` 부분을 사람이 읽을 문장으로 — move.ts의 자기 롤백과 `ctk rollback`이 같은 문장을 쓴다. */
export function describeClaudeJsonLeftover(report: RestoreReport, backupRef: string): string | null {
  const c = report.claudeJson;
  if (c === null) return null;
  const backupHint = `백업본은 ${backupRef}/config_claude_json 아래에 남아 있습니다.`;
  if (c.status === "ok") return null;
  if (c.status === "unjudgeable") {
    return `.claude.json은 복원하지 않았고 백업 대비 변경을 판정하지 못했습니다(읽기/파싱 실패) — 직접 확인하세요. ${backupHint}`;
  }
  return (
    `.claude.json의 변경은 ctk가 의도한 것이 아닙니다(ctk가 띄운 claude CLI 하위 프로세스 또는 다른 세션이 쓴 것) — 되돌리지 않고 그대로 두었습니다(허용 밖 변경: ${c.violations.map((v) => v.path).join(", ")}).` +
    (c.mcpForbidden ? " ⚠ MCP 서브트리 변경이 관측되었습니다 — 반드시 직접 확인하세요." : " 필요하면 직접 확인하세요.") +
    ` ${backupHint}`
  );
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
 * H1 — 파일 항목의 CAS는 **복원 시작 전에 전부** 먼저 검사한다(하나라도 어긋나면 0건 복원 상태로
 * `ConfigClobberedError`).
 * N1 — 복원 도중(사전 검사 통과 뒤의 경쟁 포함) 실패하면, 이미 복원된 키가 있는 한 **항상**
 * `RollbackFailedError`(`restoredKeys`/`unrestoredKeys` 포함)로 던진다. `ConfigClobberedError`는 복원이 0건일
 * 때만 그대로 던진다 — "한 파일도 복원하지 않았다"는 사실일 때만 말할 수 있는 문장이기 때문이다.
 * "롤백의 롤백"은 더 큰 손상 위험이라 하지 않는다.
 * N2 — `.claude.json`은 복원 대상에서 항상 뺀다(`inspectClaudeJson` 참조).
 */
export function restoreFromBackup(
  backupRoot: string,
  home: HomeContext,
  expectedManifestSha256?: string,
  expectedCurrentShas?: Readonly<Record<string, string | undefined>>,
  options: RestoreOptions = {},
): RestoreReport {
  return restoreInternal(backupRoot, home, expectedManifestSha256, expectedCurrentShas, options, {});
}

/** 테스트 전용 — 경쟁 재현 이음매(`RestoreTestSeam`)를 받는다. 제품 코드는 `restoreFromBackup`만 쓴다. */
export function restoreFromBackupWithSeam(
  backupRoot: string,
  home: HomeContext,
  expectedManifestSha256: string | undefined,
  expectedCurrentShas: Readonly<Record<string, string | undefined>> | undefined,
  options: RestoreOptions,
  seam: RestoreTestSeam,
): RestoreReport {
  return restoreInternal(backupRoot, home, expectedManifestSha256, expectedCurrentShas, options, seam);
}

function restoreInternal(
  backupRoot: string,
  home: HomeContext,
  expectedManifestSha256: string | undefined,
  expectedCurrentShas: Readonly<Record<string, string | undefined>> | undefined,
  options: RestoreOptions,
  seam: RestoreTestSeam,
): RestoreReport {
  const entries = preflightRestore(backupRoot, home, expectedManifestSha256);

  const leftUntouchedKeys: string[] = [];
  let claudeJson: ClaudeJsonLeftover | null = null;
  // R7 주의: 이 파일 전체를 복원에서 뺀다 — `ctk mcp`가 쓰는 것은 한 프로젝트 키의 `disabledMcpServers` 하나뿐인 소유
  // 서브트리이고, 그 되돌림은 이 복원기가 아니라 역방향 `ctk mcp` 동사가 한다(키 수준 CAS가 거기 있다). 따라서 `ctk mcp`
  // 토글 뒤의 `ctk rollback`은 이 파일을 복원하지 않는다(cli가 `toggle_mcp_project`를 먼저 거부한다).
  // 제외는 경로(claudeJsonPath)와 manifest 키 둘 다로 건다: 키만 보면 CTK_CONFIG_DIR 설정 여부가 달라진 백업이,
  // 경로만 보면 키가 바뀐 백업이 이 파일을 CAS 없이 통째 복원할 수 있다.
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.kind === "file" && (key === CLAUDE_JSON_BACKUP_KEY || path.resolve(entry.targetAbs) === path.resolve(claudeJsonPath(home)))) {
      leftUntouchedKeys.push(key);
      claudeJson = inspectClaudeJson(entry, backupRoot, options.enabledPluginId ?? null);
    }
  }
  const toRestore = Object.entries(entries).filter(([key]) => !leftUntouchedKeys.includes(key));

  for (const [key, entry] of toRestore) {
    if (entry.kind !== "file") continue;
    if (isSymlink(entry.targetAbs)) throw new RestoreTargetSymlinkError(entry.targetAbs); // 쓰기 0건 보장(사전 패스)
    const expected = expectedCurrentShas?.[key];
    if (expected !== undefined && existsSync(entry.targetAbs) && sha256File(entry.targetAbs) !== expected) {
      throw new ConfigClobberedError(entry.targetAbs);
    }
  }

  const restoredKeys: string[] = [];
  for (const [index, [key, entry]] of toRestore.entries()) {
    try {
      seam.onBeforeRestoreEntry?.(key);
      if (entry.kind === "file") {
        restoreFileEntry(key, entry, backupRoot, expectedCurrentShas?.[key]);
      } else {
        restoreDirectoryEntry(key, entry, backupRoot);
      }
      restoredKeys.push(key);
    } catch (cause) {
      if (restoredKeys.length === 0 && (cause instanceof ConfigClobberedError || cause instanceof RestoreTargetSymlinkError)) throw cause;
      throw new RollbackFailedError(backupRoot, new Error(`키 '${key}' 복원 실패: ${describeCause(cause)}`), {
        restoredKeys,
        unrestoredKeys: toRestore.slice(index).map(([k]) => k),
      });
    }
  }

  try {
    verifyNoResidualDiff(backupRoot, leftUntouchedKeys.map((k) => entries[k]!.targetAbs));
  } catch (cause) {
    throw new RollbackFailedError(backupRoot, cause, { restoredKeys, unrestoredKeys: [] });
  }
  return { leftUntouchedKeys, restoredKeys, claudeJson };
}

/**
 * 중단된 복원의 잔존물. 2-phase 복원은 대상을 삭제하지 않고 `.restore-evicted/<key>`로 퇴피시킨
 * 뒤 교체하므로, 그 사이에 프로세스가 죽으면 **사용자 파일이 evicted에만 존재**한다. 대상 자리는
 * 비어 있으므로 사용자에게는 "사라진" 것처럼 보인다 — 실제로는 복구 가능하다는 사실을 아무도
 * 알려주지 않는 것이 진짜 문제다(안전 원칙 5: 없음과 실패를 구분한다).
 */
export interface InterruptedRestore {
  readonly backupRoot: string;
  readonly key: string;
  readonly evictedAbs: string;
  /** 이 항목이 원래 있어야 할 자리. manifest에서 복원하며, 읽을 수 없으면 `null`. */
  readonly targetAbs: string | null;
  /** 대상 자리가 현재 비어 있는가 — 비어 있으면 사용자 눈에는 파일이 소실된 것으로 보인다. */
  readonly targetMissing: boolean;
}

/**
 * 백업 루트들을 훑어 중단된 복원의 잔존물을 찾는다. `ctk doctor`가 이 결과를 **다른 어떤 요약보다
 * 먼저** 표시해야 한다(§7.2) — 사용자 파일이 눈앞에서 사라진 것처럼 보이는 유일한 상태이기 때문이다.
 */
export function findInterruptedRestores(backupsRoot: string): InterruptedRestore[] {
  const found: InterruptedRestore[] = [];
  if (!existsSync(backupsRoot)) return found;

  let runDirs: string[];
  try {
    runDirs = readdirSync(backupsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // 백업 루트를 못 읽는 것은 "잔존물 없음"이 아니라 판정 불가다 — 조용히 빈 배열을 주지 않는다.
    throw new Error(`백업 루트를 읽을 수 없어 중단된 복원 여부를 판정할 수 없다: ${describePath(backupsRoot)}`);
  }

  for (const runId of runDirs) {
    const backupRoot = path.join(backupsRoot, runId);
    const evictedRoot = path.join(backupRoot, ".restore-evicted");
    if (!existsSync(evictedRoot)) continue;

    let manifestEntries: Record<string, BackupEntry> = {};
    try {
      manifestEntries = BackupManifestSchema.parse(
        JSON.parse(readFileSync(path.join(backupRoot, "manifest.json"), "utf8")),
      ).entries;
    } catch {
      // manifest를 못 읽어도 잔존물 자체는 보고한다 — targetAbs만 미상으로 둔다.
    }

    for (const key of readdirSync(evictedRoot, { withFileTypes: true }).map((d) => d.name)) {
      const targetAbs = manifestEntries[key]?.targetAbs ?? null;
      found.push({
        backupRoot,
        key,
        evictedAbs: path.join(evictedRoot, key),
        targetAbs,
        targetMissing: targetAbs !== null && !existsSync(targetAbs),
      });
    }
  }
  return found;
}

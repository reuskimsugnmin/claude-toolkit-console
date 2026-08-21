import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FileEntry } from "@ctk/core";

/**
 * probe/src/tree-collect.ts — config 트리 수집(I/O). **판정은 하지 않는다** — `core/src/guard/*`에
 * 넘긴다(H1). Step 5(actuator)·Step 4(gen)가 이 수집기를 공유한다.
 *
 * 심볼릭 링크는 따라가지 않는다(`statSync`가 아니라 `lstatSync` 계열로 분류해 심볼릭 링크
 * 자체는 건너뛴다) — 링크를 따라가면 순환 참조나 "같은 파일이 두 경로로 이중 목록"되는 사고가
 * 나고, `core/guard/tree-diff.ts`의 `verdict()`는 중복 경로 입력을 판정 불가로 거부한다
 * (`DuplicatePathVerdictError`) — 이 수집기가 애초에 중복을 만들지 않아야 그 계약이 의미가 있다.
 *
 * ⚠️ **Step 5 보안 심사 수정(M3)** — 이전에는 `readdirSync`/`sha256File` 실패를 조용히
 * 건너뛰었다(권한이 막힌 서브트리의 변경이 감사에 영구히 보이지 않을 수 있었다). 지금은
 * `errors` 카운트로 "이 수집이 완전한 관측이었는가"를 호출자가 판정할 수 있게 반환한다.
 * 심볼릭 링크·빈 디렉터리도 파일 목록에서는 빠지지만(위 문서) 개수는 따로 세어 반환한다 —
 * 감사가 "심볼릭 링크가 생기거나 사라졌는데 파일 목록만 보면 무변화"처럼 보이는 사각지대를
 * 줄인다.
 */

export interface TreeCollectResult {
  entries: FileEntry[];
  /** 수집 중 읽기 실패(readdir/sha256) 건수 — 0보다 크면 이 수집은 불완전한 관측이다. */
  errors: number;
  /** 건너뛴 심볼릭 링크 개수(따라가지 않지만 개수는 센다). */
  symlinkCount: number;
  /** 빈 디렉터리 개수(파일이 없어 `entries`에는 어떤 흔적도 안 남긴다). */
  emptyDirCount: number;
}

function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

interface WalkStats {
  errors: number;
  symlinkCount: number;
  emptyDirCount: number;
}

function walk(rootAbs: string, currentAbs: string, out: FileEntry[], stats: WalkStats): void {
  let dirents;
  try {
    dirents = readdirSync(currentAbs, { withFileTypes: true });
  } catch {
    // 경합으로 디렉터리가 스캔 도중 사라졌을 수 있다 — 스캔은 중단하지 않되(부분 관측이 아예
    // 없는 것보다 낫다), 이 실패를 집계해 호출자가 "완전한 관측이었는가"를 판정할 수 있게 한다.
    stats.errors++;
    return;
  }
  let sawEntry = false;
  for (const dirent of dirents) {
    sawEntry = true;
    const absChild = path.join(currentAbs, dirent.name);
    if (dirent.isSymbolicLink()) {
      // 심볼릭 링크는 따라가지 않는다 — 순환·이중 목록 방지(위 문서 주석). 개수만 센다.
      stats.symlinkCount++;
      continue;
    }
    if (dirent.isDirectory()) {
      walk(rootAbs, absChild, out, stats);
      continue;
    }
    if (!dirent.isFile()) {
      continue;
    }
    let sha256: string;
    try {
      sha256 = sha256File(absChild);
    } catch {
      // 경합으로 파일이 스캔 도중 사라졌을 수 있다 — 해당 항목만 건너뛰되 오류로 집계한다.
      stats.errors++;
      continue;
    }
    const relPath = path.relative(rootAbs, absChild).split(path.sep).join("/");
    out.push({ path: relPath, sha256 });
  }
  if (!sawEntry) stats.emptyDirCount++;
}

/**
 * `rootAbs` 아래 전 파일을 재귀 수집해 `core/guard/tree-diff.ts`의 `FileEntry[]` 형태로 반환한다.
 * 루트 디렉터리 자체가 없으면(예: 아직 `ctk init`이 되지 않은 카탈로그) 빈 배열을 반환한다 —
 * "아무것도 못 봤다"는 tree-diff의 안전한 기본값(`verdict([], [], [])` = clean)과 일치한다.
 */
export function collectTree(rootAbs: string): TreeCollectResult {
  const entries: FileEntry[] = [];
  const stats: WalkStats = { errors: 0, symlinkCount: 0, emptyDirCount: 0 };
  let rootStat;
  try {
    rootStat = statSync(rootAbs);
  } catch {
    return { entries, errors: 0, symlinkCount: 0, emptyDirCount: 0 };
  }
  if (!rootStat.isDirectory()) {
    return { entries, errors: 0, symlinkCount: 0, emptyDirCount: 0 };
  }
  walk(rootAbs, rootAbs, entries, stats);
  return { entries, errors: stats.errors, symlinkCount: stats.symlinkCount, emptyDirCount: stats.emptyDirCount };
}

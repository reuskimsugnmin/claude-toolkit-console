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
 *
 * ⚠️ **Step 5 보안 심사 수정(M10)** — `ctk move` 1회는 config 트리를 최소 2번(before·after)
 * 전량 수집한다. Tier-2가 허용하는 `projects/**`·`sessions/**`는 실환경에서 수 GB에 달할 수
 * 있어(§도메인 지식), 매번 전 파일 내용을 읽어 sha256을 다시 계산하면 이동 1회에 최소 2회
 * 전량 재해시가 발생한다. `cache`(이전 수집 결과)를 넘기면, `(size, mtimeMs)`가 그 캐시와
 * 동일한 파일은 **내용을 다시 읽지 않고** 캐시된 sha256을 재사용한다 — git의 stat 캐시와
 * 동일한 원리(휴리스틱이므로 mtime 위조 시 오탐 가능성은 있으나, 감사는 어차피 sha256 자체를
 * 최종 판정에 쓰므로 캐시 오적중은 "변경을 놓친다"가 아니라 "변경 없음을 재확인하지 않는다"에
 * 그친다 — 실제 위험은 아래 캐시 무효화 조건으로 최소화한다).
 */

export interface FileStatCacheEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** 절대경로 → 마지막으로 관측한 (size, mtimeMs, sha256). `collectTree`의 두 번째 인자로 재사용한다. */
export type TreeCollectCache = ReadonlyMap<string, FileStatCacheEntry>;

export interface TreeCollectResult {
  entries: FileEntry[];
  /** 수집 중 읽기 실패(readdir/sha256) 건수 — 0보다 크면 이 수집은 불완전한 관측이다. */
  errors: number;
  /** 건너뛴 심볼릭 링크 개수(따라가지 않지만 개수는 센다). */
  symlinkCount: number;
  /** 빈 디렉터리 개수(파일이 없어 `entries`에는 어떤 흔적도 안 남긴다). */
  emptyDirCount: number;
  /** 이번 수집에서 관측한 (size, mtimeMs, sha256) — 다음 `collectTree` 호출에 캐시로 넘길 수 있다. */
  cache: TreeCollectCache;
}

function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

interface WalkStats {
  errors: number;
  symlinkCount: number;
  emptyDirCount: number;
}

function walk(
  rootAbs: string,
  currentAbs: string,
  out: FileEntry[],
  stats: WalkStats,
  cacheIn: TreeCollectCache,
  cacheOut: Map<string, FileStatCacheEntry>,
): void {
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
      walk(rootAbs, absChild, out, stats, cacheIn, cacheOut);
      continue;
    }
    if (!dirent.isFile()) {
      continue;
    }

    let sha256: string;
    try {
      const stat = statSync(absChild);
      const cached = cacheIn.get(absChild);
      // M10 — size+mtimeMs가 캐시와 동일하면 내용을 다시 읽지 않는다(파일이 실제로 바뀌었다면
      // 대부분의 파일시스템에서 mtime도 함께 바뀐다 — 완전한 보장은 아니지만, 최종 판정은
      // 여전히 sha256이 하므로 이 캐시는 순수 성능 최적화다).
      if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        sha256 = cached.sha256;
      } else {
        sha256 = sha256File(absChild);
      }
      cacheOut.set(absChild, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
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

const EMPTY_CACHE: TreeCollectCache = new Map();

/**
 * `rootAbs` 아래 전 파일을 재귀 수집해 `core/guard/tree-diff.ts`의 `FileEntry[]` 형태로 반환한다.
 * 루트 디렉터리 자체가 없으면(예: 아직 `ctk init`이 되지 않은 카탈로그) 빈 배열을 반환한다 —
 * "아무것도 못 봤다"는 tree-diff의 안전한 기본값(`verdict([], [], [])` = clean)과 일치한다.
 *
 * `cache`(M10, 선택)를 넘기면 이전 수집에서 (size, mtimeMs)가 같았던 파일은 재해시를 건너뛴다.
 * 호출자가 원치 않으면(예: 완전 재검증이 필요한 경우) 생략하면 항상 전량 재해시한다(기본값
 * 유지 — 캐시는 옵트인이다).
 */
export function collectTree(rootAbs: string, cache: TreeCollectCache = EMPTY_CACHE): TreeCollectResult {
  const entries: FileEntry[] = [];
  const stats: WalkStats = { errors: 0, symlinkCount: 0, emptyDirCount: 0 };
  const cacheOut = new Map<string, FileStatCacheEntry>();
  let rootStat;
  try {
    rootStat = statSync(rootAbs);
  } catch {
    return { entries, errors: 0, symlinkCount: 0, emptyDirCount: 0, cache: cacheOut };
  }
  if (!rootStat.isDirectory()) {
    return { entries, errors: 0, symlinkCount: 0, emptyDirCount: 0, cache: cacheOut };
  }
  walk(rootAbs, rootAbs, entries, stats, cache, cacheOut);
  return {
    entries,
    errors: stats.errors,
    symlinkCount: stats.symlinkCount,
    emptyDirCount: stats.emptyDirCount,
    cache: cacheOut,
  };
}

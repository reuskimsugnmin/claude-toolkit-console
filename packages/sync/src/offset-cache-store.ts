import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertNoRawPathLeaks, offsetCachePath } from "@ctk/core";
import { catalogAbsPath } from "./catalog-boundary.js";

/**
 * sync/src/offset-cache-store.ts — offset 캐시(§1.3 결정 5 · H3). 키는 트랜스크립트 **파일 경로**의
 * `path_hash`라서 **머신 종속**이다 — 토큰 캐시(`token-cache-store.ts`)와 절대 같은 위치에 두지
 * 않는다(P3, 경로 원문 금지 규칙). 기본 위치는 `<catalog>/machines/<machine_id>/cache/offsets.jsonl`
 * (`ctk.config.json`의 `offset_cache_location: "catalog"`, 기본값)이고, `"local"`이면
 * `~/.cache/ctk/offsets.jsonl`(카탈로그 **밖**)을 대신 쓴다 — 그 경로는 카탈로그 저장소가 아니므로
 * `catalogAbsPath()`의 경계 검사를 거치지 않는다(의도된 예외, `*AtPath` 변형으로 명시적으로 분리).
 */
export interface OffsetCacheRecord {
  path_hash: string;
  byte_offset: number;
}

function readJsonlRecords(absPath: string): OffsetCacheRecord[] {
  if (!existsSync(absPath)) return [];
  return readFileSync(absPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OffsetCacheRecord);
}

function appendJsonlRecords(absPath: string, entries: readonly OffsetCacheRecord[]): { path: string } {
  if (entries.length === 0) return { path: absPath };
  assertNoRawPathLeaks(entries);
  mkdirSync(path.dirname(absPath), { recursive: true });
  appendFileSync(absPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  return { path: absPath };
}

/** 카탈로그 내부 위치(기본값) — 카탈로그 경계 검사를 거친다. */
export function readOffsetCache(catalogRoot: string, machineId: string): OffsetCacheRecord[] {
  return readJsonlRecords(catalogAbsPath(catalogRoot, offsetCachePath(machineId)));
}

export function appendOffsetCacheEntries(
  catalogRoot: string,
  machineId: string,
  entries: readonly OffsetCacheRecord[],
): { path: string } {
  return appendJsonlRecords(catalogAbsPath(catalogRoot, offsetCachePath(machineId)), entries);
}

/** 로컬 대체 위치(`offset_cache_location: "local"`) — 카탈로그 밖 절대경로를 호출자가 직접 넘긴다. */
export function readOffsetCacheAtPath(absPath: string): OffsetCacheRecord[] {
  return readJsonlRecords(absPath);
}

export function appendOffsetCacheEntriesAtPath(absPath: string, entries: readonly OffsetCacheRecord[]): { path: string } {
  return appendJsonlRecords(absPath, entries);
}

export function toOffsetCacheMap(records: readonly OffsetCacheRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of records) map.set(r.path_hash, r.byte_offset);
  return map;
}

/** probe의 `createMapOffsetCacheStore().dirty`(신규/갱신분만)를 append 가능한 레코드로 되돌린다. */
export function fromOffsetCacheDirtyMap(dirty: ReadonlyMap<string, number>): OffsetCacheRecord[] {
  return [...dirty.entries()].map(([path_hash, byte_offset]) => ({ path_hash, byte_offset }));
}

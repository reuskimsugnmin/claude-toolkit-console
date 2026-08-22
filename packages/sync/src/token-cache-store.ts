import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertNoRawPathLeaks, tokenCachePath } from "@ctk/core";
import { catalogAbsPath } from "./catalog-boundary.js";

/**
 * sync/src/token-cache-store.ts — `<catalog>/cache/tokens.jsonl`(카탈로그 결정 2 · §1.3 결정 5 · H3).
 * 키는 `(content_sha256, tokenizer_model)` — **머신 독립**이다(같은 콘텐츠는 어느 머신에서 재도
 * 같은 토큰 수가 나와야 한다는 전제). `probe/src/cache/cache-store.ts`의 `TokenCacheStore`
 * 인터페이스는 여기서 읽은 항목으로 채우고, `set()`으로 새로 쌓인 항목만 다시 여기로 append한다
 * (P1-8 — probe는 캐시를 쓰지 않는다, sync가 유일한 쓰기 주체).
 *
 * append-only로 쌓는다 — 같은 키가 다시 나타나도 값은 결정적으로 같아야 하므로(콘텐츠 해시 +
 * 고정 tokenizer_model) 덮어쓰기 대신 단순 append만 한다. 읽을 때는 뒤에 쓰인 값이 최종값이다
 * (last-write-wins, 실질적으로는 언제나 같은 값).
 */
export interface TokenCacheRecord {
  content_sha256: string;
  tokenizer_model: string;
  value_tokens: number;
}

export function readTokenCache(catalogRoot: string): TokenCacheRecord[] {
  const absPath = catalogAbsPath(catalogRoot, tokenCachePath());
  if (!existsSync(absPath)) return [];
  return readFileSync(absPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TokenCacheRecord);
}

export function appendTokenCacheEntries(catalogRoot: string, entries: readonly TokenCacheRecord[]): { path: string } {
  const absPath = catalogAbsPath(catalogRoot, tokenCachePath());
  if (entries.length === 0) return { path: absPath };
  assertNoRawPathLeaks(entries);
  mkdirSync(path.dirname(absPath), { recursive: true });
  const lines = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  appendFileSync(absPath, lines, "utf8");
  return { path: absPath };
}

/** `content_sha256 tokenizer_model` 결합 키로 Map을 만든다 — probe의 createMapTokenCacheStore가
 * 기대하는 것과 동일한 결합 규약(공백 join)이다. sync가 probe를 import할 수 없으므로(계층 lint)
 * 이 결합 형식은 여기 독립적으로 재구현한다(단순 문자열 join이라 재구현 비용이 낮다). */
export function toTokenCacheMap(records: readonly TokenCacheRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of records) {
    map.set(`${r.content_sha256} ${r.tokenizer_model}`, r.value_tokens);
  }
  return map;
}

/** 반대 방향 — probe의 `createMapTokenCacheStore().dirty`(신규분만)를 append 가능한 레코드로 되돌린다.
 * `content_sha256`은 hex 문자열(공백 없음)이라 첫 공백에서 분리하면 안전하다. */
export function fromTokenCacheDirtyMap(dirty: ReadonlyMap<string, number>): TokenCacheRecord[] {
  const records: TokenCacheRecord[] = [];
  for (const [key, valueTokens] of dirty) {
    const spaceIndex = key.indexOf(" ");
    if (spaceIndex === -1) continue; // 방어적 — 형식이 안 맞으면 조용히 버리지 않고 건너뛴 사실을 남기려면 호출자가 별도 검증
    records.push({
      content_sha256: key.slice(0, spaceIndex),
      tokenizer_model: key.slice(spaceIndex + 1),
      value_tokens: valueTokens,
    });
  }
  return records;
}

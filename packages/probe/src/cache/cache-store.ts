/**
 * probe/src/cache/cache-store.ts — **인터페이스만**(P1-8). 캐시 쓰기는 probe가 하지 않는다 —
 * 구현·영속화는 `sync/{token-cache-store,offset-cache-store}.ts`에 있다. probe는 이 인터페이스
 * 모양의 객체를 주입받아 읽고(get) 새 값을 표시(set)할 뿐, 디스크에 언제·어떻게 쓸지는 모른다.
 *
 * 호출자(cli)가 sync로 기존 캐시를 메모리에 올려 이 인터페이스를 구현하는 어댑터를 만들고,
 * probe가 끝난 뒤 `set()`으로 쌓인 신규 항목을 다시 sync로 넘겨 append한다 — "읽기 계층에 쓰기
 * 루트를 만들지 않는다"는 원칙을 지키면서도 스캔 1회 안에서 캐시를 즉시 활용할 수 있다.
 */

/** 토큰 캐시 키 — `(content_sha256, tokenizer_model)`, 머신 독립(§1.3 결정 5 · H3). */
export interface TokenCacheKey {
  content_sha256: string;
  tokenizer_model: string;
}

export interface TokenCacheStore {
  get(key: TokenCacheKey): number | undefined;
  set(key: TokenCacheKey, valueTokens: number): void;
}

/** offset 캐시 키 — 트랜스크립트 파일의 `path_hash`, 머신 종속(경로 원문 금지, P3 · H3). */
export interface OffsetCacheStore {
  get(pathHash: string): number | undefined;
  set(pathHash: string, byteOffset: number): void;
}

/** 항상 미스만 반환하는 널 구현 — 캐시 없이 전량 재측정/재파싱하는 경로(테스트·`--no-cache` 등)에 쓴다. */
export function createNullTokenCacheStore(): TokenCacheStore {
  return {
    get: () => undefined,
    set: () => undefined,
  };
}

export function createNullOffsetCacheStore(): OffsetCacheStore {
  return {
    get: () => undefined,
    set: () => undefined,
  };
}

/** 인메모리 Map 기반 어댑터 — 호출자가 기존 캐시 항목을 미리 채워 넣고, 끝난 뒤 `entries()`로 신규분을 회수한다. */
export function createMapTokenCacheStore(initial: ReadonlyMap<string, number> = new Map()): TokenCacheStore & {
  dirty: Map<string, number>;
} {
  const store = new Map(initial);
  const dirty = new Map<string, number>();
  const keyOf = (key: TokenCacheKey): string => `${key.content_sha256} ${key.tokenizer_model}`;
  return {
    dirty,
    get: (key) => store.get(keyOf(key)),
    set: (key, valueTokens) => {
      const k = keyOf(key);
      store.set(k, valueTokens);
      dirty.set(k, valueTokens);
    },
  };
}

export function createMapOffsetCacheStore(initial: ReadonlyMap<string, number> = new Map()): OffsetCacheStore & {
  dirty: Map<string, number>;
} {
  const store = new Map(initial);
  const dirty = new Map<string, number>();
  return {
    dirty,
    get: (pathHash) => store.get(pathHash),
    set: (pathHash, byteOffset) => {
      store.set(pathHash, byteOffset);
      dirty.set(pathHash, byteOffset);
    },
  };
}

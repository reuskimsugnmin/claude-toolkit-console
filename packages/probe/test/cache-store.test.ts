import { describe, expect, it } from "vitest";
import { createMapOffsetCacheStore, createMapTokenCacheStore, createNullOffsetCacheStore, createNullTokenCacheStore } from "../src/cache/cache-store.js";

describe("probe/cache/cache-store — 인터페이스 + 인메모리 어댑터(구현·쓰기는 sync, P1-8)", () => {
  it("createMapTokenCacheStore — 기존 항목을 읽고, set()한 값은 dirty에 쌓인다", () => {
    const store = createMapTokenCacheStore(new Map([["abc123 claude-demo", 42]]));
    expect(store.get({ content_sha256: "abc123", tokenizer_model: "claude-demo" })).toBe(42);
    expect(store.get({ content_sha256: "abc123", tokenizer_model: "other-model" })).toBeUndefined();

    store.set({ content_sha256: "def456", tokenizer_model: "claude-demo" }, 100);
    expect(store.get({ content_sha256: "def456", tokenizer_model: "claude-demo" })).toBe(100);
    expect(store.dirty.size).toBe(1);
  });

  it("createMapOffsetCacheStore — path_hash 키로 읽고 쓴다", () => {
    const store = createMapOffsetCacheStore(new Map([["hash1", 1024]]));
    expect(store.get("hash1")).toBe(1024);
    store.set("hash2", 2048);
    expect(store.get("hash2")).toBe(2048);
    expect(store.dirty.get("hash2")).toBe(2048);
  });

  it("null 구현 — 항상 미스를 반환하고 set()은 아무 효과가 없다(캐시 없이 동작하는 경로)", () => {
    const token = createNullTokenCacheStore();
    expect(token.get({ content_sha256: "x", tokenizer_model: "y" })).toBeUndefined();
    token.set({ content_sha256: "x", tokenizer_model: "y" }, 1);
    expect(token.get({ content_sha256: "x", tokenizer_model: "y" })).toBeUndefined();

    const offset = createNullOffsetCacheStore();
    expect(offset.get("h")).toBeUndefined();
    offset.set("h", 10);
    expect(offset.get("h")).toBeUndefined();
  });
});

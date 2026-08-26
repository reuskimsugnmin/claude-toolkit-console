import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Occupancy } from "@ctk/core";
import { ensureGitRepo } from "../src/local-git-repo.js";
import {
  appendOffsetCacheEntries,
  appendOffsetCacheEntriesAtPath,
  fromOffsetCacheDirtyMap,
  readOffsetCache,
  readOffsetCacheAtPath,
  toOffsetCacheMap,
} from "../src/offset-cache-store.js";
import {
  appendTokenCacheEntries,
  fromTokenCacheDirtyMap,
  readTokenCache,
  toTokenCacheMap,
} from "../src/token-cache-store.js";
import { listAllOccupancy, readOccupancy, upsertOccupancy } from "../src/occupancy-store.js";

describe("sync — Step 3 캐시·occupancy 저장소", () => {
  let catalogRoot: string;
  beforeEach(() => {
    catalogRoot = mkdtempSync(path.join(tmpdir(), "ctk-sync-usage-"));
  });
  afterEach(() => rmSync(catalogRoot, { recursive: true, force: true }));

  it("token-cache-store — <catalog>/cache/tokens.jsonl에 append하고 읽으면 왕복된다(머신 독립 배치)", () => {
    ensureGitRepo(catalogRoot);
    expect(readTokenCache(catalogRoot)).toEqual([]);

    appendTokenCacheEntries(catalogRoot, [{ content_sha256: "abc", tokenizer_model: "claude-demo", value_tokens: 10 }]);
    const readBack = readTokenCache(catalogRoot);
    expect(readBack).toHaveLength(1);
    expect(readBack[0]).toEqual({ content_sha256: "abc", tokenizer_model: "claude-demo", value_tokens: 10 });

    appendTokenCacheEntries(catalogRoot, [{ content_sha256: "def", tokenizer_model: "claude-demo", value_tokens: 20 }]);
    expect(readTokenCache(catalogRoot)).toHaveLength(2);
  });

  it("token-cache-store — dirty Map 왕복(fromTokenCacheDirtyMap ↔ toTokenCacheMap)", () => {
    const map = toTokenCacheMap([{ content_sha256: "abc", tokenizer_model: "claude-demo", value_tokens: 10 }]);
    expect(map.get("abc claude-demo")).toBe(10);
    const records = fromTokenCacheDirtyMap(map);
    expect(records).toEqual([{ content_sha256: "abc", tokenizer_model: "claude-demo", value_tokens: 10 }]);
  });

  it("appendTokenCacheEntries — 빈 배열이면 파일을 만들지 않는다", () => {
    ensureGitRepo(catalogRoot);
    appendTokenCacheEntries(catalogRoot, []);
    expect(readTokenCache(catalogRoot)).toEqual([]);
  });

  it("offset-cache-store — <catalog>/machines/<id>/cache/offsets.jsonl(머신 종속, path_hash 키만)", () => {
    ensureGitRepo(catalogRoot);
    expect(readOffsetCache(catalogRoot, "m1")).toEqual([]);

    appendOffsetCacheEntries(catalogRoot, "m1", [{ path_hash: "hash1", byte_offset: 1024 }]);
    const readBack = readOffsetCache(catalogRoot, "m1");
    expect(readBack).toEqual([{ path_hash: "hash1", byte_offset: 1024 }]);

    // 다른 머신은 완전히 분리된 파일이다.
    expect(readOffsetCache(catalogRoot, "m2")).toEqual([]);
  });

  it("offset-cache-store — 경로 원문이 값으로 들어가면 위생 검사가 거부한다(AC-1.7)", () => {
    ensureGitRepo(catalogRoot);
    expect(() =>
      appendOffsetCacheEntries(catalogRoot, "m1", [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { path_hash: "/Users/someone/secret-project", byte_offset: 0 } as any,
      ]),
    ).toThrow();
  });

  it("offset-cache-store — 로컬 대체 위치(*AtPath)는 카탈로그 경계와 무관하게 동작한다", () => {
    const localPath = path.join(catalogRoot, "..", "local-offsets.jsonl");
    appendOffsetCacheEntriesAtPath(localPath, [{ path_hash: "h", byte_offset: 5 }]);
    expect(readOffsetCacheAtPath(localPath)).toEqual([{ path_hash: "h", byte_offset: 5 }]);
    rmSync(localPath, { force: true });
  });

  it("offset-cache-store — dirty Map 왕복", () => {
    const dirty = new Map([["h1", 100]]);
    expect(fromOffsetCacheDirtyMap(dirty)).toEqual([{ path_hash: "h1", byte_offset: 100 }]);
    expect(toOffsetCacheMap([{ path_hash: "h1", byte_offset: 100 }]).get("h1")).toBe(100);
  });

  it("occupancy-store — upsert 후 read로 왕복되고, listAllOccupancy가 전수를 모은다", () => {
    ensureGitRepo(catalogRoot);
    const occ: Occupancy = {
      schema_version: 1,
      _scope: "machine_independent",
      asset_id: "demo-skill",
      idle: { state: "measured", value_tokens: 42, tokenizer_model: "claude-demo", measured_at: "2026-08-01T00:00:00.000Z" },
      loaded: { state: "unmeasured", value_tokens: null, reason: "credential_missing" },
      idle_definition: "harness-parity",
      harness_alwayson: { state: "unmeasured", value_tokens: null, reason: "not_a_plugin" },
      occupancy_divergence: false,
      occupancy_divergence_ratio: null,
    };
    upsertOccupancy(catalogRoot, "skill", "demo-skill", "demo-skill", occ);
    const readBack = readOccupancy(catalogRoot, "skill", "demo-skill", "demo-skill");
    expect(readBack).toEqual(occ);

    expect(readOccupancy(catalogRoot, "skill", "never-scanned", "never-scanned")).toBeNull();

    const all = listAllOccupancy(catalogRoot);
    expect(all).toHaveLength(1);
    expect(all[0]?.asset_id).toBe("demo-skill");
  });

  it("occupancy-store — upsert는 매 호출마다 최신값으로 덮어쓴다(Asset과 동형의 신뢰 모델)", () => {
    ensureGitRepo(catalogRoot);
    const first: Occupancy = {
      schema_version: 1,
      _scope: "machine_independent",
      asset_id: "demo-skill",
      idle: { state: "unmeasured", value_tokens: null, reason: "credential_missing" },
      loaded: { state: "unmeasured", value_tokens: null, reason: "credential_missing" },
      idle_definition: "harness-parity",
      harness_alwayson: { state: "unmeasured", value_tokens: null, reason: "not_a_plugin" },
      occupancy_divergence: false,
      occupancy_divergence_ratio: null,
    };
    upsertOccupancy(catalogRoot, "skill", "demo-skill", "demo-skill", first);
    const second: Occupancy = { ...first, idle: { state: "measured", value_tokens: 99, tokenizer_model: "claude-demo", measured_at: "2026-08-02T00:00:00.000Z" } };
    upsertOccupancy(catalogRoot, "skill", "demo-skill", "demo-skill", second);

    const readBack = readOccupancy(catalogRoot, "skill", "demo-skill", "demo-skill");
    expect(readBack?.idle).toEqual(second.idle);
  });
});

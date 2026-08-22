import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Annotation, Asset, DocPage } from "@ctk/core";
import { ensureGitRepo } from "../src/local-git-repo.js";
import {
  rebuildCatalogIndex,
  readCatalogIndex,
  setAssetGenState,
  upsertAsset,
  writeAnnotationDoc,
  writeUsageDoc,
} from "../src/asset-store.js";

const asset: Asset = {
  schema_version: 1,
  _scope: "machine_independent",
  id: "demo-skill",
  kind: "skill",
  name: "demo-skill",
  description: "데모",
};

const annotation: Annotation = {
  schema_version: 1,
  _scope: "machine_independent",
  asset_id: "demo-skill",
  role: "역할",
  purpose: "목적",
  when_to_use: "쓸 때",
  gen_mode: "rule_extract",
  gen_source_trust: "local",
  generated_at: "2026-08-21T00:00:00.000Z",
};

const docPage: DocPage = {
  schema_version: 1,
  _scope: "machine_independent",
  asset_id: "demo-skill",
  catalog_relative_path: "catalog/assets/skill/demo-skill/usage.md",
  title: "demo-skill 사용법",
  body: "본문",
  citations: [],
  gen_mode: "rule_extract",
  gen_source_trust: "local",
  generated_at: "2026-08-21T00:00:00.000Z",
};

describe("sync/asset-store — Step 4 gen 문서 쓰기 + gen_state 이월", () => {
  let catalogRoot: string;
  beforeEach(() => {
    catalogRoot = mkdtempSync(path.join(tmpdir(), "ctk-sync-gen-docs-"));
    ensureGitRepo(catalogRoot);
    upsertAsset(catalogRoot, asset);
    rebuildCatalogIndex(catalogRoot);
  });
  afterEach(() => {
    rmSync(catalogRoot, { recursive: true, force: true });
  });

  it("writeAnnotationDoc/writeUsageDoc는 core/catalog/layout.ts의 경로 빌더로만 경로를 만들고 렌더링된 마크다운을 쓴다", () => {
    const { path: annotationPath } = writeAnnotationDoc(catalogRoot, "skill", "demo-skill", annotation);
    const { path: usagePath } = writeUsageDoc(catalogRoot, "skill", "demo-skill", docPage);
    expect(annotationPath).toBe(path.join(catalogRoot, "catalog/assets/skill/demo-skill/annotation.md"));
    expect(usagePath).toBe(path.join(catalogRoot, "catalog/assets/skill/demo-skill/usage.md"));
    expect(existsSync(annotationPath)).toBe(true);
    const content = readFileSync(usagePath, "utf8");
    expect(content).toContain("출처: 서드파티 원문 기반 · 자동 생성");
    expect(content).toContain("본문");
  });

  it("setAssetGenState는 인덱스의 해당 엔트리만 갱신한다", () => {
    const updated = setAssetGenState(catalogRoot, "demo-skill", "fresh", "abc123");
    expect(updated).toBe(true);
    const index = readCatalogIndex(catalogRoot);
    const entry = index.assets.find((e) => e.id === "demo-skill");
    expect(entry?.gen_state).toBe("fresh");
    expect(entry?.gen_content_sha256).toBe("abc123");
  });

  it("존재하지 않는 자산 id에 대해서는 false를 반환하고 인덱스를 건드리지 않는다(추정으로 새 엔트리를 만들지 않는다)", () => {
    const before = readCatalogIndex(catalogRoot);
    const updated = setAssetGenState(catalogRoot, "nonexistent", "fresh");
    expect(updated).toBe(false);
    const after = readCatalogIndex(catalogRoot);
    expect(after).toEqual(before);
  });

  it("rebuildCatalogIndex(예: ctk scan 재실행)는 기존 gen_state/gen_content_sha256을 지우지 않고 이월한다", () => {
    setAssetGenState(catalogRoot, "demo-skill", "fresh", "hash1");
    // scan을 다시 돈 것처럼 asset.json을 다시 쓰고 인덱스를 재생성한다.
    upsertAsset(catalogRoot, { ...asset, description: "설명이 바뀜" });
    rebuildCatalogIndex(catalogRoot);
    const index = readCatalogIndex(catalogRoot);
    const entry = index.assets.find((e) => e.id === "demo-skill");
    expect(entry?.gen_state).toBe("fresh");
    expect(entry?.gen_content_sha256).toBe("hash1");
  });

  it("gen_state가 없는 새 자산은 필드 자체가 없다(생성물 없음 = 필드 부재로 표현)", () => {
    const index = readCatalogIndex(catalogRoot);
    const entry = index.assets.find((e) => e.id === "demo-skill");
    expect(entry?.gen_state).toBeUndefined();
    expect("gen_state" in (entry ?? {})).toBe(false);
  });

  it("readCatalogIndex는 인덱스가 없으면 빈 인덱스를 반환한다", () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "ctk-sync-gen-docs-empty-"));
    try {
      expect(readCatalogIndex(emptyRoot)).toEqual({ schema_version: 1, assets: [] });
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

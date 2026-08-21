import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertNoRawPathLeaks, assetJsonPath, catalogIndexPath, type Asset } from "@ctk/core";

/**
 * sync/src/asset-store.ts — `catalog/assets/<kind>/<name>/asset.json` + `catalog/index.json`
 * (카탈로그 결정 2). Asset은 append-only 스냅샷이 아니라 "현재 정체성"이므로 매 스캔마다
 * upsert(덮어쓰기)한다 — 스킬 설명이 바뀌면 git diff로 그 변화가 드러나는 것이 의도된 동작이다
 * (CLAUDE.md "git diff가 사람이 읽는 변경 이력이 됨").
 *
 * `catalog/index.json`은 마크다운(annotation.md/usage.md, Step 4 `gen`이 생성)에서 재생성
 * 가능해야 한다는 게 결정 2의 장기 불변식이지만, v1 Step 2 시점에는 `gen`이 아직 없으므로
 * `catalog/assets/**\/asset.json` 전수를 다시 읽어 index를 재계산한다 — asset.json 자체가
 * 이미 마크다운보다 상위의 단일 진실 원천이므로 이 재계산도 "재생성 가능" 불변식을 어기지 않는다.
 */
export function upsertAsset(catalogRoot: string, asset: Asset): { path: string } {
  assertNoRawPathLeaks(asset);
  const relPath = assetJsonPath(asset.kind, asset.name);
  const absPath = path.join(catalogRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(asset, null, 2)}\n`, "utf8");
  return { path: absPath };
}

function listAssetJsonFiles(assetsRoot: string): string[] {
  const results: string[] = [];
  if (!existsSync(assetsRoot)) return results;
  for (const kindDir of readdirSync(assetsRoot, { withFileTypes: true })) {
    if (!kindDir.isDirectory()) continue;
    const kindAbs = path.join(assetsRoot, kindDir.name);
    for (const nameDir of readdirSync(kindAbs, { withFileTypes: true })) {
      if (!nameDir.isDirectory()) continue;
      const candidate = path.join(kindAbs, nameDir.name, "asset.json");
      if (existsSync(candidate)) results.push(candidate);
    }
  }
  return results;
}

export interface CatalogIndexEntry {
  id: string;
  kind: Asset["kind"];
  name: string;
}

export interface CatalogIndex {
  schema_version: number;
  assets: CatalogIndexEntry[];
}

/** `catalog/assets/**\/asset.json` 전수를 다시 읽어 `catalog/index.json`을 재생성한다. */
export function rebuildCatalogIndex(catalogRoot: string): { path: string; index: CatalogIndex } {
  const assetsRoot = path.join(catalogRoot, "catalog", "assets");
  const entries: CatalogIndexEntry[] = listAssetJsonFiles(assetsRoot)
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as Asset)
    .map((asset) => ({ id: asset.id, kind: asset.kind, name: asset.name }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const index: CatalogIndex = { schema_version: 1, assets: entries };
  const relPath = catalogIndexPath();
  const absPath = path.join(catalogRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return { path: absPath, index };
}

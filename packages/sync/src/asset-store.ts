import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalogAbsPath } from "./catalog-boundary.js";
import { assertNoRawPathLeaks, assetJsonPath, catalogIndexPath, PathTraversalDetectedError, type Asset } from "@ctk/core";

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
 *
 * ⚠️ **경로 순회 방어는 이제 `core/catalog/layout.ts`의 `assertCatalogSegment()` 한 곳뿐이다**
 * (Step 5 보안 심사 수정 — 호출부마다 따로 있던 가드가 두 벌로 발산했던 문제(`asset-store.ts`는
 * 빈 문자열 허용, `cli/move.ts`는 거부)를 단일 관문으로 통합했다). `asset.name`은 서드파티 자산
 * 저자가 쓰는 값이다(예: `SKILL.md` frontmatter `name`, probe/sources/skills.ts는 이를 검증 없이
 * 그대로 asset id로 쓴다) — `assetJsonPath(kind, name)` 호출 자체가 `assertCatalogSegment()`를
 * 거치므로 여기서 별도로 재검증하지 않는다(`ctk/no-adhoc-path-guard` lint가 중복 가드를 금지한다).
 * `PathTraversalDetectedError`도 core가 던지는 것을 그대로 재노출한다.
 */
export { PathTraversalDetectedError };

export function upsertAsset(catalogRoot: string, asset: Asset): { path: string } {
  assertNoRawPathLeaks(asset);
  const relPath = assetJsonPath(asset.kind, asset.name);
  const absPath = catalogAbsPath(catalogRoot, relPath);
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

/** occupancy 계산(Step 3)이 각 자산의 name+description 등 전체 필드를 필요로 하므로, index보다
 * 풍부한 전수 조회를 제공한다. */
export function listAllAssets(catalogRoot: string): Asset[] {
  const assetsRoot = path.join(catalogRoot, "catalog", "assets");
  return listAssetJsonFiles(assetsRoot)
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as Asset)
    .sort((a, b) => a.id.localeCompare(b.id));
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
  const absPath = catalogAbsPath(catalogRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return { path: absPath, index };
}

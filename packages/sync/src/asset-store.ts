import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FORBIDDEN_RULES, assertNoRawPathLeaks, assetJsonPath, catalogIndexPath, matchesForbidden, type Asset } from "@ctk/core";

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
 * ⚠️ **Step 5 e2e 검증 중 발견한 경로 순회 취약점의 수정**(H2) — `asset.name`은 서드파티
 * 자산 저자가 쓰는 값이다(예: `SKILL.md` frontmatter `name`, probe/sources/skills.ts는 이를
 * 검증 없이 그대로 asset id로 쓴다). `assetJsonPath(kind, name)`은 그 값을 경로 세그먼트로
 * 그대로 문자열 보간하므로, `name: ../../evil` 같은 frontmatter를 자칭한 스킬을 스캔하면
 * `../../evil`이 `path.join`으로 그대로 해석돼 **카탈로그 루트 밖에 파일을 쓸 수 있었다** —
 * `ctk scan`(probe 읽기만 하는 계층으로 취급되던 경로)만으로 트리거되고 actuator의 백업·감사·
 * 롤백을 전혀 거치지 않는 임의 경로 쓰기였다. `core/guard/forbidden.ts`의 판정을 그대로
 * 재사용해 막는다(판정 재구현 금지 원칙과 동형 — 여기서도 새 정규식을 만들지 않는다).
 */
export class PathTraversalDetectedError extends Error {
  readonly failureClass = "path_traversal_detected" as const;
  constructor(fieldName: string, value: string, note: string) {
    super(`asset.${fieldName}가 금지된 경로 패턴과 일치한다(${note}): ${value}`);
    this.name = "PathTraversalDetectedError";
  }
}

function assertSafeCatalogPathSegment(fieldName: "kind" | "name", value: string): void {
  if (value.includes("/") || value.includes("\\")) {
    throw new PathTraversalDetectedError(fieldName, value, "경로 구분자를 포함할 수 없는 단일 세그먼트");
  }
  const forbidden = matchesForbidden(value, FORBIDDEN_RULES);
  if (forbidden) {
    throw new PathTraversalDetectedError(fieldName, value, forbidden.note);
  }
}

export function upsertAsset(catalogRoot: string, asset: Asset): { path: string } {
  assertNoRawPathLeaks(asset);
  assertSafeCatalogPathSegment("kind", asset.kind);
  assertSafeCatalogPathSegment("name", asset.name);
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

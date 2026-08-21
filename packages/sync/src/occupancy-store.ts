import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertNoRawPathLeaks, occupancyJsonPath, parseOccupancy, type Occupancy } from "@ctk/core";
import { catalogAbsPath } from "./catalog-boundary.js";

/**
 * sync/src/occupancy-store.ts — `catalog/assets/<kind>/<name>/occupancy.json`. Occupancy는
 * Asset과 동일한 신뢰 모델(머신 독립, 매 `ctk measure`가 최신값으로 upsert)이므로
 * `asset-store.ts`의 upsertAsset()과 동형으로 구현한다(schema/occupancy.ts 주석 참조).
 */
export function upsertOccupancy(
  catalogRoot: string,
  kind: Parameters<typeof occupancyJsonPath>[0],
  name: string,
  occupancy: Occupancy,
): { path: string } {
  assertNoRawPathLeaks(occupancy);
  const absPath = catalogAbsPath(catalogRoot, occupancyJsonPath(kind, name));
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(occupancy, null, 2)}\n`, "utf8");
  return { path: absPath };
}

export function readOccupancy(
  catalogRoot: string,
  kind: Parameters<typeof occupancyJsonPath>[0],
  name: string,
): Occupancy | null {
  const absPath = catalogAbsPath(catalogRoot, occupancyJsonPath(kind, name));
  if (!existsSync(absPath)) return null;
  return parseOccupancy(JSON.parse(readFileSync(absPath, "utf8")) as unknown);
}

/** `ctk usage` 순위 계산이 전체 자산의 occupancy를 한 번에 필요로 하므로 전수 읽기를 제공한다. */
export function listAllOccupancy(catalogRoot: string): Occupancy[] {
  const assetsRoot = path.join(catalogRoot, "catalog", "assets");
  if (!existsSync(assetsRoot)) return [];
  const results: Occupancy[] = [];
  for (const kindDir of readdirSync(assetsRoot, { withFileTypes: true })) {
    if (!kindDir.isDirectory()) continue;
    const kindAbs = path.join(assetsRoot, kindDir.name);
    for (const nameDir of readdirSync(kindAbs, { withFileTypes: true })) {
      if (!nameDir.isDirectory()) continue;
      const candidate = path.join(kindAbs, nameDir.name, "occupancy.json");
      if (existsSync(candidate)) {
        results.push(parseOccupancy(JSON.parse(readFileSync(candidate, "utf8")) as unknown));
      }
    }
  }
  return results;
}

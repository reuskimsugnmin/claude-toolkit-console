import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalogAbsPath } from "./catalog-boundary.js";
import { assertNoRawPathLeaks, configJsonPath, parseCatalogConfig, type CatalogConfig } from "@ctk/core";

/** sync/src/catalog-config-store.ts — `<catalog>/ctk.config.json`(카탈로그 결정 2). */
export function readCatalogConfig(catalogRoot: string): CatalogConfig | null {
  const absPath = catalogAbsPath(catalogRoot, configJsonPath());
  if (!existsSync(absPath)) return null;
  return parseCatalogConfig(JSON.parse(readFileSync(absPath, "utf8")) as unknown);
}

export function writeCatalogConfig(catalogRoot: string, config: CatalogConfig): { path: string } {
  assertNoRawPathLeaks(config);
  const absPath = catalogAbsPath(catalogRoot, configJsonPath());
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { path: absPath };
}

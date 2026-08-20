import { readFileSync } from "node:fs";
import path from "node:path";
import { catalogIndexPath, parseInstalledPluginsFile } from "@ctk/core";
import type { CatalogIndexEntry } from "@ctk/sync";
import { resolveHomeContext } from "@ctk/probe";
import { readLocalConfig } from "../local-config.js";

/**
 * `ctk verify ac1` — AC-1.1: 스냅샷(카탈로그 index.json, `claude plugin list --json` 경유)의
 * **자산 정체성 집합**과, **CLI 파서를 전혀 거치지 않는 파일 직독 재구성**의 자산 정체성 집합을
 * 대조한다. `claude plugin list`/`claude mcp list` 출력은 이 대조에 절대 쓰지 않는다(순환 제거,
 * P0-6). skill/mcp/cli 소스는 애초에 파일 직독만 쓰므로(spawnClaude를 호출하지 않는다) scan
 * 경로와 재구성 경로가 이미 같은 방법이다 — plugin만 두 경로가 실제로 갈린다(scan은
 * `claude plugin list --json`, 재구성은 `installed_plugins.json` 직독).
 *
 * ⚠️ Step 2 범위: `--report-split`(1.1-정직화: 독립 대조 필드 vs 항등 필드 분리) · `--sample`
 * (AC-1.8 manual) · `--compare`/`--deterministic` 플래그는 이번 패스에 구현하지 않는다 — 이
 * 명령의 핵심 주장(플러그인 자산 집합의 독립 대조 diff)만 최소로 구현한다. 나머지는 후속 단계
 * 과제로 남긴다(실행 보고서에 명시).
 */

export interface VerifyAc1Report {
  independentPluginIdsMatch: boolean;
  onlyInSnapshot: string[];
  onlyInReconstruction: string[];
  snapshotPluginCount: number;
  reconstructedPluginCount: number;
}

function reconstructPluginIds(ctkConfigDir: string): Set<string> {
  const installedPluginsAbs = path.join(ctkConfigDir, "plugins", "installed_plugins.json");
  let raw: string;
  try {
    raw = readFileSync(installedPluginsAbs, "utf8");
  } catch {
    return new Set();
  }
  const parsed = parseInstalledPluginsFile(JSON.parse(raw) as unknown);
  return new Set(Object.keys(parsed.plugins));
}

export async function runVerifyAc1(): Promise<VerifyAc1Report> {
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) {
    throw new Error("카탈로그가 초기화되지 않았다 — 먼저 `ctk init`과 `ctk scan`을 실행해야 한다.");
  }
  const indexAbs = path.join(localConfig.catalog_path, catalogIndexPath());
  let indexEntries: CatalogIndexEntry[] = [];
  try {
    const index = JSON.parse(readFileSync(indexAbs, "utf8")) as { assets: CatalogIndexEntry[] };
    indexEntries = index.assets;
  } catch {
    indexEntries = [];
  }
  const snapshotPluginIds = new Set(indexEntries.filter((e) => e.kind === "plugin").map((e) => e.id));

  const reconstructedPluginIds = reconstructPluginIds(home.ctkConfigDir);

  // skill/mcp/cli는 스캔 경로 자체가 이미 파일 직독뿐이다(spawnClaude를 호출하지 않는다) — 두
  // 경로(scan/재구성)가 방법론상 갈리는 것은 plugin뿐이므로, Step 2 범위에서는 plugin 대조만
  // 리포트한다(위 문서 주석의 명시적 범위 축소).
  const onlyInSnapshot = [...snapshotPluginIds].filter((id) => !reconstructedPluginIds.has(id));
  const onlyInReconstruction = [...reconstructedPluginIds].filter((id) => !snapshotPluginIds.has(id));

  return {
    independentPluginIdsMatch: onlyInSnapshot.length === 0 && onlyInReconstruction.length === 0,
    onlyInSnapshot,
    onlyInReconstruction,
    snapshotPluginCount: snapshotPluginIds.size,
    reconstructedPluginCount: reconstructedPluginIds.size,
  };
}

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  annotationMdPath,
  buildConsoleViewModel,
  machineDir,
  parseInstallation,
  parseUsageMetric,
  usageMdPath,
  type ConsoleViewModel,
  type Installation,
  type UsageMetric,
} from "@ctk/core";
import { resolveHomeContext, type HomeContext } from "@ctk/probe";
import { listAllAssets, listAllOccupancy } from "@ctk/sync";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { CatalogNotInitializedError } from "./scan.js";

/**
 * cli/src/commands/web.ts — Step 6a. 지금은 `--export-view-model`만 구현한다.
 *
 * **뷰모델 조립은 `core/view/view-model.ts`(순수 함수)가 하고 여기서는 읽기만 한다.** 서버가
 * 붙을 때도 같은 함수를 호출한다 — 두 경로가 각자 조립하면 이 export로 검증한 것과 화면이
 * 보여주는 것이 갈릴 수 있고, 그러면 AC-1.4가 검증하려던 대상을 비껴간다.
 */

/** 스냅샷 파일명은 `<iso8601>.jsonl`이며 이름 자체가 시각이다(layout.ts의 `snapshotPath`). */
function listSnapshotFilesNewestFirst(catalogPath: string, machineId: string): string[] {
  const dir = path.join(catalogPath, machineDir(machineId), "snapshots");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function readJsonlRaw(absPath: string): unknown[] {
  return readFileSync(absPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

/**
 * 파일명(`<iso8601>.jsonl`)에서 스캔 시각을 되살린다. `snapshotPath`가 `:`를 파일명에 쓸 수 없어
 * `-`로 바꿔 쓰므로 역변환이 필요하다 — 되살리지 못하면 `null`을 반환한다(추측한 시각을
 * 신선도 계산에 넣지 않는다).
 */
export function snapshotFileNameToIso(fileName: string): string | null {
  const base = path.basename(fileName, ".jsonl");
  // 2026-08-22T09-52-24.912Z → 2026-08-22T09:52:24.912Z
  const restored = base.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  return Number.isNaN(new Date(restored).getTime()) ? null : restored;
}

interface ScanSnapshot {
  installations: Installation[];
  scannedAtIso: string | null;
}

/**
 * 가장 최근 **scan** 스냅샷(Installation이 담긴 파일)을 찾는다. `measure`가 남긴 스냅샷에는
 * Installation이 없으므로 건너뛴다 — 파일 하나만 보고 "설치 0건"으로 결론내지 않는다.
 */
function findLatestScanSnapshot(catalogPath: string, machineId: string): ScanSnapshot {
  for (const file of listSnapshotFilesNewestFirst(catalogPath, machineId)) {
    const installations: Installation[] = [];
    for (const raw of readJsonlRaw(file)) {
      if (typeof raw !== "object" || raw === null || !("install_scope" in raw)) continue;
      try {
        installations.push(parseInstallation(raw));
      } catch {
        // 이 행은 Installation이 아니었다 — Toggle 등 다른 레코드가 같은 파일에 섞여 있다.
      }
    }
    if (installations.length > 0) return { installations, scannedAtIso: snapshotFileNameToIso(file) };
  }
  return { installations: [], scannedAtIso: null };
}

function findLatestUsageMetrics(catalogPath: string, machineId: string): UsageMetric[] {
  for (const file of listSnapshotFilesNewestFirst(catalogPath, machineId)) {
    const metrics: UsageMetric[] = [];
    for (const raw of readJsonlRaw(file)) {
      if (typeof raw !== "object" || raw === null || !("call_count" in raw)) continue;
      try {
        metrics.push(parseUsageMetric(raw));
      } catch {
        // usage 파일이 아니었다 — 다음 스냅샷으로.
      }
    }
    if (metrics.length > 0) return metrics;
  }
  return [];
}

export interface BuildViewModelOptions {
  home?: HomeContext | undefined;
  unusedExpensive?: number | undefined;
  now?: Date | undefined;
}

export function buildViewModelFromCatalog(options: BuildViewModelOptions = {}): ConsoleViewModel {
  const home = options.home ?? resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;
  const machine = readOrCreateMachineIdentity(home, "local-machine");

  const assets = listAllAssets(catalogPath);
  const { installations, scannedAtIso } = findLatestScanSnapshot(catalogPath, machine.machine_id);

  const docPresence = new Map(
    assets.map((a) => [
      a.id,
      {
        annotation: existsSync(path.join(catalogPath, annotationMdPath(a.kind, a.name))),
        usage: existsSync(path.join(catalogPath, usageMdPath(a.kind, a.name))),
      },
    ]),
  );

  return buildConsoleViewModel({
    machineId: machine.machine_id,
    assets,
    installations,
    occupancy: listAllOccupancy(catalogPath),
    usage: findLatestUsageMetrics(catalogPath, machine.machine_id),
    lastScanAt: scannedAtIso,
    docPresence,
    unusedExpensiveLimit: options.unusedExpensive ?? 5,
    now: options.now ?? new Date(),
  });
}

export interface ExportViewModelResult {
  path: string;
  assetCount: number;
  rankedCount: number;
  unrankableCount: number;
  freshnessDays: number | null;
  /** 순위를 결론으로 제시할 수 있는가 — 못 하면 그 이유를 그대로 출력한다. */
  rankingQuality: ConsoleViewModel["usage"]["ranking_quality"];
}

/** `ctk web --export-view-model <path>` — 서버를 띄우지 않고 뷰모델 JSON만 파일로 쓴다(AC-1.4). */
export function runExportViewModel(outPath: string, options: BuildViewModelOptions = {}): ExportViewModelResult {
  const viewModel = buildViewModelFromCatalog(options);
  const absPath = path.resolve(outPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(viewModel, null, 2)}\n`, "utf8");
  return {
    path: absPath,
    assetCount: viewModel.assets.length,
    rankedCount: viewModel.usage.ranked.length,
    unrankableCount: viewModel.usage.unrankable.length,
    freshnessDays: viewModel.freshness.days_since_last_scan,
    rankingQuality: viewModel.usage.ranking_quality,
  };
}

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  annotationMdPath,
  buildConsoleViewModel,
  buildProjectChoices,
  hashPath,
  machineDir,
  parseInstallation,
  parseUsageMetric,
  usageMdPath,
  type Asset,
  type ConsoleViewModel,
  type Installation,
  type UsageMetric,
} from "@ctk/core";
import { listKnownProjectPaths, resolveHomeContext, type HomeContext } from "@ctk/probe";
import { listAllAssets, listAllOccupancy } from "@ctk/sync";
import { startReadonlyServer, type AssetDocKind, type ListeningServer } from "@ctk/web";
import { createActionHandlers, createSessionToken } from "./web-actions.js";
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

  // ⚠️ 절대경로는 **여기서 라벨로 바꾸고 버린다.** 경로를 뷰모델에 실어 보내고 화면에서
  // 자르면 그 순간 응답 본문에 디렉터리 구조가 들어가 있다 — 보안 심사 M1이 지적한 형태다.
  const projects = buildProjectChoices({
    absolutePaths: listKnownProjectPaths(home),
    hashPrefixOf: (p) => hashPath(p).slice(0, 6),
  });

  return buildConsoleViewModel({
    machineId: machine.machine_id,
    projects,
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


/**
 * 자산 문서 본문을 읽는다. **경로는 URL이 아니라 카탈로그가 아는 kind/name에서만 만든다** —
 * `assetId`는 조회 키로만 쓰이고 경로 산출에 들어가지 않는다(H2). 카탈로그에 없는 id면 `null`이다.
 */
function readAssetDoc(catalogPath: string, assets: readonly { id: string; kind: Asset["kind"]; name: string }[], assetId: string, which: AssetDocKind): string | null {
  const asset = assets.find((a) => a.id === assetId);
  if (asset === undefined) return null;
  const relPath = which === "annotation" ? annotationMdPath(asset.kind, asset.name) : usageMdPath(asset.kind, asset.name);
  const absPath = path.join(catalogPath, relPath);
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath, "utf8");
}

export interface ServeOptions extends BuildViewModelOptions {
  port?: number | undefined;
  /** Step 6b — 쓰기 액션을 여는 명시 옵트인. 기본은 조회 전용이다. */
  actions?: boolean | undefined;
}

export interface ServeResult {
  server: ListeningServer;
  /** 액션 모드에서만 발급된다. 조회 모드에서는 `null`. */
  sessionToken: string | null;
}

/**
 * `ctk web` — 조회 전용 서버를 띄운다(Step 6a).
 *
 * 뷰모델은 **요청마다 다시 만든다.** 기동 시 한 번 캐시하면 `ctk scan`/`measure`를 돌린 뒤에도
 * 화면이 옛 값을 보여주는데, 그 화면에는 "마지막 스캔 N일 전" 신선도 표시가 함께 있어
 * **틀린 값에 최신이라는 딱지가 붙는다.**
 */
export async function runWebServe(options: ServeOptions = {}): Promise<ServeResult> {
  const home = options.home ?? resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;

  const base = {
    getViewModel: () => buildViewModelFromCatalog({ ...options, home }),
    getAssetDoc: (assetId: string, which: AssetDocKind) =>
      readAssetDoc(catalogPath, listAllAssets(catalogPath), assetId, which),
  };

  if (options.actions !== true) {
    // 조회 모드 — `actions`를 넘기지 않으므로 `/api/actions`는 **라우트로 존재하지 않는다.**
    return { server: await startReadonlyServer({ ...base, port: options.port ?? 0 }), sessionToken: null };
  }

  // 액션 모드는 관문이 실제 포트를 알아야 Host/Origin을 대조할 수 있다. 포트를 먼저 확정하려고
  // 조회 서버를 한 번 띄웠다 닫는다 — 0번 포트를 OS가 고르게 두면서도 관문이 그 값을 알 수 있는
  // 유일한 방법이다. (사용자가 --port를 주면 이 왕복은 생략된다.)
  let port = options.port ?? 0;
  if (port === 0) {
    const probe = await startReadonlyServer({ ...base, port: 0 });
    port = probe.port;
    await probe.close();
  }

  const sessionToken = createSessionToken();
  const server = await startReadonlyServer({
    ...base,
    port,
    actions: { guard: { sessionToken, port }, handlers: createActionHandlers() },
  });
  return { server, sessionToken };
}

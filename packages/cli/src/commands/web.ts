import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  annotationMdPath,
  buildConsoleViewModel,
  buildProjectChoices,
  containsPathSeparator,
  hashPath,
  type ProjectChoice,
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

/**
 * 이관 대상 선택지를 만든다.
 *
 * ⚠️ **절대경로는 여기서 라벨로 바꾸고 버린다.** 경로를 뷰모델에 실어 보내고 화면에서 자르면
 * 그 순간 응답 본문에 디렉터리 구조가 들어가 있다 — 보안 심사 M1이 지적한 형태다.
 *
 * ⚠️ **`~/.claude.json`을 못 읽는 것이 콘솔 전체를 죽이면 안 된다**(재심 M5). 이 함수가
 * 던지면 `getViewModel()`이 500을 내고 `boot()`가 한 줄만 남긴 채 끝나 **롤백 버튼조차 뜨지
 * 않는다** — 빠져나갈 길이 없는 거부다(안전 원칙 6). 그렇다고 실패를 "프로젝트 0건"으로
 * 위장하지도 않는다(원칙 7) — 이유를 실어 화면이 말하게 한다.
 */
function collectProjectChoices(
  home: HomeContext,
  includeProjects: boolean,
): {
  projects: ProjectChoice[];
  projectsUnavailable: string | null;
} {
  // `--no-projects`로 끈 것은 "못 읽었다"와 다른 사실이다 — 사유를 따로 둔다.
  // 하나로 뭉치면 화면이 "고칠 것이 있다"와 "내가 껐다"를 같게 말한다.
  if (!includeProjects) return { projects: [], projectsUnavailable: "disabled_by_flag" };

  let projects: ProjectChoice[];
  try {
    projects = buildProjectChoices({
      absolutePaths: listKnownProjectPaths(home),
      hashPrefixOf: (p) => hashPath(p),
    });
  } catch {
    return { projects: [], projectsUnavailable: "claude_json_unreadable" };
  }

  // 계약을 주석이 아니라 코드로 막는다(재심 M2). `containsPathSeparator`는 이 모듈이 선언한
  // 계약인데 프로덕션에서 한 번도 호출되지 않았다 — "규칙 존재 ≠ 규칙이 막음"의 그 자리다.
  // 라벨에 구분자가 있으면 그건 세그먼트가 아니라 경로 조각이고, 그 응답은 나가면 안 된다.
  if (containsPathSeparator(projects)) {
    return { projects: [], projectsUnavailable: "label_contains_path_separator" };
  }
  return { projects, projectsUnavailable: null };
}

export interface BuildViewModelOptions {
  home?: HomeContext | undefined;
  unusedExpensive?: number | undefined;
  now?: Date | undefined;
  /**
   * `false`면 프로젝트 선택지를 응답에 싣지 않는다(`--no-projects`).
   *
   * 조회 엔드포인트는 **무인증**이므로(막을 대상은 "다른 출처"이지 "사용자 본인"이 아니다)
   * 여기 실리는 디렉터리 이름은 같은 머신의 **다른 계정**도 읽을 수 있다 — `~/.claude.json`이
   * `-rw-------`인 것과 비교하면 접근 통제가 느슨해진다. 공용 호스트에서 이 플래그로 끈다.
   */
  includeProjects?: boolean | undefined;
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

  const { projects, projectsUnavailable } = collectProjectChoices(home, options.includeProjects !== false);

  return buildConsoleViewModel({
    machineId: machine.machine_id,
    projects,
    projectsUnavailable,
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

/**
 * 기동 시 사용자에게 알릴 노출 고지. **결정을 매번 사용자 앞에 다시 놓는다**(재심 L1).
 *
 * 착수 전 점검으로 "민감한 이름 0건"을 확인했지만 그것은 **시점 표본**이다 —
 * `~/.claude.json`은 새 디렉터리에서 `claude`를 한 번 띄우면 자동으로 늘어나고, 한 달 뒤
 * 늘어난 이름을 아무도 다시 점검하지 않는다. 건수를 매번 출력하면 그 변화가 눈에 띈다.
 *
 * 노출이 실제로 없으면(0건·꺼짐·못 읽음) `null`이다 — 아무 일도 없는데 경고하지 않는다.
 */
export function projectExposureNotice(viewModel: ConsoleViewModel): string | null {
  if (viewModel.projects.length === 0) return null;
  return (
    `⚠️  프로젝트 이름 ${viewModel.projects.length}건이 무인증 로컬 응답(/api/view-model)에 실린다.\n` +
    `    같은 머신의 다른 계정도 읽을 수 있다 — 공용 호스트라면 --no-projects로 끈다.`
  );
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
  /**
   * 기동 시 출력할 노출 고지(없으면 `null`). **조회 모드에서도 나온다** — 노출은 액션 여부와
   * 무관하게 `/api/view-model`에서 일어나기 때문이다.
   */
  exposureNotice: string | null;
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

  // 고지는 실제로 나갈 응답을 기준으로 만든다 — 플래그·읽기 실패가 이미 반영된 값이다.
  const exposureNotice = projectExposureNotice(base.getViewModel());

  if (options.actions !== true) {
    // 조회 모드 — `actions`를 넘기지 않으므로 `/api/actions`는 **라우트로 존재하지 않는다.**
    return {
      server: await startReadonlyServer({ ...base, port: options.port ?? 0 }),
      sessionToken: null,
      exposureNotice,
    };
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
  return { server, sessionToken, exposureNotice };
}

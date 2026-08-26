import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectCliTools,
  collectMcp,
  collectPlugins,
  collectSkills,
  resolveHomeContext,
  type HomeContext,
} from "@ctk/probe";
import {
  acquireLock,
  commitAll,
  ensureGitRepo,
  ensureMachine,
  migrateCatalogPaths,
  rebuildCatalogIndex,
  upsertAsset,
  writeRunLog,
  writeSnapshot,
} from "@ctk/sync";
import { FAILURE_CLASSES, type Asset, type AssetKind, type FailureClass, type Installation, type RunLogEntry, type Toggle } from "@ctk/core";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";

export class CatalogNotInitializedError extends Error {
  constructor() {
    super("카탈로그가 초기화되지 않았다 — 먼저 `ctk init`을 실행해야 한다.");
    this.name = "CatalogNotInitializedError";
  }
}

export interface ScanSummary {
  catalogPath: string;
  snapshotPath: string;
  runLogPath: string;
  assetCounts: Record<AssetKind, number>;
  installationCount: number;
  toggleCount: number;
  scopeDistribution: Record<string, number>;
  durationMs: number;
}

function mergeAssets(...groups: Asset[][]): Asset[] {
  const byId = new Map<string, Asset>();
  for (const group of groups) {
    for (const asset of group) {
      if (!byId.has(asset.id)) byId.set(asset.id, asset);
    }
  }
  return [...byId.values()];
}

function countAssetKinds(assets: Asset[]): Record<AssetKind, number> {
  const counts: Record<AssetKind, number> = { plugin: 0, skill: 0, mcp: 0, cli: 0, agent: 0, command: 0 };
  for (const asset of assets) counts[asset.kind]++;
  return counts;
}

const FAILURE_CLASS_SET = new Set<string>(FAILURE_CLASSES);

/** 던져진 오류가 알려진 `failure_class`를 싣고 있으면 그대로 쓰고, 아니면 "unclassified"로 남긴다. */
function extractFailureClass(err: unknown): FailureClass {
  if (
    typeof err === "object" &&
    err !== null &&
    "failureClass" in err &&
    typeof (err as { failureClass: unknown }).failureClass === "string" &&
    FAILURE_CLASS_SET.has((err as { failureClass: string }).failureClass)
  ) {
    return (err as { failureClass: FailureClass }).failureClass;
  }
  return "unclassified";
}

function countScopes(installations: Installation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const inst of installations) {
    const key = inst.install_scope ?? "(none)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function collectAll(
  home: HomeContext,
  machineId: string,
  cwd: string,
  spawnFn: Parameters<typeof collectPlugins>[0]["spawnFn"],
) {
  const plugins = await collectPlugins({ home, machineId, cwd, timeoutSec: 30, spawnFn });
  const skills = collectSkills({ home, machineId });
  const cliTools = collectCliTools({ home, machineId });
  const installedPluginNames = new Set(plugins.assets.map((a) => a.name));
  const mcp = collectMcp({ home, machineId, installedPluginNames });
  return { plugins, skills, cliTools, mcp };
}

export interface RunScanOptions {
  /** 테스트 주입용 — 실제 `claude` 바이너리 없이 `ctk scan`을 왕복 검증하기 위해 열어둔다. */
  spawnFn?: Parameters<typeof collectPlugins>[0]["spawnFn"];
}

export async function runScan(options: RunScanOptions = {}): Promise<ScanSummary> {
  const startedAt = new Date();
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) {
    throw new CatalogNotInitializedError();
  }
  const catalogPath = localConfig.catalog_path;
  const machine = readOrCreateMachineIdentity(home, "local-machine");

  const lock = acquireLock(catalogPath, {
    command: "scan",
    origin: "cli",
    started_at: startedAt.toISOString(),
    machine_id: machine.machine_id,
  });

  let failureClass: RunLogEntry["failure_class"] = null;
  let exitCode = 0;

  try {
    ensureGitRepo(catalogPath);
    ensureMachine(catalogPath, {
      schema_version: 1,
      _scope: "machine_dependent",
      id: machine.machine_id,
      alias: machine.alias,
      first_seen_at: startedAt.toISOString(),
    });

    const tmpCwd = mkdtempSync(path.join(tmpdir(), "ctk-scan-"));
    let collected: Awaited<ReturnType<typeof collectAll>>;
    try {
      collected = await collectAll(home, machine.machine_id, tmpCwd, options.spawnFn);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }

    const assets = mergeAssets(
      collected.plugins.assets,
      collected.skills.assets,
      collected.mcp.assets,
      collected.cliTools.assets,
    );
    const installations: Installation[] = [
      ...collected.plugins.installations,
      ...collected.skills.installations,
      ...collected.mcp.installations,
      ...collected.cliTools.installations,
    ];
    const toggles: Toggle[] = [...collected.mcp.toggles];

    // ⚠️ B1 Step 1 — 구 레이아웃(`catalog/assets/<kind>/<name>/`) 잔존 디렉터리를 새 경로
    // (`<kind>/<name>__<id 해시8>/`)로 옮긴다. **반드시 upsertAsset·rebuildCatalogIndex보다
    // 먼저** 돈다 — 먼저 upsertAsset이 새 경로에 asset.json을 써버리면 이전기가 구 경로를
    // 새 경로로 옮기려 할 때 대상이 이미 존재해 충돌한다.
    migrateCatalogPaths(catalogPath);

    for (const asset of assets) {
      upsertAsset(catalogPath, asset);
    }
    rebuildCatalogIndex(catalogPath);

    const snapshot = writeSnapshot(catalogPath, machine.machine_id, startedAt.toISOString(), [
      ...installations,
      ...toggles,
    ]);

    const finishedAt = new Date();
    const runLogEntry: RunLogEntry = {
      schema_version: 1,
      _scope: "machine_dependent",
      command: "scan",
      args: {
        counts: {
          assets_scanned: assets.length,
          installations: installations.length,
          toggles: toggles.length,
        },
      },
      machine_id: machine.machine_id,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      exit_code: 0,
      failure_class: null,
    };
    const runLog = writeRunLog(catalogPath, runLogEntry);

    commitAll(catalogPath, `ctk scan: ${startedAt.toISOString()}`);

    return {
      catalogPath,
      snapshotPath: snapshot.path,
      runLogPath: runLog.path,
      assetCounts: countAssetKinds(assets),
      installationCount: installations.length,
      toggleCount: toggles.length,
      scopeDistribution: countScopes(installations),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
  } catch (err) {
    exitCode = 1;
    // 회귀 수정(Step 2, test-engineer 실측 발견) — 이전 구현은 실제로 던져진 오류가 어떤
    // failure_class(예: parse_schema_mismatch·duplicate_snapshot_key)를 실어 나르는지 보지 않고
    // 무조건 "unclassified"로 로그를 남겼다. 이 오류 taxonomy(core/failure/classes.ts)를 만든
    // 목적 자체가 "무슨 일이 있었는지 run-log만 보고 구분한다"인데, 그 정보를 여기서 버리고
    // 있었다 — 조용한 실패는 아니지만 조용한 강등(diagnostic downgrade)이었다.
    failureClass = extractFailureClass(err);
    const finishedAt = new Date();
    try {
      writeRunLog(catalogPath, {
        schema_version: 1,
        _scope: "machine_dependent",
        command: "scan",
        args: {},
        machine_id: machine.machine_id,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        exit_code: exitCode,
        failure_class: failureClass,
      });
    } catch {
      // 실패 로그 기록 자체가 실패해도 원본 오류를 삼키지 않는다 — 아래에서 재throw.
    }
    throw err;
  } finally {
    lock.release();
  }
}

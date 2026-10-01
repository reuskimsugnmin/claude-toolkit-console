import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLI_ASSET_ID_PREFIX, assetPathSegment, parseAsset } from "@ctk/core";

/**
 * sync/src/migrate-catalog-paths.ts — B1 Step 1 일회성 이전기.
 *
 * `core/catalog/layout.ts`의 경로 축이 `(kind,name)`에서 `(kind,name,id)`로 바뀌면서, 이 변경
 * 이전에 쓰인 구 레이아웃(`catalog/assets/<kind>/<name>/`)은 새 빌더가 찾는 경로
 * (`catalog/assets/<kind>/<name>__<id의 sha256 앞 8자>/`)와 더 이상 일치하지 않는다. 이 모듈은
 * 디스크에 남은 구 레이아웃 디렉터리를 **통째로**(annotation.md·usage.md·occupancy.json 포함)
 * 새 경로로 옮긴다 — 이 문서들은 `gen`이 LLM으로 만든 산출물이라 재생성은 재지출이다.
 *
 * ⚠️ **되돌릴 길이 없다.** 실제로 옮기기 전에는 카탈로그 저장소(git)가 깨끗해야 한다 — 문제가
 * 생기면 `git checkout .`으로 되돌릴 수 있게. 옮길 대상이 하나도 없으면(이미 전량 이전됨) 이
 * 검사를 하지 않는다 — 매 `ctk scan`마다 이 함수가 호출되므로, 이미 끝난 이전 때문에 평소
 * 스캔까지 "카탈로그가 깨끗해야 한다"는 새 제약을 얹으면 안 된다. `--dry-run`도 아무 것도
 * 쓰지 않으므로 이 검사를 거치지 않는다.
 *
 * **판정 방식**: 디렉터리 이름이 "구 레이아웃처럼 보이는지" 추측하지 않는다. 각 leaf
 * 디렉터리의 `asset.json`을 읽어 `(name,id)`로 기대 세그먼트를 다시 계산하고, 실제 디렉터리
 * 이름과 다르면 이동 대상이다 — 이미 새 경로면 자연히 무동작(멱등).
 */

export class DirtyCatalogRepoError extends Error {
  readonly failureClass = "dirty_catalog_repo" as const;
  constructor(readonly catalogRoot: string) {
    super(
      "카탈로그 저장소의 git 트리가 더럽다 — 경로 이전은 되돌릴 수 없으므로 거부한다. " +
        "먼저 커밋하거나(`git -C <catalog> add -A && git -C <catalog> commit`), " +
        "--dry-run으로 무엇이 옮겨질지 먼저 확인한다.",
    );
    this.name = "DirtyCatalogRepoError";
  }
}

export interface MigrateCatalogPathsOptions {
  /** 실제로 옮기지 않고 무엇이 옮겨질지만 계산한다. 이 모드는 git 트리 상태를 확인하지 않는다. */
  dryRun?: boolean;
}

export interface MigratedAssetEntry {
  id: string;
  kind: string;
  name: string;
  /** catalogRoot 기준 상대경로 — 절대경로를 결과에 남기지 않는다. */
  from: string;
  to: string;
  /** 옛 bare-id CLI 자산(D2) — 옮기기 전에 `asset.json`의 `id`·`occupancy.json`의 `asset_id`를 이 값으로 고친다. */
  rewriteId?: string;
}

export interface MigrateCatalogPathsResult {
  moved: MigratedAssetEntry[];
  /** 같은 CLI의 새 id 디렉터리가 이미 있어 **순수 중복**으로 지운 옛 bare-id CLI 디렉터리(catalogRoot 상대경로, D2). */
  removed: string[];
  /** 이미 새 경로였던(무동작) 자산 디렉터리 수 — 멱등성 검증에 쓴다. */
  skippedCount: number;
  dryRun: boolean;
}

function runGitStatusPorcelain(cwd: string): string {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`카탈로그 저장소 git 상태 확인 실패: ${result.stderr || result.error?.message || "알 수 없는 오류"}`);
  }
  return result.stdout;
}

/** 카탈로그 루트가 git 저장소가 아니면 통과시킨다 — 되돌릴 커밋 자체가 없다. */
function assertCleanCatalogGitTree(catalogRoot: string): void {
  if (!existsSync(path.join(catalogRoot, ".git"))) return;
  const status = runGitStatusPorcelain(catalogRoot);
  if (status.trim().length > 0) {
    throw new DirtyCatalogRepoError(catalogRoot);
  }
}

interface AssetLeafDir {
  kindDirName: string;
  currentSegment: string;
  absPath: string;
}

function listAssetLeafDirs(assetsRoot: string): AssetLeafDir[] {
  const results: AssetLeafDir[] = [];
  if (!existsSync(assetsRoot)) return results;
  for (const kindDir of readdirSync(assetsRoot, { withFileTypes: true })) {
    if (!kindDir.isDirectory()) continue;
    const kindAbs = path.join(assetsRoot, kindDir.name);
    for (const leafDir of readdirSync(kindAbs, { withFileTypes: true })) {
      if (!leafDir.isDirectory()) continue;
      const leafAbs = path.join(kindAbs, leafDir.name);
      if (!existsSync(path.join(leafAbs, "asset.json"))) continue;
      results.push({ kindDirName: kindDir.name, currentSegment: leafDir.name, absPath: leafAbs });
    }
  }
  return results;
}

/**
 * `catalog/assets/**`를 훑어 구 레이아웃 디렉터리를 새 경로(`<name>__<id 해시8>`)로 옮긴다.
 * 멱등이다 — 이미 새 경로인 디렉터리는 건드리지 않는다(`skippedCount`로 집계).
 */
export function migrateCatalogPaths(
  catalogRoot: string,
  options: MigrateCatalogPathsOptions = {},
): MigrateCatalogPathsResult {
  const dryRun = options.dryRun === true;
  const assetsRoot = path.join(catalogRoot, "catalog", "assets");
  const moved: MigratedAssetEntry[] = [];
  const removed: string[] = [];
  let skippedCount = 0;

  for (const leaf of listAssetLeafDirs(assetsRoot)) {
    const raw = JSON.parse(readFileSync(path.join(leaf.absPath, "asset.json"), "utf8")) as unknown;
    const asset = parseAsset(raw);

    // ROADMAP D2 — #44 이전 스캔이 남긴 bare-id CLI 자산(`id: "codex"`). 그대로 두면 인덱스가 디스크의
    // 파일로 재구성되므로 새 `cli:codex`와 **두 행**이 된다. gen은 CLI를 원문 없음으로 건너뛰므로 이 디렉터리엔
    // `asset.json`·`occupancy.json`뿐이다(실측) — 그 밖의 파일이 있으면 추측하지 않고 멈춘다.
    if (asset.kind === "cli" && !asset.id.startsWith(CLI_ASSET_ID_PREFIX)) {
      const unexpected = readdirSync(leaf.absPath).filter((f) => !LEGACY_CLI_LEAF_FILES.has(f));
      if (unexpected.length > 0) {
        throw new Error(
          `옛 bare-id CLI 자산(id=${asset.id})에 예상 밖 파일이 있어 자동 이전하지 않는다: ${unexpected.join(", ")} — ` +
            `${path.relative(catalogRoot, leaf.absPath)}를 확인해 옮기거나 지운 뒤 다시 scan한다.`,
        );
      }
      const newId = `${CLI_ASSET_ID_PREFIX}${asset.id}`;
      const targetAbs = path.join(assetsRoot, leaf.kindDirName, assetPathSegment(asset.name, newId));
      if (existsSync(targetAbs)) {
        removed.push(path.relative(catalogRoot, leaf.absPath)); // 새 id로 이미 스캔됐다 — 순수 중복
      } else {
        moved.push({
          id: newId,
          kind: asset.kind,
          name: asset.name,
          from: path.relative(catalogRoot, leaf.absPath),
          to: path.relative(catalogRoot, targetAbs),
          rewriteId: newId,
        });
      }
      continue;
    }
    const expectedSegment = assetPathSegment(asset.name, asset.id);

    if (leaf.currentSegment === expectedSegment) {
      skippedCount++;
      continue;
    }

    const targetAbs = path.join(assetsRoot, leaf.kindDirName, expectedSegment);
    if (existsSync(targetAbs)) {
      throw new Error(
        `이전 대상 경로가 이미 존재한다(자산 id=${asset.id}): ` +
          `${path.relative(catalogRoot, targetAbs)} — 두 디렉터리가 같은 새 경로로 계산됐다(예상 밖 충돌, 수동 확인 필요).`,
      );
    }

    moved.push({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      from: path.relative(catalogRoot, leaf.absPath),
      to: path.relative(catalogRoot, targetAbs),
    });
  }

  if (dryRun || (moved.length === 0 && removed.length === 0)) {
    return { moved, removed, skippedCount, dryRun };
  }

  // 실제로 옮기기 직전 — 되돌릴 길이 없으므로 여기서만 깨끗한 트리를 요구한다(지우는 것도 git으로만 되돌린다).
  assertCleanCatalogGitTree(catalogRoot);

  for (const entry of moved) {
    const fromAbs = path.join(catalogRoot, entry.from);
    const toAbs = path.join(catalogRoot, entry.to);
    if (entry.rewriteId !== undefined) rewriteLegacyCliIds(fromAbs, entry.rewriteId);
    mkdirSync(path.dirname(toAbs), { recursive: true });
    renameSync(fromAbs, toAbs);
  }
  for (const rel of removed) rmSync(path.join(catalogRoot, rel), { recursive: true });

  return { moved, removed, skippedCount, dryRun };
}

/** 옛 bare-id CLI 디렉터리에 있을 수 있는 파일 전부(실측 — gen은 CLI 문서를 만들지 않는다). */
const LEGACY_CLI_LEAF_FILES = new Set(["asset.json", "occupancy.json"]);

/** id를 품는 두 자리를 고친다. 고친 `asset.json`은 다시 파싱해 스키마를 통과해야 쓴다. */
function rewriteLegacyCliIds(leafAbs: string, newId: string): void {
  const assetAbs = path.join(leafAbs, "asset.json");
  const asset = parseAsset({ ...(JSON.parse(readFileSync(assetAbs, "utf8")) as object), id: newId });
  writeFileSync(assetAbs, `${JSON.stringify(asset, null, 2)}\n`, "utf8");
  const occupancyAbs = path.join(leafAbs, "occupancy.json");
  if (existsSync(occupancyAbs)) {
    const occupancy = JSON.parse(readFileSync(occupancyAbs, "utf8")) as Record<string, unknown>;
    writeFileSync(occupancyAbs, `${JSON.stringify({ ...occupancy, asset_id: newId }, null, 2)}\n`, "utf8");
  }
}

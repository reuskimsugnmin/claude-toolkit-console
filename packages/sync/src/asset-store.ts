import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { catalogAbsPath } from "./catalog-boundary.js";
import {
  annotationMdPath,
  assertNoRawPathLeaks,
  AssetKindSchema,
  assetJsonPath,
  catalogIndexPath,
  PathTraversalDetectedError,
  renderAnnotationMarkdown,
  renderDocPageMarkdown,
  usageMdPath,
  type Annotation,
  type Asset,
  type DocPage,
} from "@ctk/core";

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
 * 그대로 asset id로 쓴다) — `assetJsonPath(kind, name, id)` 호출 자체가 `assertCatalogSegment()`를
 * 거치므로 여기서 별도로 재검증하지 않는다(`ctk/no-adhoc-path-guard` lint가 중복 가드를 금지한다).
 * `PathTraversalDetectedError`도 core가 던지는 것을 그대로 재노출한다.
 */
export { PathTraversalDetectedError };

export function upsertAsset(catalogRoot: string, asset: Asset): { path: string } {
  assertNoRawPathLeaks(asset);
  const relPath = assetJsonPath(asset.kind, asset.name, asset.id);
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

/**
 * Step 4 — `gen`의 부분 실패 상태 규약(§4 Step 4 "gen의 부분 실패(반개) 상태"). 처리된 자산은
 * `"fresh"`, 아직 처리되지 않은 자산은 `"pending"`, 원본이 바뀌었으나 재생성에 실패한 자산은
 * `"stale"`이다. 이 값이 없으면(Step 2까지의 자산) `gen`이 아직 그 자산을 다루지 않은 것이다.
 */
/**
 * `policy_blocked` — **원문 자체가 정책에 걸려 재시도해도 같은 결과가 나오는 상태.**
 * `stale`(다음 실행이 다시 시도한다)과 갈라야 한다: 인젝션 후검증에 걸리는 자산은
 * 원문이 `rm -rf`·`sudo` 같은 파괴적 명령을 **문서화**하고 있어서, 돌릴 때마다 돈을 쓰고
 * 매번 실패했다(실측 2026-08-26: 3자산이 매 배치에서 반복 실패).
 *
 * ⚠️ **영구 차단이 아니다.** 인젝션 탐지는 확정적이지 않다 — 모델이 그 토큰을 인용할지가
 * 매번 다르다. 그래서 `gen_content_sha256`을 함께 기록하고 **원문이 그대로일 때만** 건너뛴다.
 * 원문이 바뀌면 자동으로 다시 대상이 된다(자기 치유).
 */
export const GenIndexStateSchema = z.enum(["fresh", "pending", "stale", "policy_blocked"]);
export type GenIndexState = z.infer<typeof GenIndexStateSchema>;

/**
 * B1 Step 3 — `catalog/index.json`의 행 스키마. 이전에는 zod가 아닌 평범한 인터페이스였고
 * 읽는 두 곳(`readExistingIndexOrNull` 아래, `cli/commands/move.ts`)이 전부 `as` 캐스팅이었다
 * (AC-7이 요구하는 "실제 파서"가 없었다). `parent_asset_id?`는 additive-optional이라
 * `schema_version`을 올리지 않는다(B1 결정 5) — 옛 행(이 필드가 없던 시절)도 그대로 통과한다.
 */
export const CatalogIndexEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: AssetKindSchema,
    name: z.string().min(1),
    /** B1 Step 3 — `Asset.parent_asset_id`를 그대로 인덱스 행에 반영(뷰가 파일을 다시 안 읽고도
     * 계층을 알 수 있도록). Asset 스키마와 달리 kind별 필수/금지 강제는 여기서 하지 않는다 —
     * 인덱스는 파생 캐시이고 원 판정은 Asset 쪽에서 이미 끝났다. */
    parent_asset_id: z.string().min(1).optional(),
    gen_state: GenIndexStateSchema.optional(),
    /** 마지막으로 `gen_state:"fresh"`를 만든 시점의 원본 콘텐츠 sha256 — `gen/src/plan.ts`의
     * 증분 대상 판정 키다. */
    gen_content_sha256: z.string().optional(),
  })
  .strict();
export type CatalogIndexEntry = z.infer<typeof CatalogIndexEntrySchema>;

export const CatalogIndexSchema = z
  .object({
    schema_version: z.number(),
    assets: z.array(CatalogIndexEntrySchema),
  })
  .strict();
export type CatalogIndex = z.infer<typeof CatalogIndexSchema>;

export function parseCatalogIndex(data: unknown): CatalogIndex {
  return CatalogIndexSchema.parse(data);
}

export interface CatalogIndexReadResult {
  index: CatalogIndex | null;
  /**
   * true면 인덱스 파일은 존재했지만 JSON 파싱 또는 스키마 검증에 실패해 `null`로 **열화**했다.
   * false + `index:null`은 파일이 아예 없는 "없음"이다 — "없음"과 "실패"를 반환값에서 구분한다
   * (CLAUDE.md 안전 원칙 7). 열화 자체은 유지한다: 손상 인덱스 하나로 `ctk scan`이 죽으면
   * 안전 원칙 6(탈출구 없는 fail-closed) 위반이다. `gen_state` 이월이 끊기는 것은 최선일 뿐
   * 필수 불변식이 아니라는 근거가 `rebuildCatalogIndex`의 주석에 있다.
   */
  corrupted: boolean;
}

/** 인덱스를 읽고 파싱한다 — "없음"(파일 부재)과 "실패"(손상)를 반환값에서 구분해 싣는다. */
export function readCatalogIndexOrNull(catalogRoot: string): CatalogIndexReadResult {
  const absPath = catalogAbsPath(catalogRoot, catalogIndexPath());
  if (!existsSync(absPath)) return { index: null, corrupted: false };
  try {
    const raw: unknown = JSON.parse(readFileSync(absPath, "utf8"));
    return { index: parseCatalogIndex(raw), corrupted: false };
  } catch {
    return { index: null, corrupted: true };
  }
}

function readExistingIndexOrNull(catalogRoot: string): CatalogIndex | null {
  return readCatalogIndexOrNull(catalogRoot).index;
}

/**
 * `catalog/assets/**\/asset.json` 전수를 다시 읽어 `catalog/index.json`을 재생성한다.
 *
 * ⚠️ **`gen_state`/`gen_content_sha256`는 이월한다.** `ctk scan`이 매번 이 함수를 호출하는데,
 * scan은 자산의 설치 상태만 갱신할 뿐 gen 산출물과는 무관하다 — 재생성마다 gen 상태를
 * 지워버리면 매 scan 후 모든 자산이 "미생성"으로 보이는 조용한 회귀가 된다(§4 Step 4 부분
 * 실패 규약과 충돌). 기존 인덱스를 먼저 읽어 id별 gen 상태를 이월하고, 새로 등장한 자산에는
 * 필드를 아예 넣지 않는다(생성물 없음 = "gen이 아직 안 다뤘다"를 필드 부재로 표현).
 */
export function rebuildCatalogIndex(catalogRoot: string): { path: string; index: CatalogIndex } {
  const assetsRoot = path.join(catalogRoot, "catalog", "assets");
  const previous = readExistingIndexOrNull(catalogRoot);
  const previousById = new Map((previous?.assets ?? []).map((e) => [e.id, e]));

  const entries: CatalogIndexEntry[] = listAssetJsonFiles(assetsRoot)
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as Asset)
    .map((asset) => {
      const prior = previousById.get(asset.id);
      const entry: CatalogIndexEntry = { id: asset.id, kind: asset.kind, name: asset.name };
      if (asset.parent_asset_id !== undefined) entry.parent_asset_id = asset.parent_asset_id;
      if (prior?.gen_state !== undefined) entry.gen_state = prior.gen_state;
      if (prior?.gen_content_sha256 !== undefined) entry.gen_content_sha256 = prior.gen_content_sha256;
      return entry;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const index: CatalogIndex = { schema_version: 1, assets: entries };
  const relPath = catalogIndexPath();
  const absPath = catalogAbsPath(catalogRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return { path: absPath, index };
}

/**
 * Step 4 — `annotation.md`/`usage.md`를 렌더링해 쓴다. 경로는 항상
 * `core/catalog/layout.ts`의 `annotationMdPath`/`usageMdPath`(ctk 생성 id에서만 산출, H2)로만
 * 만든다 — `gen`이 이 문자열들을 만들지 않고 `Annotation`/`DocPage`의 `asset_id`로 카탈로그가
 * 이미 알고 있는 `kind`/`name`을 재사용해야 하므로, 이 함수는 `kind`/`name`을 별도 인자로
 * 받는다(레코드 자체에는 카탈로그 경로 세그먼트가 없다 — Asset이 그 권위 출처다).
 */
export function writeAnnotationDoc(
  catalogRoot: string,
  kind: Asset["kind"],
  name: string,
  id: string,
  annotation: Annotation,
): { path: string } {
  const relPath = annotationMdPath(kind, name, id);
  const absPath = catalogAbsPath(catalogRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, renderAnnotationMarkdown(annotation), "utf8");
  return { path: absPath };
}

export function writeUsageDoc(
  catalogRoot: string,
  kind: Asset["kind"],
  name: string,
  id: string,
  docPage: DocPage,
): { path: string } {
  const relPath = usageMdPath(kind, name, id);
  const absPath = catalogAbsPath(catalogRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, renderDocPageMarkdown(docPage), "utf8");
  return { path: absPath };
}

/**
 * 자산 하나의 `gen_state`/`gen_content_sha256`만 갱신한다(인덱스 전체 재생성 없이) — gen 루프가
 * 자산을 처리할 때마다 호출한다. 대상 id가 인덱스에 없으면(scan이 아직 안 됐거나 드리프트)
 * 아무것도 하지 않고 `false`를 반환한다(추정으로 새 엔트리를 만들지 않는다, P2).
 */
export function setAssetGenState(
  catalogRoot: string,
  assetId: string,
  state: GenIndexState,
  contentSha256?: string,
): boolean {
  const current = readExistingIndexOrNull(catalogRoot);
  if (current === null) return false;
  const entry = current.assets.find((e) => e.id === assetId);
  if (entry === undefined) return false;
  entry.gen_state = state;
  if (contentSha256 !== undefined) entry.gen_content_sha256 = contentSha256;
  const absPath = catalogAbsPath(catalogRoot, catalogIndexPath());
  writeFileSync(absPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  return true;
}

/** 현재 카탈로그 인덱스를 읽는다(없으면 빈 인덱스) — `gen/src/plan.ts`가 증분 대상을 정할 때 쓴다. */
export function readCatalogIndex(catalogRoot: string): CatalogIndex {
  return readExistingIndexOrNull(catalogRoot) ?? { schema_version: 1, assets: [] };
}

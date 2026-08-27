import { bundledParentId, type Asset, type AssetKind } from "../schema/asset.js";
import type { Installation, InstallScope, McpStateSource } from "../schema/installation.js";
import type { Occupancy, OccupancyValue } from "../schema/occupancy.js";
import type { UsageMetric } from "../schema/usage.js";
import { computeFreshness } from "../snapshot/freshness.js";
import { rankUnusedExpensive, type UnusedExpensiveRow } from "../usage/rank.js";
import type { ProjectChoice } from "./project-label.js";

/**
 * core/src/view/view-model.ts — Step 6a 조회 전용 웹 콘솔이 받는 뷰모델. **순수 함수다** —
 * 카탈로그를 이미 읽은 호출자(cli/web)가 레코드 배열을 넘긴다.
 *
 * 서버와 `ctk web --export-view-model`이 **같은 함수**를 쓴다. 두 경로가 서로 다른 조립 코드를
 * 가지면 자동 검증(export)이 통과해도 화면(server)은 다른 것을 보여줄 수 있다 — 검증이 검증하려던
 * 대상을 비껴가는 구조가 된다.
 *
 * ## 이 모듈이 지키는 두 가지 구분
 *
 * **① `unmeasured`를 숫자 0으로 만들지 않는다**(Step 6a 수용 기준). 점유 값은 3상태 그대로
 * 실어 보내고, 순위표는 `measured`만 담는다. 나머지는 `unrankable`에 **이유와 함께** 따로 담긴다.
 *
 * **② MCP 상태에서 `unknown`을 `unset`/`disabled`로 뭉개지 않는다**(OQ-7 안 C). 스키마상
 * `mcp_enabled_state`는 nullable이고 null이 두 가지 뜻으로 쓰인다 — MCP가 아닌 자산에서는
 * "개념 없음", MCP 자산에서는 "판정 못 함(AC-0.4ⓑ 미확정)". 화면은 이 둘을 구분해야 하므로
 * 여기서 `not_applicable`과 `unknown`으로 **갈라서** 내보낸다. `?? "unset"` 한 줄이면
 * 두 사실이 모두 사라진다.
 */

/** 화면에 실제로 표시되는 MCP 상태. 스키마의 nullable을 뜻이 다른 두 값으로 가른다. */
export type McpStateView = "enabled" | "disabled" | "unset" | "unknown" | "not_applicable";

/**
 * exhaustive switch + 반환형에 `undefined` 없음(B1 Step 2, 결정 2 #5) — 이전에는
 * `if (kind !== "mcp") return "not_applicable"`로 "우연히 맞는" 형태였다. `kind === "mcp"`
 * 외의 모든 값이 같은 답을 내는 게 여전히 맞지만, 이제는 새 kind가 추가돼도 이 함수가 그 값을
 * 실제로 검토하지 않고 지나치는 일이 없다 — 컴파일이 강제한다.
 */
export function toMcpStateView(kind: AssetKind, state: Installation["mcp_enabled_state"]): McpStateView {
  switch (kind) {
    case "mcp":
      return state ?? "unknown";
    case "plugin":
    case "skill":
    case "cli":
    case "agent":
    case "command":
      return "not_applicable";
  }
}

export interface RepoLinkView {
  kind: "github" | "git" | "directory";
  /** `directory` 출처는 원격 URL이 없다 — 빈 문자열이 아니라 `null`이다. */
  url: string | null;
}

export interface InstallationView {
  install_scope: InstallScope | null;
  enabled_at: InstallScope | null;
  project_path_hash: string | null;
  mcp_state: McpStateView;
  mcp_state_source: McpStateSource | null;
}

/**
 * B1 Step 6, 결정 4(b) — 설치 출처 3-arm 판별 유니온. **`installations: InstallationView[]`를
 * 병기가 아니라 교체한다.**
 *
 * 번들 자식(agent·command, 번들 skill)은 `Installation` 레코드를 스스로 갖지 않는다
 * (Step 5) — "설치 정보 없음"은 부모에게서 상속해야 할 사실이지 그 자산이 "미설치"라는
 * 뜻이 아니다. 이것을 빈 배열로 내면 두 사실이 같은 모양이 된다(안전 원칙 7).
 *
 * 세 번째 arm(`inherited_unavailable`)이 핵심이다 — 부모를 해석하지 못했을 때도 빈 배열을
 * 내면 "없음"과 "실패"가 다시 뭉개진다. 선례: `toRepoView`(아래) · `RankingQualityView` ·
 * `McpStateView`(위).
 */
export type AssetInstallationsView =
  | { source: "own"; installations: InstallationView[] }
  | { source: "inherited_from_parent"; parent_id: string; installations: InstallationView[] }
  | {
      source: "inherited_unavailable";
      parent_id: string;
      /**
       * `parent_not_in_catalog` — `parent_id`가 이번 스냅샷의 자산 목록에 아예 없다(부모가
       * 삭제됐거나 카탈로그가 갈라졌다). `parent_row_missing` — 부모 자산 자체는 있지만
       * 그 부모의 설치 정보를 내부적으로 못 찾았다(구성 불일치에 대한 방어적 분기). 둘 다
       * "부모가 없다"로 뭉치면 원인을 구분할 수 없다.
       */
      reason: "parent_not_in_catalog" | "parent_row_missing";
    };

export interface AssetRowView {
  id: string;
  kind: AssetKind;
  name: string;
  marketplace: string | null;
  description: string | null;
  /** `null` = 이 자산 유형에 저장소 개념이 없거나 아직 수집되지 않았다(링크 없음과 구분된다). */
  repo: RepoLinkView | null;
  /**
   * 번들 부모 자산의 id. 최상위 자산(독립 skill·mcp·cli·plugin)은 `null`이다.
   *
   * **평면 배열 + `parent_id`다 — 중첩 트리가 아니다.** `child_ids`도 두지 않는다(간선
   * 이중 저장). 소비자가 `web` 하나뿐이라는 사실은 "트리로 바꿔도 된다"가 아니라 "평면을
   * 유지할 자유가 있다"다: 검색이 평면 순회 한 번으로 끝나고, 접기는 렌더 시점에 `parent_id`로
   * 묶기만 하면 된다(D4). 정렬은 `localeCompare`라 `@`·`:`의 상대 순서가 로케일 의존이므로,
   * 소비자는 정렬 인접성이 아니라 이 필드로 명시적으로 묶어야 한다.
   */
  parent_id: string | null;
  /** 자산 하나가 여러 스코프·프로젝트에 설치될 수 있다 — 병합하지 않는다(P1-13). */
  installations: AssetInstallationsView;
  /** 생성 문서 존재 여부. 상세 화면이 무엇을 보여줄 수 있는지 결정한다. */
  has_annotation: boolean;
  has_usage_doc: boolean;
}

export interface FreshnessView {
  last_scan_at: string | null;
  days_since_last_scan: number | null;
  is_stale: boolean;
  /** 스캔 기록이 아예 없으면 "0일 전"이 아니라 이 값이 `true`다. */
  never_scanned: boolean;
}

export interface UnrankableAssetView {
  asset_id: string;
  /** 왜 순위에 못 들어갔는지 — 상태와 이유를 그대로 싣는다. */
  occupancy_idle: OccupancyValue;
}

/**
 * 순위가 **결론으로 읽힐 자격이 있는가**. 값이 전부 정확해도 모집단이 퇴화하면 결론은 거짓이 된다.
 *
 * 실측(2026-08-22)에서 그대로 나왔다: 자산 183개 중 177개가 `credential_missing`으로 순위에서
 * 빠지고, 남은 `measured` 6개는 MCP·CLI뿐인데 이들의 상시 비용은 **정말로 0**이다. 그래서
 * "안 쓰는데 비싼 툴 상위 5"가 전부 0토큰으로 채워진다. 각 숫자는 맞지만 화면이 답하는
 * 질문("내가 안 쓰는 가장 비싼 툴은?")에 대해서는 거짓이다.
 *
 * 그래서 순위를 지우지 않고 **자격을 함께 싣는다.** 지우면 "측정할 게 없다"와 "0이 최선이다"가
 * 구분되지 않고, 자격 없이 실으면 화면이 거짓을 말한다.
 */
export type RankingQualityReason = "ok" | "no_measured_assets" | "all_measured_are_zero";

export interface RankingQualityView {
  measured_count: number;
  unmeasured_count: number;
  is_meaningful: boolean;
  reason: RankingQualityReason;
}

export interface UsageView {
  /** idle이 `measured`인 자산만. 정렬·상한은 `rankUnusedExpensive`가 정한다. */
  ranked: UnusedExpensiveRowView[];
  /** `unmeasured`/`approx_bytes` 자산 — 순위와 **분리 표시**한다(Step 6a). */
  unrankable: UnrankableAssetView[];
  total_assets_with_occupancy: number;
  /** 이 순위를 결론으로 제시해도 되는가. `is_meaningful`이 false면 화면은 순위 대신 이유를 말한다. */
  ranking_quality: RankingQualityView;
}

/**
 * `measuredIdleTokens`는 **순위 상한으로 잘리기 전** 전체 measured 자산의 idle 값이어야 한다 —
 * 상위 N개만 보면 N개가 우연히 0일 때와 전체가 0일 때를 구분하지 못한다.
 */
export function assessRankingQuality(
  measuredIdleTokens: readonly number[],
  unmeasuredCount: number,
): RankingQualityView {
  const measuredCount = measuredIdleTokens.length;
  if (measuredCount === 0) {
    return { measured_count: 0, unmeasured_count: unmeasuredCount, is_meaningful: false, reason: "no_measured_assets" };
  }
  if (measuredIdleTokens.every((tokens) => tokens === 0)) {
    return {
      measured_count: measuredCount,
      unmeasured_count: unmeasuredCount,
      is_meaningful: false,
      reason: "all_measured_are_zero",
    };
  }
  return { measured_count: measuredCount, unmeasured_count: unmeasuredCount, is_meaningful: true, reason: "ok" };
}

/** `UnusedExpensiveRow`를 그대로 쓴다 — 뷰 전용으로 다시 정의하면 두 정의가 어긋난다. */
export type UnusedExpensiveRowView = UnusedExpensiveRow;

export interface ConsoleViewModel {
  schema_version: number;
  generated_at: string;
  machine_id: string;
  freshness: FreshnessView;
  assets: AssetRowView[];
  usage: UsageView;
  /**
   * 이관 대상으로 고를 수 있는 프로젝트. **라벨은 경로의 마지막 세그먼트뿐이고 절대경로는
   * 담지 않는다**(project-label.ts). 인덱스가 곧 `move`의 인자이므로 순서를 바꾸지 않는다.
   */
  projects: ProjectChoice[];
  /**
   * 선택지를 만들지 못한 이유. `null`이면 정상이고, 값이 있으면 **"프로젝트가 0건"이 아니라
   * "읽지 못했다"**는 뜻이다(재심 M5) — 화면은 이 둘을 구분해 표시해야 한다.
   */
  projects_unavailable: string | null;
}

export interface BuildViewModelInput {
  machineId: string;
  assets: readonly Asset[];
  installations: readonly Installation[];
  occupancy: readonly Occupancy[];
  usage: readonly UsageMetric[];
  /** 가장 최근 스냅샷 시각. 스캔 기록이 없으면 `null`. */
  lastScanAt: string | null;
  /** 자산 id → 생성 문서 존재 여부. 호출자가 파일시스템에서 확인해 넘긴다(core는 I/O를 하지 않는다). */
  docPresence: ReadonlyMap<string, { annotation: boolean; usage: boolean }>;
  unusedExpensiveLimit: number;
  now: Date;
  /** 호출자가 이미 라벨로 바꾼 선택지. core는 경로를 보지 않는다. */
  projects: readonly ProjectChoice[];
  /** 선택지를 만들지 못했으면 그 이유. 실패를 빈 목록으로 위장하지 않는다. */
  projectsUnavailable?: string | null;
}

export function buildConsoleViewModel(input: BuildViewModelInput): ConsoleViewModel {
  const installationsByAsset = new Map<string, Installation[]>();
  for (const installation of input.installations) {
    const list = installationsByAsset.get(installation.asset_id);
    if (list === undefined) installationsByAsset.set(installation.asset_id, [installation]);
    else list.push(installation);
  }

  // 부모 해석에 쓰는 두 조회 자료구조. **같은 `input.assets` 순회에서 함께 만들어야** 두 맵의
  // 키 집합이 일치한다 — `assetsById`에는 있는데 `ownInstallationsByAssetId`에는 없는 경우가
  // "내부 구성 불일치"(parent_row_missing)이고, `assetsById`에 아예 없는 경우가 "부모가 카탈로그에
  // 없음"(parent_not_in_catalog)이다. 두 실패를 구분하지 않으면 원인을 되짚을 수 없다(안전 원칙 7).
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset] as const));
  const ownInstallationsByAssetId = new Map<string, InstallationView[]>(
    input.assets.map((asset) => [
      asset.id,
      (installationsByAsset.get(asset.id) ?? []).map((installation) => toInstallationView(asset, installation)),
    ]),
  );

  const assets: AssetRowView[] = input.assets
    .map((asset) => {
      const docs = input.docPresence.get(asset.id);
      const parentId = bundledParentId(asset);
      return {
        id: asset.id,
        kind: asset.kind,
        name: asset.name,
        marketplace: asset.marketplace ?? null,
        description: asset.description ?? null,
        repo: toRepoView(asset),
        parent_id: parentId,
        installations: resolveInstallationsView(asset.id, parentId, assetsById, ownInstallationsByAssetId),
        has_annotation: docs?.annotation ?? false,
        has_usage_doc: docs?.usage ?? false,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const { ranked, excludedUnmeasuredAssetIds } = rankUnusedExpensive({
    usage: input.usage,
    occupancy: input.occupancy,
    limit: input.unusedExpensiveLimit,
  });

  // 자격 판정은 **상한으로 자르기 전** 전체 measured 모집단을 본다(rankUnusedExpensive의 반환값은
  // 이미 잘려 있으므로 occupancy에서 다시 센다).
  const measuredIdleTokens = input.occupancy
    .filter((o) => o.idle.state === "measured")
    .map((o) => (o.idle.state === "measured" ? o.idle.value_tokens : 0));

  const occupancyById = new Map(input.occupancy.map((o) => [o.asset_id, o]));
  const unrankable: UnrankableAssetView[] = excludedUnmeasuredAssetIds.flatMap((assetId) => {
    const occ = occupancyById.get(assetId);
    // 제외 목록에 있는 id는 occupancy에서 온 것이므로 반드시 찾아진다. 못 찾으면 조용히
    // 빈 값을 만들지 않고 그 자산을 빼버린다 — 여기서 그럴듯한 상태를 지어내면 화면이
    // "측정됨"과 구분되지 않는 무언가를 표시하게 된다.
    return occ === undefined ? [] : [{ asset_id: assetId, occupancy_idle: occ.idle }];
  });

  return {
    schema_version: 1,
    generated_at: input.now.toISOString(),
    machine_id: input.machineId,
    freshness: toFreshnessView(input.lastScanAt, input.now),
    assets,
    projects: [...input.projects],
    projects_unavailable: input.projectsUnavailable ?? null,
    usage: {
      ranked,
      unrankable,
      total_assets_with_occupancy: input.occupancy.length,
      ranking_quality: assessRankingQuality(measuredIdleTokens, excludedUnmeasuredAssetIds.length),
    },
  };
}

function toInstallationView(asset: Asset, installation: Installation): InstallationView {
  return {
    install_scope: installation.install_scope,
    enabled_at: installation.enabled_at,
    project_path_hash: installation.project_path_hash,
    mcp_state: toMcpStateView(asset.kind, installation.mcp_enabled_state),
    mcp_state_source: installation.mcp_state_source,
  };
}

/**
 * 결정 4(b) 3-arm을 채운다. `parentId === null`이면 이 자산 자체의 설치 정보(own)를 낸다 —
 * 최상위 자산이 설치 기록 0건인 것은 정상 상태이고 `installations: []`로 정확히 표현된다.
 *
 * `parentId !== null`이면(번들 자식) 부모의 own-installations를 그대로 상속한다. 부모를 두
 * 단계로 조회하는 이유는 실패 지점을 구분하기 위해서다 — `assetsById`에 없으면 부모 자산
 * 자체가 카탈로그에 없는 것이고, `ownInstallationsByAssetId`에 없으면(현재 구성에서는
 * 도달하지 않지만 방어적으로 남긴다) 내부 조회가 어긋난 것이다. 둘 다 빈 배열로 뭉개면
 * "부모에 설치가 0건"과 "부모를 못 찾았다"가 같은 모양이 된다.
 */
function resolveInstallationsView(
  assetId: string,
  parentId: string | null,
  assetsById: ReadonlyMap<string, Asset>,
  ownInstallationsByAssetId: ReadonlyMap<string, InstallationView[]>,
): AssetInstallationsView {
  if (parentId === null) {
    return { source: "own", installations: ownInstallationsByAssetId.get(assetId) ?? [] };
  }
  if (!assetsById.has(parentId)) {
    return { source: "inherited_unavailable", parent_id: parentId, reason: "parent_not_in_catalog" };
  }
  const parentInstallations = ownInstallationsByAssetId.get(parentId);
  if (parentInstallations === undefined) {
    return { source: "inherited_unavailable", parent_id: parentId, reason: "parent_row_missing" };
  }
  return { source: "inherited_from_parent", parent_id: parentId, installations: parentInstallations };
}

function toRepoView(asset: Asset): RepoLinkView | null {
  if (asset.repo_source === undefined) return null;
  return { kind: asset.repo_source, url: asset.repo_url ?? null };
}

function toFreshnessView(lastScanAt: string | null, now: Date): FreshnessView {
  if (lastScanAt === null) {
    // "스캔한 적 없음"을 "0일 전"으로 표시하면 가장 신선한 상태로 보인다 — 정반대다.
    return { last_scan_at: null, days_since_last_scan: null, is_stale: true, never_scanned: true };
  }
  const parsed = new Date(lastScanAt);
  if (Number.isNaN(parsed.getTime())) {
    return { last_scan_at: lastScanAt, days_since_last_scan: null, is_stale: true, never_scanned: false };
  }
  const freshness = computeFreshness(parsed, now);
  return {
    last_scan_at: lastScanAt,
    days_since_last_scan: freshness.days_since_last_scan,
    is_stale: freshness.is_stale,
    never_scanned: false,
  };
}

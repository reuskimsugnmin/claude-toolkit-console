import type { Asset, AssetKind } from "../schema/asset.js";
import type { Installation, InstallScope, McpStateSource } from "../schema/installation.js";
import type { Occupancy, OccupancyValue } from "../schema/occupancy.js";
import type { UsageMetric } from "../schema/usage.js";
import { computeFreshness } from "../snapshot/freshness.js";
import { rankUnusedExpensive, type UnusedExpensiveRow } from "../usage/rank.js";

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

export function toMcpStateView(kind: AssetKind, state: Installation["mcp_enabled_state"]): McpStateView {
  if (kind !== "mcp") return "not_applicable";
  return state ?? "unknown";
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

export interface AssetRowView {
  id: string;
  kind: AssetKind;
  name: string;
  marketplace: string | null;
  description: string | null;
  /** `null` = 이 자산 유형에 저장소 개념이 없거나 아직 수집되지 않았다(링크 없음과 구분된다). */
  repo: RepoLinkView | null;
  /** 자산 하나가 여러 스코프·프로젝트에 설치될 수 있다 — 병합하지 않는다(P1-13). */
  installations: InstallationView[];
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
}

export function buildConsoleViewModel(input: BuildViewModelInput): ConsoleViewModel {
  const installationsByAsset = new Map<string, Installation[]>();
  for (const installation of input.installations) {
    const list = installationsByAsset.get(installation.asset_id);
    if (list === undefined) installationsByAsset.set(installation.asset_id, [installation]);
    else list.push(installation);
  }

  const assets: AssetRowView[] = input.assets
    .map((asset) => {
      const docs = input.docPresence.get(asset.id);
      return {
        id: asset.id,
        kind: asset.kind,
        name: asset.name,
        marketplace: asset.marketplace ?? null,
        description: asset.description ?? null,
        repo: toRepoView(asset),
        installations: (installationsByAsset.get(asset.id) ?? []).map((installation) => ({
          install_scope: installation.install_scope,
          enabled_at: installation.enabled_at,
          project_path_hash: installation.project_path_hash,
          mcp_state: toMcpStateView(asset.kind, installation.mcp_enabled_state),
          mcp_state_source: installation.mcp_state_source,
        })),
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
    usage: {
      ranked,
      unrankable,
      total_assets_with_occupancy: input.occupancy.length,
      ranking_quality: assessRankingQuality(measuredIdleTokens, excludedUnmeasuredAssetIds.length),
    },
  };
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

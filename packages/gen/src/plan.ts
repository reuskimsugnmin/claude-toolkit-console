import { createHash } from "node:crypto";
import type { Asset, AssetDocState } from "@ctk/core";
import type { HomeContext } from "@ctk/probe";
import type { CatalogIndex, CatalogIndexEntry } from "@ctk/sync";
import { FileHygieneError } from "./file-hygiene.js";
import {
  resolveAssetSource,
  type AssetSourceSections,
  type ResolvedAssetSource,
  type UnresolvedSourceReason,
} from "./source-resolve.js";

/**
 * gen/src/plan.ts — 콘텐츠 해시 기반 증분 대상 산출. 각 자산의 원본 텍스트(섹션 전체)를 해시해
 * 카탈로그 인덱스에 이미 기록된 `gen_content_sha256`과 비교한다 — 같으면 건너뛰고, 다르거나
 * 없으면(신규) 대상에 넣는다. `gen_state:"stale"`인 자산은 원본이 그대로여도 항상 대상에 넣는다
 * (직전 실행이 실패로 남긴 것 — §4 Step 4 부분 실패 규약).
 */

export type GenTargetReason = "new" | "changed" | "stale";

export interface GenPlanTarget {
  asset: Asset;
  reason: GenTargetReason;
  sections: AssetSourceSections;
  sourceContentSha256: string;
}

/** 파일 위생(H2)에 걸려 원문을 읽지 않은 자산 — 건너뛴 **사실과 이유**를 함께 남긴다. */
export interface GenSkippedAsset {
  assetId: string;
  failureClass: string;
  reason: string;
}

/**
 * 원문을 구하지 못해 대상에서 빠진 자산 — **사유를 함께 남긴다.**
 *
 * 이전 필드명은 `emptyAssetIds: string[]`였고 셋을 한 목록으로 합쳤다. 실측(2026-08-24)에서
 * 그 12건은 드리프트 0건 · 중복 설치 6건 · 유형상 원문 부재 6건이었고 **처방이 전부 달랐다** —
 * 목록만 보여주면 사용자는 있지도 않은 드리프트를 조사하게 된다.
 */
export interface GenUnresolvedAsset {
  assetId: string;
  reason: UnresolvedSourceReason;
  /** `reason === "ambiguous_source"`일 때만. 이 머신에서 발견된 원문 위치 수. */
  locationCount?: number;
}

export interface GenPlanResult {
  targets: GenPlanTarget[];
  /** 원문을 구하지 못한 자산 — gen이 건드리지 않는다. **사유별로 처방이 다르다.** */
  unresolved: GenUnresolvedAsset[];
  /**
   * 위생 검사가 거부한 자산.
   *
   * ⚠️ **한 자산의 위생 실패가 전체 실행을 죽이지 않는다.** 이전 구현은 예외를 그대로
   * 위로 던져, 스킬 하나가 심볼릭 링크이면 `ctk gen`이 통째로 실패했다 — 실측 환경에서
   * 55개 스킬이 링크라 gen이 아예 사용 불가였다. 거부는 옳지만(링크를 따라가면 `~/.ssh`
   * 내용이 카탈로그에 박힌다) **범위가 틀렸다**: 그 자산만 빼고 나머지는 처리한다.
   * 사용자에게는 빠져나갈 길이 있어야 한다(안전 원칙 6).
   */
  skipped: GenSkippedAsset[];
  upToDateCount: number;
  /**
   * 번들 자식(`parent_asset_id`가 있는 자산)인데 그 부모가 `bundledParents`에 없어 대상에서
   * 빠진 건수. **조용한 `continue`를 만들지 않는다** — 문을 닫아도 몇 건이 닫혔는지는 항상
   * 보여준다(결정 6 · AC-6). 사유별로 다시 나눌 필요가 없다: 이 축은 "부모를 지정했는가"
   * 하나뿐이다.
   */
  excludedBundled: number;
}

/**
 * 메시지에 절대경로가 섞이지 않았는지 마지막으로 훑는다 — 위생 에러는 애초에 경로를 넣지
 * 않지만(file-hygiene.ts), 새 에러 타입이 그 규약을 어겨도 브라우저까지 나가지 않게 한다.
 * 홈 상대화가 아니라 **제거**다: 홈 밖 프로젝트 경로는 상대화로 가려지지 않는다(심사 L-b).
 */
function scrubPaths(message: string): string {
  return message.replace(/(?:^|\s)(\/[^\s:]+)/g, " <경로 생략>");
}

function hashSections(sections: AssetSourceSections): string {
  const hash = createHash("sha256");
  for (const section of sections) {
    hash.update(section.label, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(section.content, "utf8");
    hash.update("\u0000", "utf8");
  }
  return hash.digest("hex");
}

export interface PlanGenTargetsOptions {
  home: HomeContext;
  assets: readonly Asset[];
  index: CatalogIndex;
  /** `--max-assets N`(estimate.ts 이전 단계에서 이미 잘라 넘길 수도 있지만, plan 자체도
   * 지원해 둔다 — 대상 산출 자체가 비용이 드는 read I/O이므로). */
  maxAssets?: number;
  /** `--retry-blocked` — 정책 차단된 자산도 다시 시도한다. 가드의 탈출구다(안전 원칙 6). */
  retryPolicyBlocked?: boolean;
  /**
   * 문서 생성 대상으로 삼을 번들 부모(플러그인) `Asset.id` 목록 — `--plugin`(반복 가능)의
   * CLI 표면. **선택 필드가 아니다.** 빈 배열이 기본이고, 그러면 `parent_asset_id`가 있는
   * 자식은 전부 대상에서 빠진다(결정 6 · AC-6 "기본 무동작").
   *
   * `parent_asset_id`가 없는 최상위 자산(오늘의 카탈로그 전부)은 이 값과 무관하게 그대로
   * 대상이 된다 — 이 필드가 좁히는 것은 **번들 자식 축뿐**이다.
   *
   * **필수 필드로 두는 이유**: `planGenTargets`를 부르는 네 곳(`cli/gen.ts`의 dry-run·비용
   * 고지, `gen/index.ts`의 실제 실행, `cli/web-actions.ts`의 웹 승인)이 각자 무엇을 넘길지
   * 명시하게 강제한다 — 선택 필드였다면 하나가 빠져도 컴파일이 통과해 "고지한 건수 ≠ 실행한
   * 건수"가 조용히 생긴다(안전 원칙 5).
   */
  bundledParents: readonly string[];
}

export function planGenTargets(options: PlanGenTargetsOptions): GenPlanResult {
  const { home, assets, index, maxAssets, retryPolicyBlocked, bundledParents } = options;
  const indexById = new Map(index.assets.map((e) => [e.id, e]));

  const targets: GenPlanTarget[] = [];
  const unresolved: GenUnresolvedAsset[] = [];
  const skipped: GenSkippedAsset[] = [];
  let upToDateCount = 0;
  let excludedBundled = 0;

  for (const asset of assets) {
    if (maxAssets !== undefined && targets.length >= maxAssets) break;

    // 번들 자식인데 그 부모가 지정되지 않았다 — 판정(judgeAsset)까지 가지 않고 여기서 빠진다.
    // **건수를 반드시 싣는다**(excludedBundled) — 조용한 continue를 만들지 않는다(결정 6).
    if (asset.parent_asset_id !== undefined && !bundledParents.includes(asset.parent_asset_id)) {
      excludedBundled++;
      continue;
    }

    // ⚠️ 판정은 `judgeAsset` **한 곳**에서만 한다. 단건 조회(`classifyAssetDocState`)와 이
    // 일괄 산출이 각자 판정하면 화면이 말하는 사유와 `gen`이 실제로 하는 일이 갈린다 —
    // 그 드리프트는 조용하고, 두 경로가 같은 함수를 타야 구조적으로 막힌다.
    const verdict = judgeAsset(home, asset, indexById.get(asset.id), retryPolicyBlocked);
    switch (verdict.kind) {
      case "blocked":
        skipped.push({ assetId: asset.id, failureClass: verdict.failureClass, reason: verdict.reason });
        continue;
      case "unresolved":
        unresolved.push({
          assetId: asset.id,
          reason: verdict.reason,
          ...(verdict.locationCount === undefined ? {} : { locationCount: verdict.locationCount }),
        });
        continue;
      case "up-to-date":
        upToDateCount++;
        continue;
      case "target":
        targets.push({
          asset,
          reason: verdict.reason,
          sections: verdict.sections,
          sourceContentSha256: verdict.sourceContentSha256,
        });
        continue;
    }
  }

  return { targets, unresolved, skipped, upToDateCount, excludedBundled };
}

/** `judgeAsset`의 내부 판정 결과. 일괄 산출과 단건 조회가 **둘 다 이것을** 근거로 삼는다. */
type AssetVerdict =
  | { kind: "blocked"; failureClass: string; reason: string }
  | { kind: "unresolved"; reason: UnresolvedSourceReason; locationCount?: number }
  | { kind: "up-to-date" }
  | { kind: "target"; reason: GenTargetReason; sections: AssetSourceSections; sourceContentSha256: string };

/**
 * 자산 하나의 생성 상태를 판정한다. **파일시스템을 읽지만 아무것도 쓰지 않는다.**
 *
 * 위생 실패만 자산 단위로 가둔다. 그 밖의 예외는 그대로 올린다 — 여기서 넓게 잡으면 진짜
 * 결함이 "건너뛴 자산 1건"으로 조용히 묻힌다. 포획은 `FileHygieneError` **한 계층**으로
 * 좁힌다. ENOENT는 `readAssetSourceFileSafely` 안에서 `AssetSourceMissingError`로 분류되므로
 * 여기서 errno를 다시 볼 필요가 없다 — errno로 잡으면 설정 디렉터리 읽기 실패 같은 진짜
 * 결함까지 묻힌다(심사 L-c).
 */
function judgeAsset(
  home: HomeContext,
  asset: Asset,
  indexEntry: CatalogIndexEntry | undefined,
  retryPolicyBlocked?: boolean,
): AssetVerdict {
  let resolved: ResolvedAssetSource;
  try {
    resolved = resolveAssetSource(home, asset);
  } catch (err) {
    if (!(err instanceof FileHygieneError)) throw err;
    // ⚠️ 경로를 싣지 않는다. 이 값은 `gen_estimate`의 **200 성공 본문**과 자산 상세 조회로
    // 브라우저까지 나가는데(심사 M1), 홈 밖 프로젝트 스킬이면 홈 상대화로도 가려지지 않아
    // 디렉터리 구조가 그대로 노출된다(심사 L-b). 위생 에러는 메시지에 경로를 넣지 않고,
    // 여기서는 그것이 지켜졌는지 마지막으로 한 번 더 훑는다(새 에러 타입이 어겨도 새지 않게).
    return { kind: "blocked", failureClass: err.failureClass, reason: scrubPaths(err.message) };
  }
  if (!resolved.resolved) {
    return resolved.reason === "ambiguous_source"
      ? { kind: "unresolved", reason: resolved.reason, locationCount: resolved.locationCount }
      : { kind: "unresolved", reason: resolved.reason };
  }

  const sourceContentSha256 = hashSections(resolved.sections);
  // 원문이 정책에 걸려 차단된 자산. **한 곳에서 판정한다** — 갈라 두면 `--retry-blocked`가
  // 아래 해시 비교로 흘러 "최신"이 되고, 탈출구가 아무것도 하지 않는다(테스트가 잡았다).
  if (indexEntry?.gen_state === "policy_blocked") {
    if (retryPolicyBlocked === true) {
      // 강제 재시도 — 해시가 같아도 대상이다. 문서는 애초에 쓰이지 않았다.
      return { kind: "target", reason: "stale", sections: resolved.sections, sourceContentSha256 };
    }
    if (indexEntry.gen_content_sha256 === sourceContentSha256) {
      return {
        kind: "blocked",
        failureClass: "injection_pattern_detected",
        reason:
          "원문이 인젝션 후검증 규칙에 걸린다(대개 README가 파괴적 명령을 문서화한 경우다). " +
          "원문이 바뀌면 자동으로 다시 시도한다. 지금 강제하려면 --retry-blocked를 준다",
      };
    }
    // 원문이 바뀌었다 — 아래 `changed` 경로로 흘러 자동으로 다시 시도한다(자기 치유).
  }
  if (indexEntry?.gen_state === "stale") {
    return { kind: "target", reason: "stale", sections: resolved.sections, sourceContentSha256 };
  }
  if (indexEntry?.gen_content_sha256 === undefined) {
    return { kind: "target", reason: "new", sections: resolved.sections, sourceContentSha256 };
  }
  if (indexEntry.gen_content_sha256 !== sourceContentSha256) {
    return { kind: "target", reason: "changed", sections: resolved.sections, sourceContentSha256 };
  }
  return { kind: "up-to-date" };
}

/**
 * **자산 하나**의 문서 상태를 조회용으로 판정한다(콘솔 자산 상세).
 *
 * 일괄 산출(`planGenTargets`)과 **같은 `judgeAsset`을 탄다** — 화면이 말하는 사유와 `gen`이
 * 실제로 할 일이 갈리지 않게 하는 유일한 방법이다. 전체를 계산하지 않으므로 비용은 그 자산의
 * 원본을 한 번 읽는 것뿐이다(전 자산 일괄 계산은 개발 로컬 실측 약 0.8초였다).
 *
 * 결과는 **어디에도 저장하지 않는다.** `source_missing`·`blocked`는 이 머신의 파일 배치에
 * 대한 사실이라 머신 독립 카탈로그에 넣으면 스키마의 축을 섞는다(core/view/asset-doc-state.ts).
 */
export function classifyAssetDocState(
  home: HomeContext,
  asset: Asset,
  indexEntry: CatalogIndexEntry | undefined,
): AssetDocState {
  const verdict = judgeAsset(home, asset, indexEntry);
  switch (verdict.kind) {
    case "blocked":
      return { kind: "blocked", failure_class: verdict.failureClass, reason: verdict.reason };
    case "unresolved":
      switch (verdict.reason) {
        case "source_missing":
          return { kind: "source_missing" };
        case "no_local_source":
          return { kind: "no_local_source" };
        case "ambiguous_source":
          return { kind: "ambiguous_source", location_count: verdict.locationCount ?? 0 };
      }
      break;
    case "up-to-date":
      return { kind: "generated" };
    case "target":
      return { kind: "pending_generation", trigger: verdict.reason };
  }
}

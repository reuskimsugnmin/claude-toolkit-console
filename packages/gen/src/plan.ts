import { createHash } from "node:crypto";
import type { Asset } from "@ctk/core";
import type { HomeContext } from "@ctk/probe";
import type { CatalogIndex } from "@ctk/sync";
import { FileHygieneError } from "./file-hygiene.js";
import { resolveAssetSource, type ResolvedAssetSource } from "./source-resolve.js";

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
  sections: ResolvedAssetSource["sections"];
  sourceContentSha256: string;
}

/** 파일 위생(H2)에 걸려 원문을 읽지 않은 자산 — 건너뛴 **사실과 이유**를 함께 남긴다. */
export interface GenSkippedAsset {
  assetId: string;
  failureClass: string;
  reason: string;
}

export interface GenPlanResult {
  targets: GenPlanTarget[];
  /** 원문도 asset.description도 없어 아예 채울 수 없는 자산 — gen이 건드리지 않는다. */
  emptyAssetIds: string[];
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
}

/**
 * 메시지에 절대경로가 섞이지 않았는지 마지막으로 훑는다 — 위생 에러는 애초에 경로를 넣지
 * 않지만(file-hygiene.ts), 새 에러 타입이 그 규약을 어겨도 브라우저까지 나가지 않게 한다.
 * 홈 상대화가 아니라 **제거**다: 홈 밖 프로젝트 경로는 상대화로 가려지지 않는다(심사 L-b).
 */
function scrubPaths(message: string): string {
  return message.replace(/(?:^|\s)(\/[^\s:]+)/g, " <경로 생략>");
}

function hashSections(sections: ResolvedAssetSource["sections"]): string {
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
}

export function planGenTargets(options: PlanGenTargetsOptions): GenPlanResult {
  const { home, assets, index, maxAssets } = options;
  const indexById = new Map(index.assets.map((e) => [e.id, e]));

  const targets: GenPlanTarget[] = [];
  const emptyAssetIds: string[] = [];
  const skipped: GenSkippedAsset[] = [];
  let upToDateCount = 0;

  for (const asset of assets) {
    if (maxAssets !== undefined && targets.length >= maxAssets) break;

    let resolved: ResolvedAssetSource;
    try {
      resolved = resolveAssetSource(home, asset);
    } catch (err) {
      // 위생 실패만 자산 단위로 가둔다. 그 밖의 예외는 그대로 올린다 — 여기서 넓게 잡으면
      // 진짜 결함이 "건너뛴 자산 1건"으로 조용히 묻힌다.
      // 포획은 `FileHygieneError` **한 계층**으로 좁힌다. ENOENT는 `readAssetSourceFileSafely`
      // 안에서 `AssetSourceMissingError`로 분류되므로 여기서 errno를 다시 볼 필요가 없다 —
      // errno로 잡으면 설정 디렉터리 읽기 실패 같은 진짜 결함까지 묻힌다(심사 L-c).
      if (!(err instanceof FileHygieneError)) throw err;
      // ⚠️ 경로를 싣지 않는다. 이 배열은 `gen_estimate`의 **200 성공 본문**으로 브라우저까지
      // 나가는데(심사 M1), 홈 밖 프로젝트 스킬이면 홈 상대화로도 가려지지 않아 디렉터리
      // 구조가 그대로 노출된다(심사 L-b). 위생 에러는 메시지에 경로를 넣지 않고, 여기서는
      // 그것이 지켜졌는지 마지막으로 한 번 더 훑는다(새 에러 타입이 어겨도 새지 않게).
      skipped.push({ assetId: asset.id, failureClass: err.failureClass, reason: scrubPaths(err.message) });
      continue;
    }
    if (resolved.empty) {
      emptyAssetIds.push(asset.id);
      continue;
    }

    const sourceContentSha256 = hashSections(resolved.sections);
    const indexEntry = indexById.get(asset.id);

    if (indexEntry?.gen_state === "stale") {
      targets.push({ asset, reason: "stale", sections: resolved.sections, sourceContentSha256 });
      continue;
    }
    if (indexEntry?.gen_content_sha256 === undefined) {
      targets.push({ asset, reason: "new", sections: resolved.sections, sourceContentSha256 });
      continue;
    }
    if (indexEntry.gen_content_sha256 !== sourceContentSha256) {
      targets.push({ asset, reason: "changed", sections: resolved.sections, sourceContentSha256 });
      continue;
    }
    upToDateCount++;
  }

  return { targets, emptyAssetIds, skipped, upToDateCount };
}

import type { Occupancy } from "../schema/occupancy.js";
import type { UsageMetric } from "../schema/usage.js";

/**
 * core/src/usage/rank.ts — `ctk usage --unused-expensive N`의 순위 계산(AC-4.6). 순수 함수 —
 * 카탈로그를 이미 읽은 호출자(cli)가 UsageMetric·Occupancy 배열을 넘긴다.
 *
 * **순위 기준은 idle 점유(§1.3 결정 5 "AC-4의 '비싼 툴' 순위는 idle 기준")다.** measured가 아닌
 * idle(unmeasured/approx_bytes)은 숫자 비교에 넣을 수 없으므로 **순위에서 분리**한다(R8 — 추정치가
 * 채워져 순위가 뒤집히는 것을 막는다). "안 쓰는데 비싼" 판정은 idle 토큰 내림차순 1차, 동률이면
 * call_count 오름차순(안 쓸수록 위로) 2차로 정렬한다.
 */
export interface UnusedExpensiveRow {
  asset_id: string;
  call_count: number;
  last_used_at: string | null;
  idle_tokens: number;
  token_sum: number;
  attribution_source: UsageMetric["attribution_source"] | null;
  attribution_rule: string | null;
}

export interface RankUnusedExpensiveOptions {
  usage: readonly UsageMetric[];
  occupancy: readonly Occupancy[];
  limit: number;
}

/** measured 상태의 idle 값이 있는 자산만 순위에 넣는다 — unmeasured/approx_bytes는 별도로 노출한다. */
export function rankUnusedExpensive(options: RankUnusedExpensiveOptions): {
  ranked: UnusedExpensiveRow[];
  excludedUnmeasuredAssetIds: string[];
} {
  const usageByAsset = new Map<string, UsageMetric>();
  for (const u of options.usage) {
    // 같은 asset_id가 여러 프로젝트에 걸쳐 여러 UsageMetric으로 나뉠 수 있다(project_path_hash별) —
    // 여기서는 자산 하나당 합산 1건으로 접는다(순위표는 자산 단위이므로).
    const existing = usageByAsset.get(u.asset_id);
    if (existing === undefined) {
      usageByAsset.set(u.asset_id, u);
    } else {
      usageByAsset.set(u.asset_id, {
        ...existing,
        call_count: existing.call_count + u.call_count,
        token_sum: existing.token_sum + u.token_sum,
        last_used_at:
          existing.last_used_at === null || (u.last_used_at !== null && u.last_used_at > existing.last_used_at)
            ? u.last_used_at
            : existing.last_used_at,
      });
    }
  }

  const ranked: UnusedExpensiveRow[] = [];
  const excludedUnmeasuredAssetIds: string[] = [];

  for (const occ of options.occupancy) {
    if (occ.idle.state !== "measured") {
      excludedUnmeasuredAssetIds.push(occ.asset_id);
      continue;
    }
    const usage = usageByAsset.get(occ.asset_id);
    ranked.push({
      asset_id: occ.asset_id,
      call_count: usage?.call_count ?? 0,
      last_used_at: usage?.last_used_at ?? null,
      idle_tokens: occ.idle.value_tokens,
      token_sum: usage?.token_sum ?? 0,
      attribution_source: usage?.attribution_source ?? null,
      attribution_rule: usage?.attribution_rule ?? null,
    });
  }

  ranked.sort((a, b) => {
    if (b.idle_tokens !== a.idle_tokens) return b.idle_tokens - a.idle_tokens;
    return a.call_count - b.call_count;
  });

  return { ranked: ranked.slice(0, options.limit), excludedUnmeasuredAssetIds };
}

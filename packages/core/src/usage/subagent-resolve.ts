import type { Asset } from "../schema/asset.js";

/**
 * core/src/usage/subagent-resolve.ts — B4-b. 트랜스크립트의 `subagent_type` 문자열을
 * **카탈로그의 번들 에이전트 자산 id**로 되돌린다.
 *
 * ## 왜 필요한가 — 두 네임스페이스가 조인되지 않고 있었다
 *
 * `measure`는 `asset_id`에 트랜스크립트가 준 **맨 `subagent_type` 문자열**을 그대로 넣었다.
 * 그런데 카탈로그의 번들 에이전트 id는 `<플러그인이름>@<마켓플레이스>:agent:<이름>`(B1 D2)이다 —
 * **두 값은 형태가 달라 절대 일치하지 않는다.** 그래서 에이전트 사용량 행은 어떤 자산과도
 * 조인되지 않았고, `SubagentAttributionSchema`의 `"resolved"` 값은 **한 번도 생산된 적이 없다**
 * (`usage/attribution.ts`의 주석이 경고한 "이름이 같을 뿐 다른 네임스페이스다"가 그대로 남아 있었다).
 * B1이 번들 에이전트를 Asset으로 편입하면서 비로소 이을 대상이 생겼다.
 *
 * ## 실측 — `subagent_type`은 두 형태뿐이다 (2026-08-28, 이 머신 810개 트랜스크립트 · 329건)
 *
 * | 형태 | 건수 | 비율 |
 * |---|---|---|
 * | `bare_name`(콜론 0) | 213 | 64.7% |
 * | `plugin_qualified`(콜론 1 · 2세그먼트) | 116 | 35.3% |
 * | 콜론 2개 이상 | **0** | — |
 *
 * `Skill` 도구 입력(`classifySkillInput` — plugin_qualified 22 / bare_name 15)과 **같은 축**이다.
 * 관측 방법과 파급은 `docs/harness-facts.md`에 있다.
 *
 * ## 판정 규칙 — 추측하지 않는다
 *
 * **후보가 정확히 하나일 때만 `resolved`다.** 0건이면 `no_match`, 2건 이상이면 `ambiguous`이고
 * 둘 다 `unresolved`로 남는다 — **어느 쪽이 진짜인지 이 함수는 고르지 않는다**(H-1·H6과 같은 태도).
 *
 * ⚠️ **`plugin_qualified`의 앞 세그먼트는 플러그인 *이름*이지 id가 아니다.** 자산 id는
 * `<이름>@<마켓플레이스>`이므로 같은 이름의 플러그인이 두 마켓플레이스에 설치돼 있으면 후보가
 * 둘이 된다. **이름 유일성은 미측정 전제이므로 코드가 그것에 기대지 않는다** — 과거 id 유일성이
 * "플러그인 이름에 `:`가 없다"는 미측정 전제에 매달려 있던 사례와 같은 함정이다(CLAUDE.md).
 */

/** `subagent_type` 값의 형태. `classifySkillInput`과 같은 축·같은 이름을 쓴다. */
export type SubagentRefForm = "plugin_qualified" | "bare_name";

export function classifySubagentRef(ref: string): SubagentRefForm {
  return ref.includes(":") ? "plugin_qualified" : "bare_name";
}

export type SubagentResolution =
  /** 후보가 정확히 하나 — 그 자산 id로 잇는다. */
  | { resolved: true; assetId: string }
  /**
   * 잇지 못했다. **사유를 남긴다** — "카탈로그에 없다"(대개 하네스 내장 에이전트이거나 아직
   * 스캔되지 않은 플러그인)와 "여럿이라 못 고른다"는 사용자가 할 일이 다르다(안전 원칙 7).
   */
  | { resolved: false; reason: "no_match" | "ambiguous" };

/**
 * 번들 에이전트 자산으로 좁힌 조회 색인. **`measure`가 자산당 전수 순회하지 않도록** 미리 만든다
 * (자산 수백 × 호출 수백이면 O(N²)다 — B1에서 같은 형태를 이미 한 번 겪었다).
 */
export interface BundledAgentIndex {
  /** `<플러그인이름>` → 그 플러그인의 `<에이전트이름>` → 자산 id 목록(동명이 여럿일 수 있다). */
  byPluginAndName: Map<string, Map<string, string[]>>;
  /** `<에이전트이름>` → 자산 id 목록. `bare_name` 형태를 위한 색인이다. */
  byName: Map<string, string[]>;
}

/**
 * 플러그인 자산 id(`<이름>@<마켓플레이스>`)에서 이름 부분만 꺼낸다.
 *
 * ⚠️ **`@`로 자를 때 마지막 `@`를 기준으로 한다.** 마켓플레이스 이름에는 `@`가 없다는 보장이
 * 있어도, 플러그인 이름 쪽에 있을 가능성은 **미측정**이다 — 앞에서 자르면 이름이 잘린다.
 * `@`가 아예 없으면 전체를 이름으로 본다(형태가 다르면 매칭이 안 될 뿐 잘못 매칭되지는 않는다).
 */
export function pluginNameFromId(pluginAssetId: string): string {
  const at = pluginAssetId.lastIndexOf("@");
  return at === -1 ? pluginAssetId : pluginAssetId.slice(0, at);
}

/**
 * 자산 목록에서 번들 에이전트만 골라 색인을 만든다. **`kind === "agent"`만 본다** — B1의
 * `kindConstraint`가 agent에 `parent_asset_id`를 항상 강제하므로 부모 없는 agent는 존재할 수 없고,
 * 그래도 방어적으로 확인한다(스키마를 믿되 여기서 조용히 `undefined`를 키로 쓰지 않는다).
 */
export function buildBundledAgentIndex(assets: readonly Asset[]): BundledAgentIndex {
  const byPluginAndName = new Map<string, Map<string, string[]>>();
  const byName = new Map<string, string[]>();
  for (const asset of assets) {
    if (asset.kind !== "agent") continue;
    const parentId = asset.parent_asset_id;
    if (parentId === undefined) continue;
    const pluginName = pluginNameFromId(parentId);

    let perPlugin = byPluginAndName.get(pluginName);
    if (perPlugin === undefined) {
      perPlugin = new Map();
      byPluginAndName.set(pluginName, perPlugin);
    }
    perPlugin.set(asset.name, [...(perPlugin.get(asset.name) ?? []), asset.id]);
    byName.set(asset.name, [...(byName.get(asset.name) ?? []), asset.id]);
  }
  return { byPluginAndName, byName };
}

/**
 * `subagent_type` 하나를 자산 id로 되돌린다. **순수 함수** — I/O도 상태도 없다.
 *
 * - `plugin_qualified`(`<플러그인이름>:<에이전트이름>`) — 그 플러그인 안에서만 찾는다.
 *   **전역으로 넓히지 않는다**: 자칭 플러그인 이름이 틀렸을 때 엉뚱한 플러그인의 동명 에이전트에
 *   붙으면 사용량이 다른 자산에 귀속된다.
 * - `bare_name` — 이름만으로 전 플러그인을 훑는다. 실측 64.7%가 이 형태이고 대부분은 하네스
 *   내장 에이전트라 후보 0건(`no_match`)으로 남는다 — **그것이 정상이고 결함이 아니다.**
 */
export function resolveSubagentRef(ref: string, index: BundledAgentIndex): SubagentResolution {
  const candidates = pickCandidates(ref, index);
  if (candidates.length === 0) return { resolved: false, reason: "no_match" };
  if (candidates.length > 1) return { resolved: false, reason: "ambiguous" };
  // 위 두 분기가 0건·2건 이상을 모두 걷어냈으므로 여기 도달하면 원소가 정확히 하나다.
  return { resolved: true, assetId: candidates[0] as string };
}

function pickCandidates(ref: string, index: BundledAgentIndex): readonly string[] {
  if (classifySubagentRef(ref) === "bare_name") {
    return index.byName.get(ref) ?? [];
  }
  // ⚠️ 실측상 콜론은 최대 1개지만 **그 전제에 기대지 않는다.** 첫 콜론에서만 가르면 콜론이 둘인
  // 값이 들어올 때 뒷부분이 통째로 에이전트 이름이 되어 조용히 매칭에 실패한다 — 그건 "없음"이
  // 아니라 "형태가 예상 밖"이다. 세그먼트가 정확히 둘일 때만 취급한다.
  const parts = ref.split(":");
  if (parts.length !== 2) return [];
  const [pluginName, agentName] = parts;
  if (pluginName === undefined || agentName === undefined) return [];
  if (pluginName.length === 0 || agentName.length === 0) return [];
  return index.byPluginAndName.get(pluginName)?.get(agentName) ?? [];
}

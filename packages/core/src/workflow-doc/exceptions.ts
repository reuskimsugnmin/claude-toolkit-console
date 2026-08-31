import type { AssetKind } from "../schema/asset.js";
import type { AssetRef } from "./table-locate.js";

/**
 * 문서 표기 → 카탈로그 조회 키의 **예외** (B4-c · D-5).
 *
 * 문서는 **하네스 스폰 식별자**(디렉터리 이름 + 스폰 표면)를 쓰고 카탈로그는 **자칭 frontmatter
 * `name`**과 **디스크 배치 기반 `kind`**를 쓴다. 두 축이 어긋나는 자리가 오늘 **정확히 2건**이다.
 *
 * ⚠️ **이 맵은 동명 충돌(§2.1의 5건)을 해소하지 못한다** — 치역이 바로 그 모호한 축이다.
 * 해소는 3튜플 색인이 하고, 여기는 **표기 차이**만 다룬다. 둘을 섞지 않는다.
 *
 * ⚠️ **맵이 자라면 맵을 키우지 말고 축을 만든다.** 4건을 넘으면 `(kind,name)` 매칭이 구조적으로
 * 부족하다는 뜻이고, 그때 필요한 것은 예외 항목이 아니라 **자산에 붙는 명시적 식별 축**
 * (`Tag`/alias = 갈래 (a))이다. ROADMAP §10 신호 1이 그것이다.
 */

export interface DocRefException {
  /** 문서 표기 — `Skill(plugin:name)`의 세 조각. */
  readonly from: { readonly kindLabel: "Skill" | "Agent"; readonly plugin: string; readonly name: string };
  /** 카탈로그 조회 키. */
  readonly to: { readonly kind: AssetKind; readonly pluginName: string; readonly name: string };
  readonly note: string;
}

export const DOC_REF_EXCEPTIONS: readonly DocRefException[] = [
  {
    from: { kindLabel: "Skill", plugin: "oh-my-claudecode", name: "plan" },
    to: { kind: "skill", pluginName: "oh-my-claudecode", name: "omc-plan" },
    note: "디스크는 `skills/plan/SKILL.md`인데 frontmatter가 `name: omc-plan`이다 — 카탈로그는 자칭 name을 쓴다",
  },
  {
    from: { kindLabel: "Skill", plugin: "claude-md-management", name: "revise-claude-md" },
    to: { kind: "command", pluginName: "claude-md-management", name: "revise-claude-md" },
    note: "문서는 Skill로 적지만 디스크는 `commands/*.md`라 카탈로그 kind가 command다",
  },
];

/** 문서 표기의 기본 매핑 — `Skill` → `skill`, `Agent` → `agent`. */
function defaultKind(kindLabel: "Skill" | "Agent"): AssetKind {
  return kindLabel === "Skill" ? "skill" : "agent";
}

export interface LookupKey {
  readonly kind: AssetKind;
  readonly pluginName: string;
  readonly name: string;
}

/** 자산 참조를 조회 키로 바꾼다 — 예외가 있으면 예외를, 없으면 기본 매핑을 쓴다. */
export function lookupKeyFor(ref: AssetRef): { key: LookupKey; exception: DocRefException | null } {
  const hit = DOC_REF_EXCEPTIONS.find(
    (e) => e.from.kindLabel === ref.kindLabel && e.from.plugin === ref.plugin && e.from.name === ref.name,
  );
  if (hit !== undefined) return { key: hit.to, exception: hit };
  return {
    key: { kind: defaultKind(ref.kindLabel), pluginName: ref.plugin, name: ref.name },
    exception: null,
  };
}

/**
 * **맵이 조용히 썩지 않게 한다 — 미사용은 에러다**(경고가 아니다).
 *
 * 상류(문서 표기나 상류 플러그인의 frontmatter)가 바뀌어 예외가 필요 없어지면 예외도 사라져야
 * 한다. 경고로만 내면 아무것도 막지 않으므로 **신호가 아니다** — 이 저장소가 반복해 배운 것이다.
 *
 * @returns 주어진 참조 목록에서 한 번도 쓰이지 않은 예외 항목.
 */
export function findUnusedDocRefExceptions(refs: readonly AssetRef[]): DocRefException[] {
  return DOC_REF_EXCEPTIONS.filter(
    (e) =>
      !refs.some(
        (ref) => e.from.kindLabel === ref.kindLabel && e.from.plugin === ref.plugin && e.from.name === ref.name,
      ),
  );
}

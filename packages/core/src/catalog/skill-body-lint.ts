import { AssetKindSchema } from "../schema/asset.js";

/**
 * core/src/catalog/skill-body-lint.ts — AC-3.2 판정기.
 *
 * `toolkit-search` 스킬 본문은 **카탈로그 경로 규약과 `index.json` 스키마만** 안내해야 하고
 * 자산 목록을 하드코딩해서는 안 된다. 이유는 두 가지다:
 *
 * 1. **본문은 상시 컨텍스트가 아니지만 갱신 주체가 없다.** 자산 이름이 본문에 박히면 그 이름이
 *    사라지거나 바뀌어도 스킬은 그대로 남아, 에이전트를 없는 경로로 보낸다. 카탈로그는 `ctk scan`이
 *    갱신하지만 스킬 본문을 갱신하는 것은 사람뿐이다.
 * 2. **스킬은 저장소에 커밋되고 이 저장소는 public이다**(CLAUDE.md 저장소 경계). 실제 설치된 툴
 *    목록은 개인 환경 데이터이므로 본문에 들어가면 위생 규칙 위반이기도 하다.
 *
 * ⚠️ **두 규칙의 판정 가능성이 다르고, 그 차이를 결과 타입에 새긴다**(안전 원칙 7 — "없음"과
 * "실패"를 구분한다). `concrete_asset_path`는 본문만 보면 판정되지만, `asset_name_literal`은
 * **비교 대상 이름 목록이 있어야만** 판정된다. 목록 없이 호출하면 "위반 0건"이 아니라
 * `unchecked`를 반환한다 — 미실행을 "0건 일치"로 삼키면 이 lint는 통과하는 동안 아무것도
 * 막지 않는다(CI가 5회 전부 Setup Node에서 죽는 동안 게이트가 통과로 보였던 것과 같은 형태다).
 *
 * 순수 함수다 — 파일을 읽지 않고 본문 문자열과 이름 목록을 인자로 받는다(core 계층 규약).
 */

export type SkillBodyViolationRule = "concrete_asset_path" | "asset_name_literal";

export interface SkillBodyViolation {
  rule: SkillBodyViolationRule;
  /** 1-indexed 본문 라인 번호 — 지적을 원문 위치로 되짚을 수 있어야 한다(안전 원칙 5). */
  line: number;
  /** 위반으로 판정된 문자열 그대로. */
  match: string;
  note: string;
}

/**
 * 이름 자리에 놓여도 "구체 자산"이 아닌 것들 — 플레이스홀더 표기. 이 셋 중 하나로 시작하면
 * 예시가 아니라 경로 **규약**을 적은 것이다.
 */
function isPlaceholderSegment(segment: string): boolean {
  return (
    segment.startsWith("<") || segment.startsWith("{") || segment.startsWith("*") || segment.startsWith("…") || segment === "..."
  );
}

const ASSET_KINDS: readonly string[] = AssetKindSchema.options;

/**
 * `catalog/assets/<kind>/<name>` 형태에서 `<kind>`·`<name>`이 플레이스홀더인지 본다.
 * `kind`는 스키마가 고정한 4개 열거값이므로 구체값이어도 자산 목록의 하드코딩이 아니다 —
 * 하드코딩이 되는 것은 `name` 자리뿐이다.
 */
const ASSET_PATH_PATTERN = /catalog\/assets\/([^/\s`)\]]+)\/([^/\s`)\]]+)/g;

export interface SkillBodyLintOptions {
  /**
   * 카탈로그에 실재하는 자산 이름들. `undefined`면 `asset_name_literal` 규칙은 실행되지 않고
   * `nameCheck.state === "unchecked"`가 된다 — 통과가 아니라 미실행이다.
   */
  knownAssetNames?: readonly string[] | undefined;
}

export type SkillBodyNameCheck =
  | { state: "checked"; namesCompared: number }
  | { state: "unchecked"; reason: "no_asset_names_provided" };

export interface SkillBodyLintResult {
  violations: SkillBodyViolation[];
  nameCheck: SkillBodyNameCheck;
}

/**
 * 이름 목록과 대조할 때 너무 짧거나 흔한 토큰은 오탐을 만든다(예: 이름이 `web`인 자산이 있으면
 * 본문의 "웹"과 무관한 영문 `web`까지 걸린다). 3자 미만은 대조하지 않고, 그 사실은 반환값의
 * `namesCompared`로 드러난다 — 조용히 건너뛰지 않는다.
 */
const MIN_COMPARABLE_NAME_LENGTH = 3;

export function lintSkillBody(body: string, options: SkillBodyLintOptions = {}): SkillBodyLintResult {
  const violations: SkillBodyViolation[] = [];
  const lines = body.split("\n");

  lines.forEach((lineText, index) => {
    for (const match of lineText.matchAll(ASSET_PATH_PATTERN)) {
      const [whole, kindSegment = "", nameSegment = ""] = match;
      const kindOk = isPlaceholderSegment(kindSegment) || ASSET_KINDS.includes(kindSegment);
      if (!kindOk) {
        violations.push({
          rule: "concrete_asset_path",
          line: index + 1,
          match: whole,
          note: `kind 자리가 스키마 열거값(${ASSET_KINDS.join("|")})도 플레이스홀더도 아니다: ${kindSegment}`,
        });
        continue;
      }
      if (!isPlaceholderSegment(nameSegment)) {
        violations.push({
          rule: "concrete_asset_path",
          line: index + 1,
          match: whole,
          note: `자산 이름을 구체값으로 적었다(경로 규약은 <name> 같은 플레이스홀더로 쓴다): ${nameSegment}`,
        });
      }
    }
  });

  const knownNames = options.knownAssetNames;
  if (knownNames === undefined) {
    return { violations, nameCheck: { state: "unchecked", reason: "no_asset_names_provided" } };
  }

  const comparable = knownNames.filter((name) => name.length >= MIN_COMPARABLE_NAME_LENGTH);
  lines.forEach((lineText, index) => {
    for (const name of comparable) {
      if (lineText.includes(name)) {
        violations.push({
          rule: "asset_name_literal",
          line: index + 1,
          match: name,
          note: "카탈로그에 실재하는 자산 이름이 본문에 등장한다 — 스킬 본문은 자산 목록을 담지 않는다",
        });
      }
    }
  });

  return { violations, nameCheck: { state: "checked", namesCompared: comparable.length } };
}

/**
 * 스킬 문서를 frontmatter(키:값)와 **본문**으로 가른다.
 *
 * ⚠️ **AC-3.2의 대상은 본문뿐이다.** frontmatter의 `name`은 이 스킬 자신의 이름이고, 스킬이
 * 로컬에 설치되면 그 이름이 곧 카탈로그의 자산 이름이 된다 — 본문과 frontmatter를 함께 검사하면
 * 스킬이 **자기 이름 때문에** `asset_name_literal` 위반이 되어 구조적으로 항상 실패한다
 * (안전 원칙 6 — 강제 범위가 지시 범위보다 넓으면 가드가 자기편을 막는다).
 *
 * 파서는 `gen/src/extract-frontmatter.ts`와 같은 최소 규약이다(키:값 한 줄, 중첩·리스트 없음).
 */
export function splitSkillDocument(content: string): { frontmatter: Record<string, string>; body: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string> = {};
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "---") {
      closingIndex = i;
      break;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (key.length > 0) frontmatter[key] = line.slice(separatorIndex + 1).trim();
  }

  // 닫는 `---`가 없으면 frontmatter가 열린 채 끝난 것이다 — 전체를 본문으로 보면 파싱한 키가
  // 검사 대상에서 빠지므로, 파싱 실패를 조용히 삼키지 않고 원문 전체를 본문으로 돌려준다.
  if (closingIndex === -1) return { frontmatter: {}, body: content };
  return { frontmatter, body: lines.slice(closingIndex + 1).join("\n") };
}

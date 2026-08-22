/**
 * core/src/catalog/probe-skill.ts — AC-3.3 진단용 스킬 사본을 만드는 **순수 변환**(안 B).
 *
 * ## 왜 사본이 필요한가
 *
 * 프로덕션 `toolkit-search`는 카탈로그 루트를 `~/.config/ctk/config.json`에서 읽는다. 그런데
 * `agent-probe`는 인증을 살리려고 `HOME`을 **실제 홈 그대로** 둔다(`CLAUDE_CONFIG_DIR`를
 * 설정하는 행위 자체가 OAuth를 깨므로 격리 홈을 쓸 수 없다 — `docs/harness-facts.md`).
 * 그래서 그대로 띄우면 에이전트가 합성 카탈로그가 아니라 **사용자의 실제 카탈로그**를 읽는다.
 * 측정이 재현되지 않고, 결과물에 개인 환경 데이터가 섞인다.
 *
 * ## ⚠️ 이 모듈이 지는 책임 — 무엇이 달라졌는지를 코드로 가둔다
 *
 * "시험 대상이 프로덕션과 다르면 검증이 다른 것을 검증한다"는 이 코드베이스가 반복해 데인
 * 함정이다. 그래서 사본은 **정확히 한 절**(`## 카탈로그 위치`)만 바꾸고, 나머지는 바이트
 * 동일해야 한다. 그 계약을 주석이 아니라 **반환값으로** 내놓는다 — 호출자와 테스트가
 * `untouchedSource`를 사본과 직접 대조할 수 있다.
 *
 * **frontmatter는 절대 건드리지 않는다.** `description`이 곧 에이전트가 이 스킬을 스스로
 * 발동하는 근거이고, AC-3.3이 재려는 것이 정확히 그 자율 발동이다. 여기가 바뀌면 측정 대상
 * 자체가 사라진다.
 */

/** 사본에서 바꿔치기할 절의 제목. **정확히 이 하나만** 바뀐다. */
export const PROBE_SKILL_REPLACED_HEADING = "## 카탈로그 위치";

/** 판정할 수 없는 입력을 조용히 통과시키지 않는다(안전 원칙 7). */
export class ProbeSkillSectionError extends Error {
  constructor(readonly heading: string, readonly found: number) {
    super(
      found === 0
        ? `스킬 원문에 \`${heading}\` 절이 없다 — 사본을 만들 수 없다. 스킬 본문이 개편됐다면 이 상수를 함께 고친다.`
        : `스킬 원문에 \`${heading}\` 절이 ${found}개 있다 — 어느 것을 바꿀지 판정할 수 없다.`,
    );
    this.name = "ProbeSkillSectionError";
  }
}

export interface MarkdownSection {
  /** `## `로 시작하는 절의 제목 줄. 문서 서두(frontmatter·H1)는 `null`이다. */
  heading: string | null;
  /** 제목 줄을 포함한 절 전문. 이어 붙이면 원문이 그대로 복원된다. */
  text: string;
}

/**
 * 문서를 `## ` 절 단위로 쪼갠다. **코드 펜스 안은 세지 않는다** — `index.json` 스키마 블록처럼
 * 펜스 안에 `## `가 들어오면 절 경계가 엉뚱한 곳에 생기고, 그러면 "한 절만 바꿨다"는 계약이
 * 조용히 깨진다. `###` 이상은 하위 제목이므로 경계로 보지 않는다.
 *
 * 이어 붙이면 원문이 **바이트 그대로** 복원된다(round-trip). 이 성질이 뒤의 대조를 지탱한다.
 */
export function splitMarkdownSections(document: string): MarkdownSection[] {
  const lines = document.split("\n");
  const sections: MarkdownSection[] = [];
  let currentHeading: string | null = null;
  let current: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (currentHeading === null && current.length === 0) return;
    sections.push({ heading: currentHeading, text: current.join("\n") });
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const isBoundary = !inFence && /^## (?!#)/.test(line);
    if (isBoundary) {
      flush();
      currentHeading = line;
      current = [line];
      continue;
    }
    current.push(line);
  }
  flush();
  return sections;
}

/** 지정한 절을 **뺀** 나머지를 원문 순서대로 이어 붙인다. 두 문서의 "나머지"를 대조하는 데 쓴다. */
export function withoutSection(document: string, heading: string): string {
  return splitMarkdownSections(document)
    .filter((section) => section.heading !== heading)
    .map((section) => section.text)
    .join("\n");
}

export interface ProbeSkillDocument {
  /** 시험용 스킬 전문. 이것을 임시 플러그인 디렉터리에 쓴다. */
  document: string;
  /** 바꿔치기한 절의 제목 — 하나뿐임을 호출자가 확인할 수 있다. */
  replacedHeading: string;
  /** **원문에서** 그 절을 뺀 나머지. 사본의 나머지와 바이트 동일해야 한다. */
  untouchedSource: string;
}

/**
 * 합성 카탈로그 루트를 박은 진단용 사본을 만든다.
 *
 * 대체 본문은 **루트를 알려주는 것 이상을 하지 않는다.** 검색 요령이나 어떤 자산을 보라는
 * 힌트를 넣으면 그 순간 "에이전트가 스스로 찾았다"가 아니라 "우리가 알려줬다"가 된다 —
 * AC-3.3이 재려는 것이 사라진다.
 */
export interface ProbeSkillTarget {
  /** 합성 카탈로그 루트(절대경로). */
  catalogRoot: string;
  /**
   * "이 로컬"로 삼을 머신 id. 프로덕션은 `~/.config/ctk/machine.json`에서 읽지만 진단은
   * `HOME`이 실제 홈이라 그 파일을 쓸 수 없다 — 카탈로그 루트와 **같은 절**에서 함께 준다.
   *
   * 3회차 실측에서 에이전트가 정확히 지적한 공백이다: 머신을 특정하지 못하면 "이 로컬에
   * 있다"가 아니라 "어떤 머신엔가 있었다"밖에 말할 수 없다.
   */
  machineId: string;
}

export function buildProbeSkillDocument(originalDocument: string, target: ProbeSkillTarget): ProbeSkillDocument {
  const sections = splitMarkdownSections(originalDocument);
  const matches = sections.filter((section) => section.heading === PROBE_SKILL_REPLACED_HEADING);
  if (matches.length !== 1) throw new ProbeSkillSectionError(PROBE_SKILL_REPLACED_HEADING, matches.length);

  // 원문 절의 후행 빈 줄 수를 그대로 물려받는다 — 안 그러면 절 사이 간격이 달라져 "나머지는
  // 동일하다"는 대조가 무의미한 차이로 흔들린다.
  const original = matches[0]?.text ?? "";
  const trailingBlankLines = /(\n*)$/.exec(original)?.[1] ?? "";

  const replacement =
    `${PROBE_SKILL_REPLACED_HEADING}\n\n` +
    `⚠️ 이 스킬은 **AC-3.3 진단용 사본**이다. 프로덕션 원문은 카탈로그 루트와 이 로컬의 머신\n` +
    `id를 \`~/.config/ctk/\`의 두 파일에서 읽지만, 이 진단은 합성 카탈로그를 대상으로 하므로 두\n` +
    `값이 아래에 고정돼 있다. **이 절 외의 본문은 프로덕션 원문과 바이트 동일하다.**\n\n` +
    "```\n" +
    `catalog_path  =  ${target.catalogRoot}\n` +
    `machine_id    =  ${target.machineId}\n` +
    "```" +
    trailingBlankLines;

  const document = sections
    .map((section) => (section.heading === PROBE_SKILL_REPLACED_HEADING ? replacement : section.text))
    .join("\n");

  return {
    document,
    replacedHeading: PROBE_SKILL_REPLACED_HEADING,
    untouchedSource: withoutSection(originalDocument, PROBE_SKILL_REPLACED_HEADING),
  };
}

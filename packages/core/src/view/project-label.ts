/**
 * core/src/view/project-label.ts — 이관 대상 프로젝트를 **사람이 고를 수 있게** 표시하기 위한
 * 라벨 산출. 순수 함수다.
 *
 * ## 왜 마지막 세그먼트만인가 (OQ — 사용자 결정 "안 B", 2026-08-22)
 *
 * `ctk move`는 대상 프로젝트를 **인덱스**로 받는다(자유 문자열 경로를 웹에서 받지 않는 것이
 * 의도한 설계다 — 웹에서 온 문자열이 파일시스템에 닿으면 경로 순회가 재현된다). 그런데
 * 사용자가 "3번"을 고르려면 그게 어느 프로젝트인지 알아야 한다.
 *
 * 세 규칙이 실제로 금지하는 것은 **카탈로그에 커밋되는 경로**(AC-1.7)와 **경로 구조**(보안
 * 심사 M1: `Clients/Acme-secret/...` 같은 디렉터리 계층)이다. 마지막 세그먼트 하나는 둘 다
 * 아니다 — 홈 경로도, 사용자명도, 상위 구조도 담지 않는다.
 *
 * ⚠️ **자르는 일을 화면에 맡기지 않는다.** 경로 전체를 응답에 실어 보내고 UI에서 자르면 그
 * 순간 응답 본문에 구조가 들어가 있다 — 심사 M1이 지적한 것이 정확히 그 형태였다. 그래서
 * 이 함수가 **서버 쪽에서** 라벨을 만들고, 경로는 그 자리에서 버린다.
 *
 * ⚠️ **라벨은 카탈로그에 쓰지 않는다.** 뷰모델(로컬 응답) 전용이다. 스냅샷에 들어가는 값은
 * 여전히 `path_hash`뿐이다.
 */

/**
 * 화면이 실제로 비교하는 것은 **렌더된 글자**다. 바이트 동일성만 세면 시각적으로 똑같은 두
 * 선택지가 경고 없이 나란히 뜬다(재심 M4 실측) — NFC/NFD 두 표기, 후행 공백(브라우저가 접는다),
 * 양방향 제어문자(표시 순서를 뒤집는다). 세는 키는 정규화한 값으로 만든다.
 */
function displayKey(label: string): string {
  return label
    .normalize("NFC")
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .trim();
}

export interface ProjectChoice {
  /** `ctk move --project-index`가 받는 값. 서버가 읽은 목록에서의 위치 그대로다. */
  index: number;
  /** 화면에 보일 이름 — 경로의 마지막 세그먼트. */
  label: string;
  /**
   * 같은 라벨이 둘 이상일 때 `true`. 화면은 이때 인덱스·해시를 함께 보여 **오조작**을 막아야
   * 한다 — 실측(16건)에서 동명 충돌이 2종 있었고, 잘못 고르면 엉뚱한 프로젝트의 설정이 바뀐다.
   */
  ambiguous: boolean;
  /**
   * 충돌 시 구분용 짧은 해시. `normalizePath`의 `path_hash` 접두이므로 새 노출이 아니다.
   * 충돌 그룹 안에서 접두까지 겹치면 호출자가 더 길게 준다(아래 `buildProjectChoices` 참조).
   */
  hashPrefix: string;
  /**
   * 충돌한 선택지에만 붙는 **상위 한 칸**. 인덱스·해시는 "다르다"만 알려주고 "어느 쪽이
   * 내가 원하는 것인가"는 못 알려준다(재심 M4) — 사람이 읽을 수 있는 구별자가 하나는 있어야
   * 50% 확률로 찍지 않는다. 세그먼트 하나라 계층이 아니고 안 B의 근거를 깨지 않는다.
   */
  parentHint?: string;
}

/**
 * 경로에서 마지막 세그먼트만 뽑는다. 구분자는 POSIX·Windows 둘 다 받고, 후행 구분자는 무시한다.
 * 세그먼트를 뽑을 수 없으면(루트 등) 빈 문자열을 반환한다 — 호출자가 대체 표기를 정한다.
 */
export function toProjectLabel(absolutePath: string): string {
  const trimmed = absolutePath.replace(/[/\\]+$/, "");
  const lastSeparator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1);
}

export interface BuildProjectChoicesInput {
  /** 서버가 읽은 프로젝트 절대경로 목록. **순서가 곧 인덱스다.** */
  absolutePaths: readonly string[];
  /** 경로 → 해시. 호출자가 이미 쓰는 해시 함수를 주입한다(core는 crypto를 쓰지 않는다). */
  hashPrefixOf: (absolutePath: string) => string;
}

/** 기본 구별 길이. 충돌 그룹 안에서 겹치면 이 값을 넘겨 넓힌다. */
const DEFAULT_HASH_PREFIX_LENGTH = 6;
const WIDER_HASH_PREFIX_LENGTH = 10;

/**
 * 표시용 선택지를 만든다. **입력 순서를 바꾸지 않는다** — 인덱스가 곧 `move`의 인자이므로
 * 정렬하면 사용자가 고른 것과 서버가 쓰는 것이 어긋난다.
 */
export function buildProjectChoices(input: BuildProjectChoicesInput): ProjectChoice[] {
  const labels = input.absolutePaths.map((p) => toProjectLabel(p) || "(이름 없음)");
  const counts = new Map<string, number>();
  for (const label of labels) {
    const key = displayKey(label);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const base = labels.map((label, index) => {
    const absolutePath = input.absolutePaths[index] ?? "";
    const ambiguous = (counts.get(displayKey(label)) ?? 0) > 1;
    const choice: ProjectChoice = {
      index,
      label,
      ambiguous,
      hashPrefix: input.hashPrefixOf(absolutePath).slice(0, DEFAULT_HASH_PREFIX_LENGTH),
    };
    if (ambiguous) {
      const parent = toProjectLabel(absolutePath.replace(/[/\\][^/\\]*$/, ""));
      if (parent.length > 0) choice.parentHint = parent;
    }
    return choice;
  });

  // 충돌 그룹 안에서 해시 접두까지 겹치면 구별 수단이 조용히 사라진다(재심 L3) — 그 그룹만 넓힌다.
  const prefixCounts = new Map<string, number>();
  for (const c of base) {
    if (c.ambiguous) prefixCounts.set(c.hashPrefix, (prefixCounts.get(c.hashPrefix) ?? 0) + 1);
  }
  return base.map((c, index) =>
    c.ambiguous && (prefixCounts.get(c.hashPrefix) ?? 0) > 1
      ? { ...c, hashPrefix: input.hashPrefixOf(input.absolutePaths[index] ?? "").slice(0, WIDER_HASH_PREFIX_LENGTH) }
      : c,
  );
}

/**
 * 선택지에 절대경로가 섞이지 않았는지 단언한다 — 이 모듈의 계약을 **호출자 쪽에서도** 확인할
 * 수 있게 노출한다. 라벨이 `/`나 `\`를 포함하면 세그먼트가 아니라 경로 조각이라는 뜻이다.
 */
export function containsPathSeparator(choices: readonly ProjectChoice[]): boolean {
  const hasSeparator = (v: string | undefined): boolean =>
    v !== undefined && (v.includes("/") || v.includes("\\"));
  // `parentHint`도 세그먼트 하나여야 한다 — 검사 대상에서 빠지면 그 필드로 계층이 샌다.
  return choices.some((c) => hasSeparator(c.label) || hasSeparator(c.parentHint));
}

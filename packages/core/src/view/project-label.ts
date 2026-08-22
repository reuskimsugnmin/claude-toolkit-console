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
  /** 충돌 시 구분용 짧은 해시. 이미 스냅샷에 있는 값이라 새 노출이 아니다. */
  hashPrefix: string;
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
  /** 경로 → 짧은 해시. 호출자가 이미 쓰는 해시 함수를 주입한다(core는 crypto를 쓰지 않는다). */
  hashPrefixOf: (absolutePath: string) => string;
}

/**
 * 표시용 선택지를 만든다. **입력 순서를 바꾸지 않는다** — 인덱스가 곧 `move`의 인자이므로
 * 정렬하면 사용자가 고른 것과 서버가 쓰는 것이 어긋난다.
 */
export function buildProjectChoices(input: BuildProjectChoicesInput): ProjectChoice[] {
  const labels = input.absolutePaths.map((p) => toProjectLabel(p) || "(이름 없음)");
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);

  return labels.map((label, index) => ({
    index,
    label,
    ambiguous: (counts.get(label) ?? 0) > 1,
    hashPrefix: input.hashPrefixOf(input.absolutePaths[index] ?? ""),
  }));
}

/**
 * 선택지에 절대경로가 섞이지 않았는지 단언한다 — 이 모듈의 계약을 **호출자 쪽에서도** 확인할
 * 수 있게 노출한다. 라벨이 `/`나 `\`를 포함하면 세그먼트가 아니라 경로 조각이라는 뜻이다.
 */
export function containsPathSeparator(choices: readonly ProjectChoice[]): boolean {
  return choices.some((c) => c.label.includes("/") || c.label.includes("\\"));
}

import { findRawPathLeaks } from "../snapshot/path-normalize.js";

/**
 * `docs/` 위생 — 공개 저장소에 새면 안 되는 흔적을 축별로 찾는다 (B4-c Step 1 · D-7).
 *
 * ⚠️ **`assertNoRawPathLeaks`를 "마지막 방어선"이라 부르면 안 된다.** 그 함수의
 * `RAW_ABS_HOME_PATTERNS`는 **macOS·Linux 홈 절대경로 두 패턴뿐**이라 물결 홈 표기 ·
 * 마켓플레이스 자산 id · machine_id(UUID) · 스냅샷 파일명을 하나도 잡지 않는다.
 * (⚠️ 이 주석이 그 두 패턴을 **문자 그대로** 적으면 `scripts/hygiene-check.mjs`가 이 파일을
 * 위반으로 잡는다 — 실제로 잡혔다. 게이트가 살아 있다는 뜻이고, **파일 예외로 빼지 않는다.**)
 *
 * **이 모듈이 진단한 무방비가 정확히 그 축이다** — `scripts/hygiene-check.mjs`도 헤더에서
 * "설치 목록은 이 스크립트의 범위 밖"이라고 스스로 적어 두었고, 개인데이터 부정 단언은
 * `README.md`·`ROADMAP.md` 두 파일만 보고 있었다.
 *
 * ⚠️ **축 집합은 호출부가 선언한다 — 기본값을 두지 않는다.** 선택 필드는 누락을 통과시키고,
 * 여기서는 **누락이 곧 과잉 차단**이다. 6축 전부를 문서 전문에 걸면 오늘 즉시 27건이 위반이 된다
 * (실측 2026-08-31: `~/`가 `docs/harness-facts.md` 21 · `README.md` 3 · `ROADMAP.md` 3).
 * 전부 `~/.claude.json` 같은 **정당한 설정 경로 관습**이고 사용자명이 없다 — 그 셋은 오늘 위생
 * 단언을 통과하는 파일이므로, 6축을 그대로 걸면 **초록인 게이트를 새로 빨갛게 만든다.**
 * `INSTALL_INVENTORY_AXES`(문서 전문)와 `GENERATED_OUTPUT_AXES`(생성 산출물)를 갈라 쓴다.
 */

export const WORKFLOW_DOC_LEAK_AXES = [
  "abs_home_users",
  "abs_home_linux",
  "tilde_home",
  "marketplace_asset_id",
  "machine_uuid",
  "snapshot_filename",
] as const;

export type WorkflowDocLeakAxis = (typeof WORKFLOW_DOC_LEAK_AXES)[number];

/**
 * **문서 전문**(`docs/*.md` · `README.md` · `ROADMAP.md`)이 보는 집합 — 설치 목록 축만.
 * 경로 축을 빼는 근거는 둘이다: ① `scripts/hygiene-check.mjs`가 `git ls-files` 전수를 열어
 * **앵커된 형태의** 경로 리터럴을 CI에서 실제로 본다 ② `~/`는 이 저장소의 **정상 표기**다.
 * ⚠️ **근거 ①은 부분적으로만 성립한다(보안 심사 L-3).** 두 스캐너의 정규식이 다르다 —
 * `hygiene-check`에는 부정 lookbehind가 있고 `findRawPathLeaks`에는 없어, `at/Users/…`처럼
 * 앞 문자에 붙은 형태는 이쪽만 잡는다. 또 그 스크립트의 "실행 머신의 홈·hostname 리터럴" 축은
 * **검사를 돌리는 머신**에서 계산되므로 CI 러너에서는 아무것도 지키지 않는다.
 * 생성 구간은 아래 `GENERATED_OUTPUT_AXES`(6축)가 따로 보므로 사각지대는 아니다.
 */
export const INSTALL_INVENTORY_AXES: readonly WorkflowDocLeakAxis[] = [
  "marketplace_asset_id",
  "machine_uuid",
  "snapshot_filename",
];

/**
 * **생성 산출물 · 렌더 결과 · 화면 출력**이 보는 집합 — 6축 전부.
 * 서드파티 `description` 원문이 흘러드는 자리라 경로 축까지 봐야 한다.
 */
export const GENERATED_OUTPUT_AXES: readonly WorkflowDocLeakAxis[] = WORKFLOW_DOC_LEAK_AXES;

export interface WorkflowDocLeak {
  readonly axis: WorkflowDocLeakAxis;
  readonly match: string;
}

/**
 * 축별 탐지 패턴. `marketplace_asset_id`·`machine_uuid`·`snapshot_filename`은
 * `packages/cli/test/readme-cli-contract.test.ts`가 쓰던 것과 **같은 정규식**이다 — 그 테스트도
 * 이제 이 모듈을 부른다(사본을 남기면 원본의 정정이 사본에 도달하지 않는다).
 */
const AXIS_PATTERNS: Readonly<Record<Exclude<WorkflowDocLeakAxis, "abs_home_users" | "abs_home_linux">, RegExp>> = {
  tilde_home: /~\/[A-Za-z0-9._\-/]+/g,
  marketplace_asset_id: /\b[a-z][a-z0-9-]{2,}@[a-z][a-z0-9-]{2,}\b/g,
  machine_uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
  snapshot_filename: /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.jsonl/g,
};

/** `findRawPathLeaks`가 낸 `pattern` 문자열을 축 이름으로 되짚는다. */
function pathAxisOf(patternSource: string): WorkflowDocLeakAxis | null {
  if (patternSource.includes("Users")) return "abs_home_users";
  if (patternSource.includes("home")) return "abs_home_linux";
  return null;
}

/**
 * 허용 항목의 축은 **`AXIS_PATTERNS`가 가진 축으로 좁힌다** — 경로 축(`abs_home_*`)은
 * `findRawPathLeaks` 합성이라 여기 패턴이 없다.
 * ⚠️ **보안 심사 L-1**: 이전에는 축이 6축 전체였고 `findUnusedLeakAllowances`가
 * `AXIS_PATTERNS[...]?.source ?? ""`로 빈 패턴을 만들어 **zero-length 매치 무한 루프**에 빠졌다
 * (주입 실증: 200만 회 후에도 `lastIndex=0`). 그 함수는 `readme-cli-contract.test.ts`가 부르므로
 * CI 잡이 타임아웃까지 매달린다. `?? ""`는 **"없음"을 "빈 패턴"으로 삼키는** 형태이기도 하다.
 * 경로 축 허용 항목이 필요해지면 `?? ""`를 없애고 경로 축을 **정식 지원**하는 쪽으로 간다.
 */
export interface LeakAllowance {
  /** 정확 일치할 문자열. 부분 일치는 쓰지 않는다 — 통과 축은 완전 일치다(안전 원칙 6). */
  readonly match: string;
  readonly axis: keyof typeof AXIS_PATTERNS;
  readonly note: string;
}

/**
 * 허용목록 — **파일 단위 예외를 두지 않는다.** `docs/harness-facts.md`는 `docs/`의 96.8%라
 * 파일로 빼면 축이 존재하면서 사실상 아무것도 안 보는 상태가 된다.
 *
 * **모집단**: 항목은 **2개**이고 오늘 `docs/**`에서의 **출현은 4회**다(`name@marketplace` 3 ·
 * `user@pass` 1 — 실측 2026-08-31). 계획서가 "허용목록 4건"이라 적은 것은 출현 수를 항목 수로
 * 말한 것이다. `README.md`·`ROADMAP.md`에는 0건이다.
 */
export const LEAK_ALLOWANCES: readonly LeakAllowance[] = [
  {
    match: "name@marketplace",
    axis: "marketplace_asset_id",
    note: "자산 id의 **형식**을 서술한 자리표시자 — 실제 설치된 플러그인이 아니다",
  },
  {
    match: "user@pass",
    axis: "marketplace_asset_id",
    note: "URL userinfo 취약점을 서술한 예시 — 실제 크레덴셜이 아니다",
  },
];

function isAllowed(axis: WorkflowDocLeakAxis, match: string): boolean {
  return LEAK_ALLOWANCES.some((a) => a.axis === axis && a.match === match);
}

/**
 * `text`에서 `axes`에 해당하는 유출 흔적을 찾는다. 허용목록에 **정확 일치**하는 것은 뺀다.
 *
 * @param axes 볼 축. **기본값이 없다** — 호출부가 무엇을 보는지 명시적으로 정한다.
 */
export function findWorkflowDocLeaks(
  text: string,
  axes: readonly WorkflowDocLeakAxis[],
): WorkflowDocLeak[] {
  const wanted = new Set(axes);
  const leaks: WorkflowDocLeak[] = [];

  if (wanted.has("abs_home_users") || wanted.has("abs_home_linux")) {
    // 경로 축은 재구현하지 않고 `findRawPathLeaks`를 합성한다 — 그쪽은 축 라벨과 함께
    // **반환**하므로(`assertNoRawPathLeaks`는 던진다) 그대로 접붙는다.
    for (const violation of findRawPathLeaks(text)) {
      const axis = pathAxisOf(violation.pattern);
      if (axis === null || !wanted.has(axis)) continue;
      if (isAllowed(axis, violation.match)) continue;
      leaks.push({ axis, match: violation.match });
    }
  }

  for (const [axis, pattern] of Object.entries(AXIS_PATTERNS)) {
    const typedAxis = axis as WorkflowDocLeakAxis;
    if (!wanted.has(typedAxis)) continue;
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (isAllowed(typedAxis, m[0])) continue;
      leaks.push({ axis: typedAxis, match: m[0] });
    }
  }

  return leaks;
}

/**
 * 어떤 허용 항목도 조용히 썩지 않게 한다 — **미사용은 에러다**(경고가 아니다).
 * 예외 맵에 요구한 규율과 같다: 상류가 바뀌어 그 자리표시자가 사라지면 허용 항목도 사라져야 한다.
 *
 * @returns 주어진 코퍼스 어디에서도 매칭되지 않은 허용 항목.
 */
export function findUnusedLeakAllowances(corpus: readonly string[]): LeakAllowance[] {
  return LEAK_ALLOWANCES.filter((allowance) => {
    const pattern = AXIS_PATTERNS[allowance.axis];
    if (pattern === undefined) {
      // "없음"을 빈 패턴으로 삼키지 않는다 — 빈 정규식은 무한 루프를 만든다(L-1).
      throw new Error(`허용 항목의 축 ${allowance.axis}에 탐지 패턴이 없다`);
    }
    const re = new RegExp(pattern.source, "g");
    return !corpus.some((text) => {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[0] === allowance.match) return true;
      }
      return false;
    });
  });
}

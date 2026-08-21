/**
 * core/src/guard/forbidden-argv.ts — iter 8 · H1 (착수 조건 C5 인접 — Step 4가 소비할 판정기를
 * Step 1에서 선행 구현한다, C2와 같은 논리).
 *
 * `spawnClaude()` 래퍼(Step 4)는 argv를 전량 구성하고 호출자의 extra args를 pass-through하지
 * 않는다 — 이 판정기는 그 구성된 argv를 spawn 직전에 재확인하는 마지막 방어선이다.
 *
 * core/guard 판정기이므로 순수 함수다 — I/O 없음, "어느 홈이냐"를 모른다(C2와 같은 제약,
 * eslint.config.js의 ctk/no-home-literals가 packages/core/src/guard/**에 강제한다).
 */

export interface ForbiddenArgvRule {
  /** 금지 플래그 리터럴 — argv의 정확한 토큰과 일치해야 매칭된다. */
  flag: string;
  /**
   * 지정하면 "플래그 바로 다음 토큰이 이 값 중 하나일 때만" 금지다(예: --permission-mode).
   * 생략하면 플래그 존재 자체가 값과 무관하게 금지다.
   */
  forbiddenValues?: readonly string[];
  note: string;
}

/**
 * 금지 argv 리터럴 16종 (plan §1.3 결정 6 · §4.1 전역 lint 규칙 · H1).
 * `--permission-mode`만 값 조건부이고 나머지 15개는 존재 자체로 금지다.
 */
export const FORBIDDEN_ARGV_RULES: readonly ForbiddenArgvRule[] = [
  { flag: "--dangerously-skip-permissions", note: "권한 확인 전면 우회" },
  { flag: "--allow-dangerously-skip-permissions", note: "권한 확인 전면 우회 허용" },
  {
    flag: "--permission-mode",
    forbiddenValues: ["bypassPermissions", "acceptEdits", "dontAsk", "auto"],
    note: "위험한 권한 모드 값 — 이 4값만 금지(다른 값은 금지 대상 아님)",
  },
  { flag: "--plugin-url", note: "URL에서 플러그인 zip 다운로드 — 임의 원격 코드 로드" },
  {
    flag: "--plugin-dir",
    note:
      "봉인 세션에 임의 플러그인 로드 — sealed-live/test-isolated에서 금지. " +
      "agent-probe만 예외 조합으로 별도 허용되며 이 상수를 통하지 않는다",
  },
  { flag: "--settings", note: "병합 의미 — '제한 수단'으로 오인되기 쉽다(사실오인 정정, §1.3)" },
  { flag: "--add-dir", note: "추가 접근 경로 — 봉인 범위 확장" },
  { flag: "--agents", note: "임의 에이전트 정의 주입" },
  { flag: "--system-prompt", note: "시스템 프롬프트 대체 — 구조적 격리(B1 통제 1) 위반" },
  { flag: "--cloud", note: "클라우드 실행 경로 — 로컬 우선 전제 위반" },
  { flag: "--bg", note: "백그라운드 실행 — 직렬화·타임아웃 통제를 벗어난다" },
  { flag: "--teleport", note: "원격 세션 전이" },
  { flag: "--remote-control", note: "원격 제어 채널" },
  { flag: "--ide", note: "IDE 통합 — 봉인 세션 범위 밖" },
  { flag: "--chrome", note: "브라우저 통합 — 봉인 세션 범위 밖" },
  { flag: "--worktree", note: "워크트리 격리 — 봉인 프로파일이 직접 관리하는 cwd와 충돌" },
];

/**
 * 위치인자 0개 단언에서 "직후 토큰 1개까지만 값으로 인정"할 플래그의 기본 목록.
 * `--tools`·`--allowedTools`·`--mcp-config`·`--add-dir`는 실제 CLI에서 가변인자라 값을 여러 개
 * 삼킬 수 있다 — 그래서 이 판정기는 "등록된 플래그 바로 다음 토큰 1개"만 정당한 값으로 인정하고,
 * 그 이상 이어지는 비-플래그 토큰은 전부 위치인자 위반으로 잡는다(가변인자가 추가 위치인자를
 * 조용히 삼키는 경로를 막는다). `--permission-mode`도 값 검사를 위해 포함한다.
 *
 * 이 판정기는 "실제 wrapper가 어떤 플래그 조합을 쓰는지" 몰라야 하므로(C2와 같은 논리)
 * 호출자가 이 목록을 교체할 수 있게 파라미터화한다 — Step 4의 실제 spawn wrapper는 자신이 쓰는
 * 전체 플래그 집합(`--timeout-sec` 등 다른 단일값 플래그 포함)으로 이 인자를 넘겨야 한다.
 */
export const DEFAULT_SINGLE_VALUE_ARGV_FLAGS: readonly string[] = [
  "--permission-mode",
  "--tools",
  "--allowedTools",
  "--mcp-config",
  "--add-dir",
];

export type ArgvViolationReason = "forbidden_flag" | "forbidden_value" | "positional_argument";

export interface ArgvViolation {
  index: number;
  value: string;
  reason: ArgvViolationReason;
  note: string;
}

export interface ArgvVerdict {
  status: "clean" | "violation";
  violations: ArgvViolation[];
}

function isFlagToken(token: string): boolean {
  return token.startsWith("-");
}

export interface AssertForbiddenArgvOptions {
  /**
   * 위치인자 0개 단언을 적용할지 여부. 기본값 `true`(§1.3 결정 6의 `-p` 모델 세션 전제 — 프롬프트는
   * stdin으로 전달되므로 argv에 위치인자가 있으면 안 된다). `claude plugin list --json`처럼 서브
   * 커맨드 자체가 위치인자인 비-모델 호출(probe의 파일 조회성 spawn)에서는 `false`로 끈다 — 이
   * 경우에도 금지 플래그/금지값 검사(1번)는 그대로 적용된다.
   */
  checkPositionalArguments?: boolean;
}

/**
 * argv 판정. `(argv, rules?, singleValueFlags?, options?) → verdict` 순수 함수.
 *
 * 1) 금지 리터럴 16종(+ `--permission-mode` 금지값 4종) 검출 — 항상 적용된다.
 * 2) 위치인자 0개 단언 — 프롬프트는 stdin으로 전달되므로 argv에 위치인자가 있으면 안 된다.
 *    `singleValueFlags`에 등록된 플래그의 바로 다음 토큰 1개만 정당한 값으로 인정하고, 그 외
 *    비-플래그 토큰은 전부 위치인자 위반이다. `options.checkPositionalArguments:false`로 끌 수 있다.
 */
export function assertForbiddenArgv(
  argv: readonly string[],
  rules: readonly ForbiddenArgvRule[] = FORBIDDEN_ARGV_RULES,
  singleValueFlags: readonly string[] = DEFAULT_SINGLE_VALUE_ARGV_FLAGS,
  options: AssertForbiddenArgvOptions = {},
): ArgvVerdict {
  const checkPositionalArguments = options.checkPositionalArguments ?? true;
  const ruleByFlag = new Map(rules.map((r) => [r.flag, r] as const));
  const singleValueSet = new Set(singleValueFlags);
  const violations: ArgvViolation[] = [];

  // 직전 플래그가 소비할 것으로 기대되는 값 토큰의 인덱스. -1이면 소비 기대 없음.
  let expectedValueIndex = -1;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (isFlagToken(token)) {
      const rule = ruleByFlag.get(token);
      if (rule) {
        if (rule.forbiddenValues) {
          const value = argv[i + 1];
          if (value !== undefined && rule.forbiddenValues.includes(value)) {
            violations.push({
              index: i,
              value: `${token} ${value}`,
              reason: "forbidden_value",
              note: rule.note,
            });
          }
        } else {
          violations.push({ index: i, value: token, reason: "forbidden_flag", note: rule.note });
        }
      }
      expectedValueIndex = singleValueSet.has(token) ? i + 1 : -1;
      continue;
    }

    if (i === expectedValueIndex) {
      // 등록된 단일값 플래그의 정당한 값 1개 — 소비됨.
      expectedValueIndex = -1;
      continue;
    }

    if (!checkPositionalArguments) continue;

    violations.push({
      index: i,
      value: token,
      reason: "positional_argument",
      note: "프롬프트는 stdin으로 전달되므로 argv에 위치인자가 있으면 안 된다",
    });
  }

  return { status: violations.length > 0 ? "violation" : "clean", violations };
}

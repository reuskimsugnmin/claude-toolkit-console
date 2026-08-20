/**
 * core/src/guard/env-whitelist.ts — iter 8 · B2 (§1.3 결정 6 공통 강제 사항 8번).
 *
 * `spawnClaude()`(probe/src/harness/spawn-claude.ts)는 자식 프로세스에 env를 상속하지 않고
 * 명시 화이트리스트로만 구성한다(`env -i` 규약). `--safe-mode`는 설정 파일의 커스터마이즈를
 * 끌 뿐 환경변수를 끄지 않으므로 env는 봉인의 완전한 우회로다 — 이 판정기는 "구성된 env가
 * 화이트리스트 밖 변수를 담고 있지 않은가"를 spawn 직전에 재확인하는 마지막 방어선이다.
 *
 * core/guard 판정기이므로 순수 함수다 — I/O 없음, "어느 홈이냐"를 모른다(C2와 같은 제약,
 * eslint.config.js의 ctk/no-home-literals가 packages/core/src/guard/**에 강제한다).
 */

/**
 * 두 프로파일 공통 허용 목록(§1.3 결정 6 공통 강제 8번). `HOME`·`CLAUDE_CONFIG_DIR`은 래퍼가
 * 항상 명시적으로 설정하므로 별도 인자로 받지 않고 이 목록에 포함해 둔다 — 값 자체는 호출자가
 * 구성한 env 레코드에 이미 들어있고, 이 판정기는 "키가 허용 목록 안인가"만 본다.
 */
export const ENV_WHITELIST_COMMON: readonly string[] = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "PATH",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
];

/** `sealed-live` 전용 — safe mode의 자기 선언(플래그 파싱 의미가 바뀌어도 한 경로는 남는다). */
export const ENV_WHITELIST_SEALED_LIVE_EXTRA: readonly string[] = ["CLAUDE_CODE_SAFE_MODE"];

export interface EnvWhitelistVerdict {
  status: "clean" | "violation";
  /** 허용 목록 밖인데 자식 env 객체에 존재하는 키 이름만(값은 절대 포함하지 않는다 — 토큰이 섞일 수 있다). */
  leakedKeys: string[];
}

/**
 * `(env, allowlist) → verdict` 순수 함수. `env`는 자식 프로세스에 실제로 전달될 env 레코드
 * 그 자체(호출자가 이미 명시 화이트리스트로 구성했어야 한다) — 이 함수는 그 구성이 새지
 * 않았는지 마지막으로 단언한다.
 */
export function assertEnvWhitelist(
  env: Readonly<Record<string, string | undefined>>,
  allowlist: readonly string[] = ENV_WHITELIST_COMMON,
): EnvWhitelistVerdict {
  const allowed = new Set(allowlist);
  const leakedKeys = Object.keys(env).filter((key) => !allowed.has(key));
  return { status: leakedKeys.length > 0 ? "violation" : "clean", leakedKeys };
}

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
 * **값이 고정된 자기선언 env.** 부모 env에서 상속하지 **않고** 항상 이 값으로 설정된다.
 *
 * ⚠️ **키만 나열하는 배열로 두지 않는다**(보안 재심 M1, 2026-08-25). 예전에는 화이트리스트가
 * 문자열 배열이고 "이 목록의 키는 전부 자기선언"이라는 불변식이 **주석과 손으로 쓴 `if` 분기에만**
 * 존재했다. `buildChildEnv`의 기본 분기는 부모 env에서 상속하므로, 다음 사람이 배열에 문자열
 * 하나를 더하면 그 키는 **조용히 상속 채널이 되고 마지막 방어선인 `assertEnvWhitelist`까지
 * `clean`으로 통과한다**(재현: `ANTHROPIC_BASE_URL`을 배열에만 추가하면 부모 값이 자식에 도달).
 *
 * 이제 원소는 "키"가 아니라 **"키 + 고정값"**이다 — 값 없이는 타입이 추가를 거부한다.
 * **선택 필드는 누락을 통과시킨다**(안전 원칙 5).
 */
export const ENV_SELF_DECLARED_COMMON = {
  /**
   * 자식의 CLI 자기 업데이트와 **플러그인 마켓플레이스 자동 갱신**을 함께 끈다.
   * 능력을 주는 것이 아니라 **빼앗는다.**
   *
   * **왜 공통인가(보안 재심 L1).** 처음에는 `sealed-live` 전용으로 뒀는데 그 근거가 틀렸다 —
   * `test-isolated`도 **인증 불요 프로덕션 호출**(`ctk scan`의 `plugin list --json`,
   * `agent-probe`)에 쓰이고, 그 경로는 `CLAUDE_CONFIG_DIR`을 주입하지 않아 자식이 **실제
   * `~/.claude`를 본다.** `probe`는 계층 계약상 **읽기 전용**인데 그 자식이 마켓플레이스 갱신을
   * 유발해 레지스트리를 다시 쓸 수 있었다. 이 키는 빼앗기만 하므로 격리 홈에서는 무해하고,
   * 프로덕션 경로에서는 계약을 지켜준다.
   *
   * 근거는 도움말 인용이 아니라 바이너리(2.1.243)다:
   * `function fQ(){return TN()&&!c.FORCE_AUTOUPDATE_PLUGINS}` — "업데이트가 꺼졌고
   * (`DISABLE_UPDATES`/`DISABLE_AUTOUPDATER`) 강제 오버라이드가 없으면 참".
   * **되살리는 오버라이드가 존재한다는 것 자체가** 이 키가 플러그인 갱신을 끈다는 증거다.
   *
   * `DISABLE_UPDATES`는 **넣지 않는다** — 같은 술어를 만족시키므로 이득이 0이고, 키가 늘면
   * 유지보수 표면만 넓어진다(재심 Q3).
   */
  DISABLE_AUTOUPDATER: "1",
} as const satisfies Record<string, string>;

/** `sealed-live` 전용 자기선언 — safe mode의 자기 선언(플래그 파싱 의미가 바뀌어도 한 경로는 남는다). */
export const ENV_SELF_DECLARED_SEALED_LIVE = {
  CLAUDE_CODE_SAFE_MODE: "1",
} as const satisfies Record<string, string>;

/**
 * 두 프로파일 공통 허용 목록(§1.3 결정 6 공통 강제 8번). `HOME`·`CLAUDE_CONFIG_DIR`은 래퍼가
 * 항상 명시적으로 설정하므로 별도 인자로 받지 않고 이 목록에 포함해 둔다 — 값 자체는 호출자가
 * 구성한 env 레코드에 이미 들어있고, 이 판정기는 "키가 허용 목록 안인가"만 본다.
 *
 * **실제로 부모 env에서 값이 흘러 들어오는 것은 아래 6개뿐이다** — `HOME`은 덮어쓰고,
 * `CLAUDE_CONFIG_DIR`은 조건부이며, 자기선언 키들은 상속하지 않는다.
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
  ...Object.keys(ENV_SELF_DECLARED_COMMON),
];

/** `sealed-live` 전용 추가 키 — 자기선언 맵에서 파생한다(맨 키를 손으로 더할 수 없다). */
export const ENV_WHITELIST_SEALED_LIVE_EXTRA: readonly string[] = Object.keys(ENV_SELF_DECLARED_SEALED_LIVE);

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

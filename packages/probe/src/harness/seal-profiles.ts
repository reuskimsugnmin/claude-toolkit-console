import {
  ENV_SELF_DECLARED_COMMON,
  ENV_SELF_DECLARED_SEALED_LIVE,
  ENV_WHITELIST_COMMON,
  ENV_WHITELIST_SEALED_LIVE_EXTRA,
} from "@ctk/core";

/**
 * probe/src/harness/seal-profiles.ts — 두 프로파일(§1.3 결정 6)의 argv/env 조합을 순수하게
 * 구성한다. I/O 없음(실제 spawn은 spawn-claude.ts가 한다) — 그래서 유닛 테스트로 프로파일별
 * 구성이 정확한지 검증할 수 있다.
 *
 * Step 4 — `sealed-live`의 모델 세션(`claude -p`) 전용 통제를 여기서 채운다: `--tools ""`
 * (B4, 필수) · `--disallowedTools`(병행 심층 방어) · `--disable-slash-commands` ·
 * `--setting-sources project`(`--safe-mode`와 중첩 — 단일 플래그 의존 해소, iter 8 무료 통제 4) ·
 * `--no-session-persistence`(AC-0.11 — projects/ churn 제거). `--json-schema`+`--output-format
 * json`·`--max-budget-usd`·`--timeout-sec`는 호출별로 값이 달라 여기서 고정하지 않는다 —
 * 호출자(`gen`)가 subcommand로 넘긴다. `agent-probe`(AC-3.3) 예외 조합은
 * `buildAgentProbeArgv()`가 별도로 구성한다 — `--safe-mode` 대신 `--setting-sources project` +
 * `--plugin-dir`를 쓰므로 이 파일의 일반 프로파일 argv 구성과 섞지 않는다.
 */

export type SealProfile = "test-isolated" | "sealed-live";

export const SEAL_PROFILES: readonly SealProfile[] = ["test-isolated", "sealed-live"];

export function isSealProfile(value: unknown): value is SealProfile {
  return value === "test-isolated" || value === "sealed-live";
}

/**
 * 공통 강제 사항 2번 — `--strict-mcp-config` + 빈 `--mcp-config`. 값을 명시하지 않으면 `-p`
 * 모드가 "검증 실패한 설정 파일을 조용히 무시"하므로(`--help` 원문) 정확한 리터럴을 고정한다.
 */
export const EMPTY_MCP_CONFIG_JSON = '{"mcpServers":{}}';

/** subcommand에 `-p`가 있으면 모델(프롬프트) 세션이다 — argv 프리픽스 구성이 이 판정에 갈린다. */
export function isModelSessionSubcommand(subcommand: readonly string[]): boolean {
  return subcommand.includes("-p");
}

/**
 * 프로파일 + 호출 종류(모델 세션 vs 구조적 서브커맨드)별 argv 프리픽스. 호출자가 넘기는
 * subcommand(예: `["plugin","list","--json"]`)는 이 뒤에 그대로 이어붙는다 — 래퍼가 argv를
 * 전량 구성하고 호출자의 자유 플래그를 pass-through하지 않는다(iter 8 · H1).
 *
 * ⚠️ 실측 정정(Step 2, 실제 환경 검증에서 발견): `--strict-mcp-config`/`--mcp-config`는 **`-p`
 * 모델 세션에만 적용된다.** `claude plugin list --json` 등 구조적 서브커맨드에 이 플래그를
 * 붙이면(위치와 무관하게) `error: unknown option '--json'`(앞에 붙일 때) 또는
 * `error: unknown option '--strict-mcp-config'`(뒤에 붙일 때)로 **명령 자체가 실패한다** —
 * `plugin` 서브커맨드는 이 두 플래그를 아예 모르는 별도 파서를 쓴다. `--safe-mode`는 실측상
 * `plugin list --json`을 깨지 않으므로(exit 0, 동일 바이트 수 출력) 구조적 서브커맨드에도 유지한다.
 */
/**
 * `--disallowedTools` 심층 방어 목록(iter 8 · ADR-004) — `--tools ""`가 이미 도구 0개를
 * 강제하므로 이 목록은 **대체가 아니라 병행**이다. `--tools ""`의 의미론이 어떤 이유로든
 * 회귀해도(버전 드리프트 등) 이 두 번째 경계가 남는다. 알려진 내장 도구 이름을 전부 나열한다 —
 * 이름 목록이 하네스 버전에 종속되므로(R13 대상) `--tools ""` 자체가 여전히 1차 방어선이다.
 */
export const SEALED_LIVE_DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Read",
  "Glob",
  "Grep",
  "Task",
  "Agent",
  "TodoWrite",
  "BashOutput",
  "KillShell",
];

/**
 * `sealed-live` 모델 세션 전용 통제(iter 8). `--tools ""`는 여기서 래퍼가 직접 주입한다 —
 * 호출자가 subcommand로 넘기는 값을 신뢰하지 않는다(H1, "래퍼가 argv를 전량 구성한다").
 * `spawn-claude.ts`가 이 리터럴이 실제로 argv에 도달했는지 마지막 방어선으로 재확인한다(B4).
 */
function sealedLiveModelSessionFlags(): string[] {
  return [
    "--tools",
    "",
    "--disallowedTools",
    SEALED_LIVE_DISALLOWED_TOOLS.join(","),
    "--disable-slash-commands",
    // --safe-mode와 대안이 아니라 중첩(iter 8 무료 통제 4 — R14 "단일 플래그 의존"을 완화가
    // 아니라 해소한다). 고정 cwd(~/.cache/ctk/sealed-cwd)에는 프로젝트 설정이 없으므로 이
    // 값은 항상 빈 프로젝트 설정을 로드하는 것과 같다 — 그 자체가 독립된 두 번째 잠금이다.
    "--setting-sources",
    "project",
    "--no-session-persistence",
  ];
}

export function buildArgvPrefix(profile: SealProfile, subcommand: readonly string[]): string[] {
  const modelSession = isModelSessionSubcommand(subcommand);
  const prefix: string[] = [];
  if (profile === "sealed-live") {
    // safe-mode는 모든 커스터마이즈(훅·user CLAUDE.md·설치 플러그인)를 비활성화한다(Step 0 실측,
    // AC-0.10ⓓ).
    prefix.push("--safe-mode");
    if (modelSession) {
      prefix.push(...sealedLiveModelSessionFlags());
    }
  }
  if (modelSession) {
    prefix.push("--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG_JSON);
  }
  return prefix;
}

export function buildFullArgv(profile: SealProfile, subcommand: readonly string[]): string[] {
  return [...buildArgvPrefix(profile, subcommand), ...subcommand];
}

/**
 * `agent-probe`(AC-3.3) 예외 조합 — `--safe-mode` **대신** `--setting-sources project` +
 * `--plugin-dir <pluginDir>`를 쓴다. `--safe-mode`는 스킬을 전부 죽여 "정확히 하나만 켠다"는
 * 이 AC의 실험 설계와 양립하지 않는다(§1.3 결정 6). 이 조합은 `--safe-mode`보다 약한 봉인이므로
 * **합성 카탈로그·진단 전용**이며, 호출자(gen/src/agent-probe.ts)가 stdout 머리말에 그 사실을
 * 명시해야 한다. `pluginDir`는 마켓플레이스 루트가 아니라 **플러그인 디렉터리 자체**여야 등록된다
 * (Architect 실측 정정, §1.3).
 */
export function buildAgentProbeArgv(subcommand: readonly string[], pluginDir: string): string[] {
  const modelSession = isModelSessionSubcommand(subcommand);
  const prefix: string[] = ["--setting-sources", "project", "--plugin-dir", pluginDir];
  if (modelSession) {
    prefix.push("--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG_JSON);
  }
  return [...prefix, ...subcommand];
}

/**
 * 공통 강제 사항 8번 — env는 상속하지 않고 명시 화이트리스트로 구성한다(`env -i` 규약,
 * 두 프로파일 모두 승계). `HOME`은 항상 `ctkHome`으로 **덮어써서** 설정한다(부모 프로세스의
 * 값이 아니라).
 *
 * ⚠️ **H5 수정** — `CLAUDE_CONFIG_DIR`은 더 이상 항상 주입하지 않는다. `configDirExplicit`이
 * true일 때만(격리 테스트가 `CTK_CONFIG_DIR`을 명시 설정한 경우) 주입한다. 프로덕션(미설정)에서는
 * 이 env를 아예 자식 env 레코드에 넣지 않는다 — 그래야 자식 `claude`가 `$HOME/.claude`로
 * 자연스럽게 기본값을 잡고(probe가 읽는 `ctkConfigDir` 기본값과 동일한 위치), probe와 자식
 * 서브프로세스가 서로 다른 `.claude.json`을 보는 사고(H5 원문)가 구조적으로 사라진다.
 */
export function buildChildEnv(
  profile: SealProfile,
  ctkHome: string,
  ctkConfigDir: string,
  configDirExplicit: boolean,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowlist =
    profile === "sealed-live" ? [...ENV_WHITELIST_COMMON, ...ENV_WHITELIST_SEALED_LIVE_EXTRA] : ENV_WHITELIST_COMMON;
  const selfDeclared: Record<string, string> =
    profile === "sealed-live"
      ? { ...ENV_SELF_DECLARED_COMMON, ...ENV_SELF_DECLARED_SEALED_LIVE }
      : { ...ENV_SELF_DECLARED_COMMON };

  const env: Record<string, string> = {};
  for (const key of allowlist) {
    if (key === "HOME") {
      env.HOME = ctkHome;
      continue;
    }
    if (key === "CLAUDE_CONFIG_DIR") {
      if (configDirExplicit) env.CLAUDE_CONFIG_DIR = ctkConfigDir;
      continue; // 명시 안 됐으면(프로덕션 기본 경로) 자식이 $HOME 기준 기본값을 쓰게 둔다(H5).
    }
    // ⚠️ **자기선언 키는 부모 env를 상속하지 않는다.** 손으로 쓴 `if` 분기 대신 맵에서 배선한다 —
    // 분기로 두면 키가 늘 때 분기 추가를 잊고, 그 키는 조용히 상속 채널이 된다(보안 재심 M1).
    // 사용자가 값을 "0"으로 두고 있어도 고정값이 이긴다: 봉인의 성질은 사용자 환경에 좌우되면 안 된다.
    const selfDeclaredValue = selfDeclared[key];
    if (selfDeclaredValue !== undefined) {
      env[key] = selfDeclaredValue;
      continue;
    }
    const value = parentEnv[key];
    if (value !== undefined && value.length > 0) {
      env[key] = value;
    }
  }
  // TERM/SHELL/TMPDIR은 부모 env에 없을 수 있다 — 스파이크(spikes/lib/spawn-claude.sh)와 동일한
  // 안전한 기본값으로 보강한다. 이 보강값들도 여전히 허용 목록 안이므로 env-whitelist 판정에
  // 위반으로 잡히지 않는다.
  if (env.TERM === undefined) env.TERM = "xterm";
  if (env.SHELL === undefined) env.SHELL = "/bin/bash";
  if (env.TMPDIR === undefined) env.TMPDIR = "/tmp";
  return env;
}

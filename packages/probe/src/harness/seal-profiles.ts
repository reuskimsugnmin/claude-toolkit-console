import { ENV_WHITELIST_COMMON, ENV_WHITELIST_SEALED_LIVE_EXTRA } from "@ctk/core";

/**
 * probe/src/harness/seal-profiles.ts — 두 프로파일(§1.3 결정 6)의 argv/env 조합을 순수하게
 * 구성한다. I/O 없음(실제 spawn은 spawn-claude.ts가 한다) — 그래서 유닛 테스트로 프로파일별
 * 구성이 정확한지 검증할 수 있다.
 *
 * ⚠️ Step 2 범위: `test-isolated`만 실사용한다(인증 불요 호출뿐). `sealed-live`는 모델 세션
 * (`claude -p`) 전용 통제(`--tools ""`·`--json-schema`·`--max-budget-usd`·프리플라이트 버전
 * 게이트 등)를 아직 구현하지 않는다 — 그건 Step 4(`gen`)가 실제로 `-p` 세션을 띄울 때 채운다.
 * 여기서는 두 프로파일 모두에 적용되는 "공통 강제 사항"(cwd 규약 밖 부분 · MCP 차단 · env 격리 ·
 * safe-mode 자기 선언)만 구성한다.
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
export function buildArgvPrefix(profile: SealProfile, subcommand: readonly string[]): string[] {
  const modelSession = isModelSessionSubcommand(subcommand);
  const prefix: string[] = [];
  if (profile === "sealed-live") {
    // safe-mode는 모든 커스터마이즈(훅·user CLAUDE.md·설치 플러그인)를 비활성화한다(Step 0 실측,
    // AC-0.10ⓓ). LLM 세션 전용 통제(--tools ""·--json-schema 등)는 Step 4가 추가한다.
    prefix.push("--safe-mode");
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
    if (key === "CLAUDE_CODE_SAFE_MODE") {
      // safe mode의 자기 선언 — 플래그 파싱 의미가 바뀌어도 이 경로는 남는다(§1.3 결정 6).
      env.CLAUDE_CODE_SAFE_MODE = "1";
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

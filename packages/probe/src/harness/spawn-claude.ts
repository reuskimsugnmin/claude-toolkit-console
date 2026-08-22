import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  AGENT_PROBE_FORBIDDEN_ARGV_RULES,
  DEFAULT_SINGLE_VALUE_ARGV_FLAGS,
  assertEnvWhitelist,
  assertForbiddenArgv,
  ENV_WHITELIST_COMMON,
  ENV_WHITELIST_SEALED_LIVE_EXTRA,
  verdictPreflightVersion,
  type PreflightVersionMatch,
} from "@ctk/core";
import type { HomeContext } from "../home.js";
import { assertNoAncestorConfig } from "./cwd-guard.js";
import { buildAgentProbeArgv, buildChildEnv, buildFullArgv, isModelSessionSubcommand, isSealProfile, type SealProfile } from "./seal-profiles.js";

/**
 * probe/src/harness/spawn-claude.ts — §1.3 결정 6의 봉인 래퍼. `claude`를 띄우는 모든 코드는
 * 이 모듈을 경유해야 하며(eslint `ctk/single-spawn-wrapper`가 직접 spawn을 lint로 금지),
 * `profile` 인자를 필수로 받는다 — 기본 프로파일은 없다(미지정 호출은 즉시 거부).
 *
 * Step 2 범위: 인증이 필요한 호출이 없으므로 실사용 경로는 `test-isolated`뿐이다(사용자 지시
 * 사항). `sealed-live`의 LLM 세션 전용 통제(`--tools ""`·`--json-schema`·`--max-budget-usd`·
 * 프리플라이트 버전 게이트)는 Step 4(`gen`)가 실제로 `-p` 세션을 띄울 때 추가한다 — 여기서는
 * 두 프로파일에 공통인 것(argv 전량 구성·env 화이트리스트·타임아웃·직렬화)만 강제한다.
 */

export class SealProfileMissingError extends Error {
  readonly failureClass = "seal_profile_missing" as const;
  constructor(received: unknown) {
    super(
      `spawnClaude()는 profile 인자가 필수다 — 허용값: "test-isolated" | "sealed-live" (받은 값: ${JSON.stringify(received)})`,
    );
    this.name = "SealProfileMissingError";
  }
}

export class ForbiddenArgvViolationError extends Error {
  constructor(violations: ReturnType<typeof assertForbiddenArgv>["violations"]) {
    super(
      `spawnClaude() argv가 금지 규칙을 위반했다(H1 마지막 방어선) — 이 코드는 우리 자신이 구성한 argv이므로 ` +
        `이 오류는 항상 구현 버그다: ${JSON.stringify(violations)}`,
    );
    this.name = "ForbiddenArgvViolationError";
  }
}

export class SealEnvLeakError extends Error {
  readonly failureClass = "seal_env_leak" as const;
  readonly leakedKeys: string[];
  constructor(leakedKeys: string[]) {
    super(`허용 목록 밖 환경변수가 자식 프로세스에 도달할 뻔했다(값은 로그에 남기지 않는다) — 키: ${leakedKeys.join(", ")}`);
    this.name = "SealEnvLeakError";
    this.leakedKeys = leakedKeys;
  }
}

export class SealTimeoutError extends Error {
  readonly failureClass = "seal_timeout" as const;
  constructor(timeoutSec: number) {
    super(`claude 서브프로세스가 벽시계 타임아웃(${timeoutSec}s)을 초과해 강제 종료됐다`);
    this.name = "SealTimeoutError";
  }
}

/**
 * iter 8 · B4 — ADR-004의 수용 논거 전체가 "도구 0개"에 걸려 있다. `sealed-live` 모델 세션은
 * `seal-profiles.ts`가 `--tools ""`를 항상 주입하지만, 이 클래스는 그 구성이 실제로 최종 argv에
 * 도달했는지 spawn 직전에 재확인하는 **마지막 방어선**이다(env-whitelist와 동형 설계).
 */
export class SealToolsNotEmptyError extends Error {
  readonly failureClass = "seal_tools_not_empty" as const;
  constructor() {
    super(
      "sealed-live 모델 세션의 argv에 --tools \"\"가 없거나 도구가 활성이다 — " +
        "이 설계는 '파일시스템 경계 상실을 도구 능력 제거로 상쇄한다'는 논증에 기대므로 필수다",
    );
    this.name = "SealToolsNotEmptyError";
  }
}

/**
 * iter 8 · B5 — spawn 직전 `claude --version`이 검증된 버전과 다르고, 0원 라우팅 신호
 * 재현에도 실패했다. 경고가 아니라 거부다.
 */
export class SealUnverifiedCliError extends Error {
  readonly failureClass = "seal_unverified_cli" as const;
  readonly verifiedVersion: string;
  readonly actualVersion: string;
  constructor(verifiedVersion: string, actualVersion: string) {
    super(
      `claude 버전이 검증된 버전과 다르고(검증: ${verifiedVersion}, 실제: ${actualVersion}) ` +
        "0원 라우팅 신호 재현도 실패했다 — sealed-live 실행을 거부한다. 복구: `ctk verify seal --installed-plugin-command <설치된 슬래시 커맨드> --max-budget-usd <수치> --timeout-sec <초>`로 새 CLI 버전에서 봉인을 재증명하라 — 통과해야만 검증 버전이 갱신된다",
    );
    this.name = "SealUnverifiedCliError";
    this.verifiedVersion = verifiedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * L6 — `spawn("claude", ...)`는 자식 프로세스에 넘기는 `PATH`를 그대로 신뢰해 셸/OS의 PATH
 * 탐색에 맡겼다. `PATH`는 env 화이트리스트(공통 강제 사항 8번)를 통과하는 값이라 봉인 자체는
 * 깨지지 않지만, PATH 순서에 다른 위치의 동명 실행 파일이 먼저 걸리면 의도한 바이너리가 아닌
 * 것이 실행될 수 있다. 자식에게 넘길 그 PATH로 직접 탐색해 **절대경로**를 확정하고, 그 경로로
 * spawn한다 — PATH 문자열이 같아도 "무엇이 실행될지"가 셸의 암묵적 탐색이 아니라 이 코드가
 * 명시한 값이 되게 한다.
 */
export class ClaudeExecutableNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeExecutableNotFoundError";
  }
}

function resolveClaudeExecutable(pathEnv: string): string {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, "claude");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 이 디렉터리엔 없다 — 다음 PATH 세그먼트로 계속.
    }
  }
  throw new ClaudeExecutableNotFoundError(`PATH에서 실행 가능한 'claude' 바이너리를 찾지 못했다(PATH=${pathEnv})`);
}

/**
 * 절대경로로 resolve된 바이너리가 실제로 `claude` CLI인지 최소한의 sanity check(`--version`
 * 출력이 버전 형식과 대략 맞는가)를 한다 — 완전한 무결성 검증은 아니지만(체크섬 비교 등은
 * 범위 밖), PATH가 완전히 엉뚱한 동명 바이너리를 가리키는 조합의 오설정을 조용히 통과시키지
 * 않는다. 프로세스당 1회만 실행한다(버전 확인 자체가 매 호출마다 서브프로세스를 추가로 띄우는
 * 비용을 정당화할 만큼 자주 바뀔 정보가 아니다).
 */
const versionCheckedExecutables = new Set<string>();

function assertLooksLikeClaudeBinary(execPath: string): void {
  if (versionCheckedExecutables.has(execPath)) return;
  const result = spawnSync(execPath, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.status === 0 && /\d+\.\d+\.\d+/.test(result.stdout)) {
    versionCheckedExecutables.add(execPath);
    return;
  }
  throw new ClaudeExecutableNotFoundError(
    `${execPath} --version이 예상된 버전 형식을 반환하지 않았다(PATH 오설정 또는 동명의 다른 바이너리 의심)`,
  );
}

/**
 * `claude --version` 출력에서 버전 숫자만 뽑는다. **저장·비교하는 모든 경로가 이 함수를 써야
 * 한다** — `ctk init`이 stdout 전체("2.1.239 (Claude Code)")를 저장하고 프리플라이트는
 * 정규화값("2.1.239")과 비교해, 같은 버전인데도 불일치로 판정되는 버그가 실제로 있었다.
 * 형식이 다른 두 구현이 같은 값을 비교하면 조용히 틀린다.
 */
export function extractVersionString(stdout: string): string | null {
  const match = /\d+\.\d+\.\d+/.exec(stdout);
  return match?.[0] ?? null;
}

/**
 * iter 8 · B5 — 0원 라우팅 신호 재현. `routingProbeCommand`(실제 설치된 플러그인 슬래시 커맨드)를
 * `--safe-mode`로 호출해 "인식되지 않음"류 응답이 나오는지 본다(harness-facts.md: "슬래시 커맨드
 * 라우팅은 인증 이전에 결정된다 — 커맨드 존재 여부 판정은 모델 호출 없이 $0에 가능하다"). 이
 * 판정은 라우팅 계층이 안전 모드에서도 기존과 동일하게 동작한다는 최소 증거일 뿐, 3신호
 * 전체(ⓓ-2)를 대신하지 않는다 — `--max-budget-usd`를 극소값으로 고정해 판정 전제가 깨져도
 * 과금이 새지 않게 한다(방어적 상한, 이 신호 자체가 $0이어야 한다는 전제가 틀렸을 경우의 안전망).
 */
function reproduceRoutingSignal(
  execPath: string,
  env: Record<string, string>,
  cwd: string,
  routingProbeCommand: string,
): boolean {
  const result = spawnSync(
    execPath,
    ["--safe-mode", "--tools", "", "--max-budget-usd", "0.01", "-p", routingProbeCommand],
    { cwd, env, encoding: "utf8", timeout: 20_000 },
  );
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /unknown\s+command|not\s+(a\s+)?recognized|no\s+such\s+command/i.test(combined);
}

/**
 * iter 8 · B5 — `sealed-live` 모델 세션 전용 프리플라이트 게이트. `claude --version`을
 * `verifiedCliVersion`과 대조하고, 다르면 라우팅 신호 재현을 시도한다. 일치하지 않는데
 * `routingProbeCommand`가 없거나 재현이 실패하면 `SealUnverifiedCliError`를 던진다(거부,
 * 경고 아님) — `verdictPreflightVersion()`(core, 순수 함수)이 최종 판정을 내린다.
 */
function runPreflightVersionGate(
  execPath: string,
  env: Record<string, string>,
  cwd: string,
  verifiedCliVersion: string | undefined,
  routingProbeCommand: string | undefined,
): PreflightVersionMatch {
  const versionResult = spawnSync(execPath, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const actualVersion = extractVersionString(versionResult.stdout ?? "") ?? "(판독 불가)";

  // verifiedCliVersion이 아예 없으면 "검증 대상 없음"이지 "검증 통과"가 아니다 — 항상 불일치로
  // 취급해 fail-closed를 유지한다.
  const verified = verifiedCliVersion ?? `(미지정, 실제: ${actualVersion} 아님으로 간주)`;
  const routingReproduced =
    verified !== actualVersion && routingProbeCommand !== undefined
      ? reproduceRoutingSignal(execPath, env, cwd, routingProbeCommand)
      : false;

  const verdict = verdictPreflightVersion(verified, actualVersion, routingReproduced);
  if (!verdict.allowed) {
    throw new SealUnverifiedCliError(verified, actualVersion);
  }
  return verdict.match;
}

export interface SpawnClaudeOptions {
  /** 허용값은 정확히 둘 — 기본값 없음(§1.3 결정 6). */
  profile: SealProfile;
  /** `claude` 바이너리 이름은 제외한 서브커맨드+플래그(예: `["plugin","list","--json"]`). */
  subcommand: string[];
  home: HomeContext;
  /** 공통 강제 사항 1번 — 프로젝트 루트가 아닌 호출자 지정 임시 디렉터리. */
  cwd: string;
  /** 공통 강제 사항 9번(iter 8 · M4) — 벽시계 타임아웃(초). 필수(기본값 없음 = 무한 대기 금지). */
  timeoutSec: number;
  /** `-p` 세션의 프롬프트 — argv가 아니라 stdin으로 전달한다(공통 강제 사항 3번). Step 2는 사용하지 않는다. */
  stdinPrompt?: string;
  /**
   * iter 8 · B5 — `sealed-live` 모델 세션 필수. 미지정이면 프리플라이트 게이트를 건너뛰지
   * 않고 곧바로 불일치로 취급한다(fail-closed) — "검증 대상을 안 줬다"를 "검증 통과"로
   * 착각하지 않는다.
   */
  verifiedCliVersion?: string;
  /** 봉인 재증명(ⓓ-2) 전용 — 프리플라이트 버전 게이트를 건너뛴다. 이 절차가 곧 검증이므로
   * 검증된 버전을 요구하면 순환이 된다. 다른 어떤 경로에서도 켜지 않는다. */
  isSealVerification?: boolean;
  /**
   * iter 8 · B5 — 버전 불일치 시 재현을 시도할 0원 라우팅 신호. 실제 설치된 플러그인 슬래시
   * 커맨드(예: `/oh-my-claudecode:help`)를 안전 모드에서 호출했을 때 `Unknown command`류
   * 응답이 나오는지로 판정한다. 미지정이면 재현을 시도하지 않고 곧바로 거부한다.
   */
  routingProbeCommand?: string;
}

export interface SpawnClaudeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** iter 8 · B5 — sealed-live 모델 세션에서만 채워진다. run-log의 preflight_version_match로 옮긴다. */
  preflightVersionMatch?: PreflightVersionMatch;
}

/** spawn-claude.ts 자신의 wrapper argv 전량 — H1 위치인자 판정기에 넘길 단일값 플래그 목록. */
const WRAPPER_SINGLE_VALUE_ARGV_FLAGS: readonly string[] = [
  ...DEFAULT_SINGLE_VALUE_ARGV_FLAGS,
  "--setting-sources",
  "--disallowedTools",
  "--json-schema",
  "--output-format",
  "--max-budget-usd",
];

/** `spawnClaudeAgentProbe()` 전용 — 위 목록 + `--plugin-dir`(agent-probe 예외 조합에서만 등장). */
const AGENT_PROBE_SINGLE_VALUE_ARGV_FLAGS: readonly string[] = [...WRAPPER_SINGLE_VALUE_ARGV_FLAGS, "--plugin-dir"];

/**
 * iter 8 · B4 — 최종 argv에 `--tools`와 그 바로 다음 토큰 `""`가 존재하는지 확인한다.
 * `--tools`는 가변인자(`<tools...>`)이므로 우리 wrapper는 항상 `--tools ""` 뒤에 다른 플래그를
 * 바로 이어붙여 빈 문자열 하나만 소비되게 구성한다(seal-profiles.ts) — 이 함수는 그 불변식이
 * 실제로 지켜졌는지 재확인하는 마지막 방어선이다.
 */
function assertToolsEmpty(argv: readonly string[]): void {
  const index = argv.indexOf("--tools");
  if (index === -1 || argv[index + 1] !== "") {
    throw new SealToolsNotEmptyError();
  }
}

/** 공통 강제 사항 10번(iter 8 · H3) — `claude` 서브프로세스는 직렬화한다(동시성 1). */
let serializeChain: Promise<unknown> = Promise.resolve();

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const result = serializeChain.then(task, task);
  // 실패해도 체인이 끊기지 않게 다음 작업이 이어받을 수 있는 형태로 유지한다.
  serializeChain = result.catch(() => undefined);
  return result;
}

async function spawnOnce(
  execPath: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutSec: number,
  stdinPrompt: string | undefined,
): Promise<SpawnClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSec * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new SealTimeoutError(timeoutSec));
        return;
      }
      resolve({ exitCode, stdout, stderr, timedOut });
    });

    if (stdinPrompt !== undefined) {
      child.stdin.write(stdinPrompt, "utf8");
    }
    child.stdin.end();
  });
}

/**
 * `async`로 선언한다 — 검증 실패(profile 미지정·forbidden argv·env leak)를 **동기 throw가 아니라
 * 항상 Promise reject로 통일**하기 위해서다. Promise를 반환하는 함수가 때로는 동기 throw를,
 * 때로는 reject를 하면 호출부의 `.catch()`가 검증 실패 경로를 놓칠 수 있다.
 */
export async function spawnClaude(options: SpawnClaudeOptions): Promise<SpawnClaudeResult> {
  if (!isSealProfile(options.profile)) {
    throw new SealProfileMissingError(options.profile);
  }

  const argv = buildFullArgv(options.profile, options.subcommand);

  // 위치인자 0개 단언(core H1 기본값)은 `-p` 모델 세션 전제다 — probe가 쓰는 구조적 서브커맨드
  // 호출(`plugin list --json` 등)은 서브커맨드 단어 자체가 정당한 위치인자이므로 그 검사만 끈다.
  // 금지 플래그/금지값 검사(1번)는 두 경우 모두 그대로 적용된다.
  const isModelSession = isModelSessionSubcommand(options.subcommand);
  const argvVerdict = assertForbiddenArgv(argv, undefined, WRAPPER_SINGLE_VALUE_ARGV_FLAGS, {
    checkPositionalArguments: isModelSession,
  });
  if (argvVerdict.status === "violation") {
    throw new ForbiddenArgvViolationError(argvVerdict.violations);
  }

  // iter 8 · B4 — sealed-live 모델 세션은 도구 0개가 논증의 축이다(ADR-004). seal-profiles.ts가
  // 이미 주입하지만, 여기서 최종 argv를 마지막으로 재확인한다(env-whitelist와 동형 설계).
  if (options.profile === "sealed-live" && isModelSession) {
    assertToolsEmpty(argv);
  }

  const env = buildChildEnv(
    options.profile,
    options.home.ctkHome,
    options.home.ctkConfigDir,
    options.home.configDirExplicit,
  );
  // 실측(M6 검증 중 발견) — 이 마지막 방어선이 프로파일과 무관하게 항상 ENV_WHITELIST_COMMON만
  // 봤다. sealed-live가 실제로 spawn되는 경로가 이전에 없었기 때문에(actuator/apply/
  // plugin-enablement.ts가 test-isolated를 하드코딩했다, M6) 드러나지 않았을 뿐 — sealed-live의
  // 정당한 CLAUDE_CODE_SAFE_MODE=1 자기 선언(buildChildEnv, seal-profiles.ts)조차 "허용 목록 밖
  // 유출"로 오판해 SealEnvLeakError를 던지는 잠재 버그였다. buildChildEnv와 동일한 allowlist
  // 선택 로직을 그대로 재사용한다(재구현 금지).
  const allowlist =
    options.profile === "sealed-live" ? [...ENV_WHITELIST_COMMON, ...ENV_WHITELIST_SEALED_LIVE_EXTRA] : ENV_WHITELIST_COMMON;
  const envVerdict = assertEnvWhitelist(env, allowlist);
  if (envVerdict.status === "violation") {
    throw new SealEnvLeakError(envVerdict.leakedKeys);
  }

  // L6 — 자식에게 실제로 넘길 PATH로 절대경로를 확정하고, 처음 보는 경로면 --version으로
  // sanity check한다(PATH 오설정·동명 바이너리 방어).
  const execPath = resolveClaudeExecutable(env.PATH ?? "");
  assertLooksLikeClaudeBinary(execPath);

  // iter 8 · B5 — sealed-live 모델 세션마다 spawn 직전 버전 게이트. 실패하면 SealUnverifiedCliError를
  // 던진다(runSerialized 이전 — 직렬화 체인에 자리를 차지하지 않는다).
  let preflightVersionMatch: PreflightVersionMatch | undefined;
  // ⚠️ `isSealVerification`은 이 게이트의 **유일한 예외**다. 봉인 재증명(ⓓ-2)은 새 CLI 버전에서
  // 3신호를 실제로 재현해 검증 기록을 갱신하는 절차이므로, 그 절차 자체가 "검증된 버전"을
  // 요구하면 순환이 되어 **영원히 복구할 수 없다** — 게이트에 복구 경로가 없으면 사용자는
  // 게이트를 우회하는 법부터 찾고, 그 시점에 가드는 무력화된다.
  // 예외의 안전성 근거: 재증명은 결과를 **통과했을 때만** 기록에 반영하고, 실패하면 아무것도
  // 쓰지 않는다(cli/commands/verify-seal.ts). 즉 이 경로로는 봉인이 약해질 수 없다.
  if (options.profile === "sealed-live" && isModelSession && options.isSealVerification !== true) {
    preflightVersionMatch = runPreflightVersionGate(
      execPath,
      env,
      options.cwd,
      options.verifiedCliVersion,
      options.routingProbeCommand,
    );
  }

  const result = await runSerialized(() =>
    spawnOnce(execPath, argv, env, options.cwd, options.timeoutSec, options.stdinPrompt),
  );
  return preflightVersionMatch !== undefined ? { ...result, preflightVersionMatch } : result;
}

export interface SpawnClaudeAgentProbeOptions {
  /** `claude` 바이너리 이름은 제외한 서브커맨드+플래그(`-p <query>` 등). */
  subcommand: string[];
  home: HomeContext;
  /** M2 — 이 cwd의 **상위** 경로에 CLAUDE.md/.claude/가 있으면 spawn 전에 거부한다. */
  cwd: string;
  timeoutSec: number;
  stdinPrompt?: string;
  /** 마켓플레이스 루트가 아니라 플러그인 디렉터리 자체(Architect 실측 정정, §1.3). */
  pluginDir: string;
}

/**
 * `agent-probe`(AC-3.3) 예외 조합 전용 spawn. `spawnClaude()`(정확히 두 프로파일)와 별도
 * 함수로 둔다 — `--safe-mode` 대신 `--setting-sources project` + `--plugin-dir`를 쓰는 이
 * 조합은 `SealProfile` 타입(§1.3 결정 6 "허용값은 정확히 둘")에 억지로 끼워 넣지 않는다.
 * 이 함수도 `probe/src/harness/spawn-claude.ts` 안에 있으므로 `ctk/single-spawn-wrapper`
 * lint 예외를 그대로 쓴다("claude 서브프로세스는 이 래퍼를 통해서만" — 함수가 둘이어도 파일은
 * 하나다).
 */
export async function spawnClaudeAgentProbe(options: SpawnClaudeAgentProbeOptions): Promise<SpawnClaudeResult> {
  // M2 — --setting-sources project가 cwd의 프로젝트 설정을 의도적으로 로드하므로, 상위 경로에
  // 심어진 CLAUDE.md/.claude/가 유입될 수 있다. spawn 이전에 거부한다.
  assertNoAncestorConfig(options.cwd);

  const argv = buildAgentProbeArgv(options.subcommand, options.pluginDir);
  const isModelSession = isModelSessionSubcommand(options.subcommand);
  const argvVerdict = assertForbiddenArgv(argv, AGENT_PROBE_FORBIDDEN_ARGV_RULES, AGENT_PROBE_SINGLE_VALUE_ARGV_FLAGS, {
    checkPositionalArguments: isModelSession,
  });
  if (argvVerdict.status === "violation") {
    throw new ForbiddenArgvViolationError(argvVerdict.violations);
  }

  // agent-probe는 --safe-mode를 쓰지 않으므로 CLAUDE_CODE_SAFE_MODE 자기 선언 대상이 아니다 —
  // buildChildEnv("test-isolated", ...)를 재사용한다(HOME 덮어쓰기 + CLAUDE_CONFIG_DIR 조건부
  // 주입 로직은 프로파일과 무관하게 동일하고, "test-isolated"를 넘기면 그 부가 로직만 빠진다).
  // agent-probe는 실제 CLAUDE_CONFIG_DIR을 유지해 인증을 확보한다(sealed-live와 동일 이유).
  const env = buildChildEnv("test-isolated", options.home.ctkHome, options.home.ctkConfigDir, options.home.configDirExplicit);
  const envVerdict = assertEnvWhitelist(env, ENV_WHITELIST_COMMON);
  if (envVerdict.status === "violation") {
    throw new SealEnvLeakError(envVerdict.leakedKeys);
  }

  const execPath = resolveClaudeExecutable(env.PATH ?? "");
  assertLooksLikeClaudeBinary(execPath);

  return runSerialized(() => spawnOnce(execPath, argv, env, options.cwd, options.timeoutSec, options.stdinPrompt));
}

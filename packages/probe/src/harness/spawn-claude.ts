import { spawn } from "node:child_process";
import { assertEnvWhitelist, assertForbiddenArgv } from "@ctk/core";
import type { HomeContext } from "../home.js";
import { buildChildEnv, buildFullArgv, isModelSessionSubcommand, isSealProfile, type SealProfile } from "./seal-profiles.js";

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
}

export interface SpawnClaudeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutSec: number,
  stdinPrompt: string | undefined,
): Promise<SpawnClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
  const argvVerdict = assertForbiddenArgv(argv, undefined, undefined, {
    checkPositionalArguments: isModelSession,
  });
  if (argvVerdict.status === "violation") {
    throw new ForbiddenArgvViolationError(argvVerdict.violations);
  }

  const env = buildChildEnv(options.profile, options.home.ctkHome, options.home.ctkConfigDir);
  const envVerdict = assertEnvWhitelist(env);
  if (envVerdict.status === "violation") {
    throw new SealEnvLeakError(envVerdict.leakedKeys);
  }

  return runSerialized(() => spawnOnce(argv, env, options.cwd, options.timeoutSec, options.stdinPrompt));
}

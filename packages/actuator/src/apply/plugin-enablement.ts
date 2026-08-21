import { spawnClaude, type HomeContext, type SpawnClaudeResult } from "@ctk/probe";

/**
 * actuator/src/apply/plugin-enablement.ts — 결정 6C: `claude plugin disable <id> -s <fromScope>`
 * → `claude plugin enable <id> -s <toScope>`(래퍼 경유). `install_scope`는 건드리지 않으며
 * `installed_plugins.json`은 금지 목록에 있다(AC-2.1ⓑⓒ — actuator는 이 파일에 절대 쓰지 않는다.
 * 이 모듈은 `claude` 서브프로세스만 부르고 파일을 직접 건드리지 않는다).
 *
 * `-s <scope>`는 `user`|`project`|`local` 값만 받고, project/local 스코프는 CLI가 **cwd로
 * 대상을 판별한다**(실측 — `claude plugin enable --help`에 별도 경로 인자가 없다). 그래서 이
 * 모듈은 scope를 계산하지 않고 **호출자가 이미 결정한 cwd**를 그대로 받는다 — cwd 계산(스코프별
 * 임시 디렉터리 vs 대상 프로젝트 절대경로)은 호출자(주로 `apply/index.ts`나 `cli/move.ts`) 책임이다.
 *
 * 종료 코드를 반드시 확인한다(Step 2에서 `spawnClaude`가 실패를 빈 stdout으로 삼킨 전례 —
 * 여기서 같은 실수를 반복하지 않는다) — 0이 아니면 즉시 던진다.
 *
 * ⚠️ **Step 5 보안 심사 수정(M6)** — 이전에는 `profile: "test-isolated"`가 하드코딩돼 있었다.
 * `--safe-mode`는 `sealed-live` 프로파일에만 붙는데(seal-profiles.ts), 이 모듈이 사용자 환경을
 * **실제로 바꾸는 유일한 호출**(plugin enable/disable)이라는 점을 생각하면 봉인 없이 임의
 * 프로젝트 cwd에서 실행되고 있었다는 뜻이다 — 훅·커스터마이즈가 살아있는 채로 특권 쓰기가
 * 실행된 것. `--safe-mode`는 실측상(docs/harness-facts.md) `plugin list --json`을 깨지 않고
 * 인증도 정상 동작하므로(비용 0의 강화) `sealed-live`로 바꿨다 — 이름에 "test-"가 들어간
 * 프로파일이 프로덕션 쓰기 경로에 남아있지 않게 한다.
 */

export type PluginScope = "user" | "project" | "local";

export class PluginEnablementCommandFailedError extends Error {
  readonly step: "disable" | "enable";
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(step: "disable" | "enable", exitCode: number | null, stderr: string) {
    super(`claude plugin ${step} 실패(exit ${exitCode ?? "null"}): ${stderr.trim() || "(stderr 없음)"}`);
    this.name = "PluginEnablementCommandFailedError";
    this.step = step;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface PluginEnablementMoveOptions {
  assetId: string;
  fromScope: PluginScope;
  toScope: PluginScope;
  home: HomeContext;
  /** disable 호출의 cwd(user 스코프면 임시 디렉터리, project/local이면 소스 프로젝트 절대경로). */
  fromCwd: string;
  /** enable 호출의 cwd(user 스코프면 임시 디렉터리, project/local이면 대상 프로젝트 절대경로). */
  toCwd: string;
  timeoutSec: number;
  /** 테스트 주입용 — 기본값은 실제 spawnClaude. */
  spawnFn?: typeof spawnClaude;
}

export interface PluginEnablementMoveResult {
  disable: SpawnClaudeResult;
  enable: SpawnClaudeResult;
}

export async function movePluginEnablement(
  options: PluginEnablementMoveOptions,
): Promise<PluginEnablementMoveResult> {
  const { assetId, fromScope, toScope, home, fromCwd, toCwd, timeoutSec, spawnFn = spawnClaude } = options;

  const disable = await spawnFn({
    profile: "sealed-live",
    subcommand: ["plugin", "disable", assetId, "-s", fromScope],
    home,
    cwd: fromCwd,
    timeoutSec,
  });
  if (disable.exitCode !== 0) {
    throw new PluginEnablementCommandFailedError("disable", disable.exitCode, disable.stderr);
  }

  const enable = await spawnFn({
    profile: "sealed-live",
    subcommand: ["plugin", "enable", assetId, "-s", toScope],
    home,
    cwd: toCwd,
    timeoutSec,
  });
  if (enable.exitCode !== 0) {
    throw new PluginEnablementCommandFailedError("enable", enable.exitCode, enable.stderr);
  }

  return { disable, enable };
}

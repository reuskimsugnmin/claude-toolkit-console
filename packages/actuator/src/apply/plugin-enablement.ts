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
    profile: "test-isolated",
    subcommand: ["plugin", "disable", assetId, "-s", fromScope],
    home,
    cwd: fromCwd,
    timeoutSec,
  });
  if (disable.exitCode !== 0) {
    throw new PluginEnablementCommandFailedError("disable", disable.exitCode, disable.stderr);
  }

  const enable = await spawnFn({
    profile: "test-isolated",
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

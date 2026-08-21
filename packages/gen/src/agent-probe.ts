import { spawnClaudeAgentProbe, type HomeContext } from "@ctk/probe";

/**
 * gen/src/agent-probe.ts — AC-3.3 전용 진단 경로(M2). 봉인 래퍼(`spawnClaudeAgentProbe`)로
 * `claude -p`를 1회 띄워 합성 카탈로그에 대한 에이전트 도달을 관측하고 stdout을 그대로
 * 반환한다. **카탈로그에 쓰지 않는다**(읽기 + stdout만) — `sync`를 전혀 호출하지 않는다.
 *
 * 인자 조합은 `agent-probe` 예외 조합(`--setting-sources project` + `--plugin-dir`)이다 —
 * `--safe-mode`보다 약한 봉인이므로, 반환하는 stdout 머리말에 그 사실을 항상 명시한다(§1.3
 * 결정 6). `--max-budget-usd`는 필수이며 CLI 레이어(`ctk agent-probe`)가 미지정 시 이 함수를
 * 호출하지 않고 거부한다.
 */

export const AGENT_PROBE_WEAKER_SEAL_NOTICE =
  "⚠️ 이 실행은 agent-probe 예외 조합(--setting-sources project + --plugin-dir)을 쓴다 — " +
  "--safe-mode보다 약한 봉인이며 합성 카탈로그 대상 진단 전용이다. 실제 카탈로그·config에 " +
  "아무것도 쓰지 않는다.\n\n";

export interface RunAgentProbeOptions {
  home: HomeContext;
  /** M2 — 이 cwd의 상위 경로에 CLAUDE.md/.claude/가 있으면 spawn 전에 거부된다. */
  cwd: string;
  timeoutSec: number;
  maxBudgetUsd: number;
  /** 마켓플레이스 루트가 아니라 플러그인 디렉터리 자체(Architect 실측 정정). */
  pluginDir: string;
  query: string;
  spawnFn?: typeof spawnClaudeAgentProbe;
}

export interface RunAgentProbeResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

export async function runAgentProbe(options: RunAgentProbeOptions): Promise<RunAgentProbeResult> {
  const { home, cwd, timeoutSec, maxBudgetUsd, pluginDir, query, spawnFn = spawnClaudeAgentProbe } = options;
  const result = await spawnFn({
    subcommand: ["-p", "--max-budget-usd", String(maxBudgetUsd)],
    home,
    cwd,
    timeoutSec,
    stdinPrompt: query,
    pluginDir,
  });
  return { stdout: `${AGENT_PROBE_WEAKER_SEAL_NOTICE}${result.stdout}`, exitCode: result.exitCode, timedOut: result.timedOut };
}

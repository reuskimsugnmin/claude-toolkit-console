import { resolveHomeContext } from "@ctk/probe";
import { runAgentProbe, type RunAgentProbeResult } from "@ctk/gen";
import { ensureAgentProbeCwd } from "../sealed-cwd.js";
import { MissingRequiredFlagError } from "./gen.js";

/**
 * cli/src/commands/agent-probe.ts — `ctk agent-probe`(AC-3.3 전용 진단). **카탈로그·config에
 * 아무것도 쓰지 않는다** — `sync`를 전혀 호출하지 않고 stdout만 출력한다.
 */

export interface RunAgentProbeCliOptions {
  catalog: string;
  query: string;
  maxBudgetUsd?: number;
  timeoutSec?: number;
}

export async function runAgentProbeCli(options: RunAgentProbeCliOptions): Promise<RunAgentProbeResult> {
  if (options.maxBudgetUsd === undefined) throw new MissingRequiredFlagError("--max-budget-usd");
  if (options.timeoutSec === undefined) throw new MissingRequiredFlagError("--timeout-sec");

  const home = resolveHomeContext();
  return runAgentProbe({
    home,
    cwd: ensureAgentProbeCwd(),
    timeoutSec: options.timeoutSec,
    maxBudgetUsd: options.maxBudgetUsd,
    pluginDir: options.catalog,
    query: options.query,
  });
}

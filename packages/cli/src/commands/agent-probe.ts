import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHomeContext } from "@ctk/probe";
import { runAgentProbe, type RunAgentProbeResult } from "@ctk/gen";
import { ensureAgentProbeCwd } from "../sealed-cwd.js";
import { createProbePluginDir, stageProbeCatalog, type ProbePluginDir } from "../probe-plugin-dir.js";
import { findSkillSource } from "./verify-ac3.js";
import { MissingRequiredFlagError } from "./gen.js";

/**
 * cli/src/commands/agent-probe.ts — `ctk agent-probe`(AC-3.3 전용 진단). **카탈로그·config에
 * 아무것도 쓰지 않는다** — `sync`를 전혀 호출하지 않고 stdout만 출력한다.
 *
 * ## `--catalog`의 의미 (안 B에서 바로잡음)
 *
 * 이 플래그는 원래 `--plugin-dir`로 그대로 넘어갔다. 이름은 "카탈로그"인데 실제로는 플러그인
 * 디렉터리였고, 그래서 **합성 카탈로그를 지정할 방법이 없었다** — 스킬이 카탈로그 루트를
 * `~/.config/ctk/config.json`에서 읽고 `HOME`은 인증 때문에 실제 홈이어야 하므로, 그대로
 * 띄우면 에이전트가 사용자의 **실제 카탈로그**를 뒤졌다.
 *
 * 이제 `--catalog`는 이름대로 **합성 카탈로그 루트**이고, 플러그인 디렉터리는 이 명령이
 * 임시로 만든다(`probe-plugin-dir.ts`) — 그 안에는 카탈로그 루트가 박힌 스킬 사본이 들어가고,
 * 사본은 프로덕션 원문과 **정확히 한 절**만 다르다.
 */

export interface RunAgentProbeCliOptions {
  /** 합성 카탈로그 루트(`catalog/index.json`을 담은 디렉터리의 부모). */
  catalog: string;
  /**
   * "이 로컬"로 삼을 머신 id. 프로덕션 스킬은 `~/.config/ctk/machine.json`에서 읽지만 진단은
   * `HOME`이 실제 홈이라 그 파일을 쓸 수 없어 사본에 박아 넣는다(3회차 실측).
   */
  machineId: string;
  query: string;
  maxBudgetUsd?: number;
  timeoutSec?: number;
  /** 스킬 원본 경로 직접 지정(비표준 배치용). 생략하면 저장소에서 찾는다. */
  skillPath?: string;
}

export interface AgentProbeCliResult extends RunAgentProbeResult {
  /** 사본이 원문과 다른 지점 — 무엇을 시험했는지 사용자가 알 수 있어야 한다. */
  replacedHeading: string;
  catalogRoot: string;
  machineId: string;
}

export async function runAgentProbeCli(options: RunAgentProbeCliOptions): Promise<AgentProbeCliResult> {
  if (options.maxBudgetUsd === undefined) throw new MissingRequiredFlagError("--max-budget-usd");
  if (options.timeoutSec === undefined) throw new MissingRequiredFlagError("--timeout-sec");

  const skillSourcePath =
    options.skillPath ?? findSkillSource(path.dirname(fileURLToPath(import.meta.url)));

  // 카탈로그를 **cwd 안으로** 옮긴 뒤 그 경로를 스킬 사본에 박는다. cwd 밖 경로는 헤드리스
  // 세션에서 Grep이 차단되고 Read가 승인 프롬프트를 띄우는데, 답할 사람이 없다(1회차 실측).
  const cwd = ensureAgentProbeCwd();
  const stagedCatalog = stageProbeCatalog(options.catalog, cwd);

  let probePlugin: ProbePluginDir | null = null;
  try {
    probePlugin = createProbePluginDir({
      skillSourcePath,
      catalogRoot: stagedCatalog,
      machineId: options.machineId,
    });
    const result = await runAgentProbe({
      home: resolveHomeContext(),
      cwd,
      timeoutSec: options.timeoutSec,
      maxBudgetUsd: options.maxBudgetUsd,
      pluginDir: probePlugin.pluginDir,
      query: options.query,
    });
    return {
      ...result,
      replacedHeading: probePlugin.skill.replacedHeading,
      catalogRoot: probePlugin.catalogRoot,
      machineId: options.machineId,
    };
  } finally {
    // 유료 세션이 실패해도 임시 디렉터리는 남기지 않는다.
    probePlugin?.cleanup();
  }
}

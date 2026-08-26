import { spawnClaudeAgentProbe, type HomeContext } from "@ctk/probe";
import { readEnvelopeCostUsd, readEnvelopeProvenance, type GenCallProvenance } from "./output-schema.js";

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
  /**
   * 진단에 쓸 모델. 생략하면 `PROBE_MODEL`이다.
   *
   * ⚠️ **모델을 고정하는 이유는 비용이 아니라 모집단이다.** 없으면 자식이 **사용자의 기본
   * 모델**을 쓰므로 진단 결과가 머신마다 달라지고, "지난번엔 통과했다"를 비교할 근거가
   * 사라진다 — 과거 AC-3.3 진단 4회가 어떤 모델이었는지 지금 **알 수 없는 것**이 그 증거다.
   * 다른 모델에서 재보고 싶으면 여기에 명시한다(결과에 어떤 모델로 쟀는지 함께 실린다).
   */
  model?: string;
  spawnFn?: typeof spawnClaudeAgentProbe;
}

/**
 * 진단 기준 모델. `GEN_MODEL`과 값은 같지만 **뜻이 다르다** — 그쪽은 "문서 생성에 충분한
 * 모델"이고 이쪽은 "스킬 발동을 재는 기준선"이다. 같은 상수를 쓰면 한쪽 사정으로 바꿀 때
 * 다른 쪽 판정 기준이 조용히 따라 움직인다.
 */
export const PROBE_MODEL = "sonnet";

export interface RunAgentProbeResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
  /**
   * 이 진단에 **실제로 나간 돈**. 읽지 못하면 `null`이고 **"0원"이 아니다**(안전 원칙 7).
   *
   * ⚠️ 이 필드가 없던 동안 `agent-probe`는 유료 실행인데 지출을 **어디에도** 남기지 않았다 —
   * `gen`은 중단돼도 run-log를 쓰는데(#24) 진단 경로만 0이었다. AC-3.3의 과거 유료 진단 4회
   * 지출도 그래서 지금 알 수 없다.
   */
  reportedCostUsd: number | null;
  /** 어떤 모델로 쟀는지. **결과와 함께 실어야 다음 진단과 비교할 수 있다**(안전 원칙 8). */
  provenance: GenCallProvenance;
  /** 요청한 모델. 봉투에서 읽은 `provenance.model`과 다르면 하네스가 다른 것을 태운 것이다. */
  requestedModel: string;
}

export async function runAgentProbe(options: RunAgentProbeOptions): Promise<RunAgentProbeResult> {
  const {
    home,
    cwd,
    timeoutSec,
    maxBudgetUsd,
    pluginDir,
    query,
    model = PROBE_MODEL,
    spawnFn = spawnClaudeAgentProbe,
  } = options;
  const result = await spawnFn({
    // `--output-format json`은 **비용을 얻기 위한 수단이다** — `claude -p`의 텍스트 출력에는
    // 지출이 실리지 않는다. 사람이 읽을 답변은 봉투에서 다시 꺼낸다.
    subcommand: [
      "-p",
      "--model",
      model,
      "--max-budget-usd",
      String(maxBudgetUsd),
      "--output-format",
      "json",
    ],
    home,
    cwd,
    timeoutSec,
    stdinPrompt: query,
    pluginDir,
  });
  return {
    stdout: `${AGENT_PROBE_WEAKER_SEAL_NOTICE}${readEnvelopeResultText(result.stdout)}`,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    // 실패한 호출에도 비용은 실려 온다 — 페이로드 검증과 분리해 읽는다(gen과 같은 규율).
    reportedCostUsd: readEnvelopeCostUsd(result.stdout),
    provenance: readEnvelopeProvenance(result.stdout),
    requestedModel: model,
  };
}

/**
 * 봉투에서 **사람이 읽을 답변**을 꺼낸다.
 *
 * ⚠️ **못 읽으면 원문을 그대로 돌려준다.** 진단은 에이전트가 무엇을 말했는지를 사람이 읽고
 * 판정하는 것이므로, 파싱이 안 됐다고 빈 문자열을 주면 **관측 자체가 사라진다**(안전 원칙 7 —
 * "없음"과 "실패"를 구분한다). 원문이 보이면 사용자가 무엇이 잘못됐는지 판단할 수 있다.
 */
export function readEnvelopeResultText(rawStdout: string): string {
  try {
    const parsed: unknown = JSON.parse(rawStdout);
    if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
      const value = (parsed as { result: unknown }).result;
      if (typeof value === "string") return value;
    }
    return rawStdout;
  } catch {
    return rawStdout;
  }
}

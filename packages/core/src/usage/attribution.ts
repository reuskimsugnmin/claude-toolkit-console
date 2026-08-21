import { SKILL_TOOL_NAME, isSubagentSpawnTool } from "./tool-names.js";
import type { AttributionSource } from "../schema/usage.js";

/**
 * core/src/usage/attribution.ts — §3 AC-4 귀속 규칙 표의 **순수 함수** 구현(P1-1). 트랜스크립트
 * I/O는 `probe/src/transcripts/{iterate,extract}.ts`가 담당하고, 이 모듈은 이미 추출된 한 건의
 * tool_use 이벤트를 받아 "누구에게 귀속되는가"만 판정한다(core는 I/O 없음, guard/* 판정기와 동형).
 *
 * **우선순위 3단 (계획 §3 AC-4 표 그대로):**
 * ① 트랜스크립트 최상위 `attribution*` 필드 직독 → `attribution_source: "harness_field"`
 *    (P6 — 하네스가 답을 주면 우리가 추측하지 않는다)
 * ② tool 이름 접두 규칙 → `attribution_source: "prefix_rule"`
 * ③ 판정 불가 → `attribution_source: "unattributed"`, target은 `null` (임의 배분 금지)
 *
 * **자산 id 해석의 한계 (문서화된 설계 선택 — executor 판단).** 이 함수가 반환하는 `ref`는
 * "최선의 식별자 문자열"이지 카탈로그 `Asset.id`로 이미 해석된 값이 아니다. 예:
 * `attributionPlugin` 필드는 실측상 marketplace 없는 **베어 이름**만 준다(`"superpowers"`),
 * 하지만 Asset.id 형식은 `name@marketplace`다(AC-0.3). 마켓플레이스 소거는 이 함수가 모르는
 * 카탈로그 상태(설치된 플러그인 목록)가 있어야 하므로, core의 순수 함수 경계 밖이다 — 호출자
 * (cli의 `measure`/`usage` 커맨드, 카탈로그를 이미 읽은 상태)가 `ref`를 알려진 Asset id 집합에
 * 대조해 최종 결정한다. 마찬가지로 `mcp__plugin_<...>__<tool>` 형태는 `<...>`이 `<plugin>_<server>`를
 * 밑줄로 이어붙인 것이라 일반적으로 분리 불가능하다(예: `plugin_chrome-devtools-mcp_chrome-devtools`
 * — 플러그인 이름 자체에 하이픈이 있어 경계를 정규식으로 확정할 수 없다, 실측). 이 함수는
 * 이어붙은 문자열 전체를 `ref`로 반환하고, 분리는 호출자가 알려진 플러그인 이름 집합과의
 * prefix/suffix 매칭으로 시도한다(있는 그대로 반환하는 것이 잘못된 분리보다 정직하다, CLAUDE.md
 * "실측으로 확인된 함정" 정신).
 */

export type AttributionTargetKind = "skill" | "plugin" | "mcp" | "agent" | "cli";

export interface AttributionResult {
  attribution_source: AttributionSource;
  /** 판정을 성립시킨 규칙 이름. UsageMetric.attribution_rule에 그대로 기록한다. */
  attribution_rule: string;
  kind: AttributionTargetKind | null;
  /** 최선의 식별자 문자열. 카탈로그 Asset.id로 완전히 해석된 값이 아닐 수 있다(위 주석). null이면
   * 귀속 불가(③) — 임의 배분하지 않는다(AC-4.7). */
  ref: string | null;
}

/** 트랜스크립트 행 최상위(또는 tool_use를 포함한 assistant 행)에서 직독한 attribution* 필드. */
export interface ExplicitAttributionFields {
  attributionSkill?: string;
  attributionPlugin?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  attributionAgent?: string;
}

export interface AttributionInput {
  toolName: string;
  toolInput: Record<string, unknown> | undefined;
  explicit: ExplicitAttributionFields | undefined;
}

const UNATTRIBUTED: AttributionResult = {
  attribution_source: "unattributed",
  attribution_rule: "none",
  kind: null,
  ref: null,
};

function fromExplicitFields(explicit: ExplicitAttributionFields | undefined): AttributionResult | null {
  if (explicit === undefined) return null;
  // 우선순위: skill > plugin > mcp_server > agent. 한 tool_use 행에 여러 필드가 동시에 실릴
  // 것으로 실측되진 않았지만(각 행은 하나의 tool_use), 방어적으로 순서를 고정한다.
  if (explicit.attributionSkill !== undefined && explicit.attributionSkill.length > 0) {
    return {
      attribution_source: "harness_field",
      attribution_rule: "harness_field:attributionSkill",
      kind: "skill",
      ref: explicit.attributionSkill,
    };
  }
  if (explicit.attributionPlugin !== undefined && explicit.attributionPlugin.length > 0) {
    return {
      attribution_source: "harness_field",
      attribution_rule: "harness_field:attributionPlugin",
      kind: "plugin",
      ref: explicit.attributionPlugin,
    };
  }
  if (explicit.attributionMcpServer !== undefined && explicit.attributionMcpServer.length > 0) {
    return {
      attribution_source: "harness_field",
      attribution_rule: "harness_field:attributionMcpServer",
      kind: "mcp",
      ref: explicit.attributionMcpServer,
    };
  }
  if (explicit.attributionAgent !== undefined && explicit.attributionAgent.length > 0) {
    return {
      attribution_source: "harness_field",
      attribution_rule: "harness_field:attributionAgent",
      kind: "agent",
      ref: explicit.attributionAgent,
    };
  }
  return null;
}

/**
 * `mcp__<server>__<tool>` / `mcp__plugin_<plugin_server>__<tool>` 접두 규칙. 실측(이 세션 자신의
 * 도구 이름들로 재확인, R13 대응): "__"(이중 밑줄)이 정확히 `mcp` / 서버-또는-플러그인 세그먼트 /
 * 도구명 세 부분을 가른다 — 세그먼트 내부의 단일 밑줄·하이픈은 이 분리에 영향을 주지 않는다.
 */
function fromMcpToolPrefix(toolName: string): AttributionResult | null {
  if (!toolName.startsWith("mcp__")) return null;
  const segments = toolName.split("__");
  const middle = segments[1];
  if (middle === undefined || middle.length === 0) return null;
  if (middle.startsWith("plugin_")) {
    const ref = middle.slice("plugin_".length);
    if (ref.length === 0) return null;
    return { attribution_source: "prefix_rule", attribution_rule: "prefix_rule:mcp_plugin_tool", kind: "plugin", ref };
  }
  return { attribution_source: "prefix_rule", attribution_rule: "prefix_rule:mcp_tool", kind: "mcp", ref: middle };
}

function fromSkillToolInput(toolInput: Record<string, unknown> | undefined): AttributionResult | null {
  const skillValue = toolInput?.skill;
  if (typeof skillValue !== "string" || skillValue.length === 0) return null;
  // classifySkillInput(tool-names.ts)은 plugin_qualified/bare_name 형태 구분만 한다 — 여기서는
  // ref로 원문을 그대로 쓴다(plugin:skill 형태면 호출자가 ":"로 나눠 marketplace 해석에 쓸 수 있다).
  // 형태 구분 자체가 필요한 호출자는 classifySkillInput(ref)를 직접 다시 부르면 된다(순수 함수라
  // 재계산 비용이 무시할 수준).
  return { attribution_source: "prefix_rule", attribution_rule: "prefix_rule:skill_tool_input", kind: "skill", ref: skillValue };
}

function fromAgentToolInput(toolName: string, toolInput: Record<string, unknown> | undefined): AttributionResult | null {
  if (!isSubagentSpawnTool(toolName)) return null;
  const subagentType = toolInput?.subagent_type;
  if (typeof subagentType !== "string" || subagentType.length === 0) return null;
  return { attribution_source: "prefix_rule", attribution_rule: "prefix_rule:agent_subagent_type", kind: "agent", ref: subagentType };
}

/**
 * 한 건의 tool_use 이벤트를 귀속한다. `toolName === SKILL_TOOL_NAME`이면 스킬 규칙을, mcp__ 접두면
 * MCP/플러그인 규칙을, 서브에이전트 스폰 도구면 에이전트 규칙을 시도한다 — 이 판정 자체는 순서가
 * 상호 배타적이므로(도구 이름 자체가 다르다) 어느 것을 먼저 시도해도 결과가 같다.
 */
export function attribute(input: AttributionInput): AttributionResult {
  const explicit = fromExplicitFields(input.explicit);
  if (explicit !== null) return explicit;

  if (input.toolName === SKILL_TOOL_NAME) {
    const bySkill = fromSkillToolInput(input.toolInput);
    if (bySkill !== null) return bySkill;
  }

  const byMcp = fromMcpToolPrefix(input.toolName);
  if (byMcp !== null) return byMcp;

  const byAgent = fromAgentToolInput(input.toolName, input.toolInput);
  if (byAgent !== null) return byAgent;

  // ⚠️ OQ-3 미결 — Bash 실행 파일명 매칭(CLI 자산 귀속)은 v1 범위에 명시적으로 넣지 않는다.
  // 계획 §3 AC-4 표의 CLI 항: "Bash 명령의 실행 파일명 매칭 — 이것만 휴리스틱이며
  // attribution_rule: bash_exec_heuristic으로 표기한다(v1 포함 여부는 OQ-3)". OQ-3은 계획서에
  // "☐ 미결"로 남아 있고 해소 지시가 Step 3에 있지만 사용자 결정이 필요한 질문이다 — 구현자가
  // 임의로 답을 내리지 않는다(CLAUDE.md 안전 원칙과 동형: 판정 불가는 추정으로 채우지 않는다).
  // CLI 자산의 call_count는 이 함수가 null(unattributed)을 반환해 정직하게 비워 둔다.

  return UNATTRIBUTED;
}

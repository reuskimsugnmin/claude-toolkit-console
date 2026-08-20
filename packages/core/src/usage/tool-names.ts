/**
 * 하네스 도구명 상수 — AC-0.6b 실측값(CLI 2.1.237, 2026-08-20, 표본 79,420 필드-보유 행)에서
 * 초기화한다. R13: **CLI 버전이 바뀌면 이 값들을 재실측 없이 신뢰하지 않는다.**
 * 원문 근거: spikes/results/AC-0.6b.md.
 */

/** 서브에이전트 스폰 도구명. 이 버전엔 `Agent`만 관측됐다 — 구버전 `Task`는 0건(신버전 상수만 사용). */
export const SUBAGENT_SPAWN_TOOL_NAMES = ["Agent"] as const;
export type SubagentSpawnToolName = (typeof SUBAGENT_SPAWN_TOOL_NAMES)[number];

export const SKILL_TOOL_NAME = "Skill" as const;

/** `Skill` tool_use의 `input.skill` 형태. 실측 분포: plugin_qualified 22 / bare_name 15. */
export type SkillInputForm = "plugin_qualified" | "bare_name";

export function classifySkillInput(skillInput: string): SkillInputForm {
  return skillInput.includes(":") ? "plugin_qualified" : "bare_name";
}

export function isSubagentSpawnTool(toolName: string): toolName is SubagentSpawnToolName {
  return (SUBAGENT_SPAWN_TOOL_NAMES as readonly string[]).includes(toolName);
}

/**
 * R17 — 같은 표본에서 `isSidechain:true`가 0건인데 `Agent` tool_use는 39~49회 관측됐다.
 * "서브에이전트 대화가 같은 파일에 isSidechain:true로 인라인된다"는 가정이 이 버전에서
 * 성립하지 않을 수 있다(`tasks/`·`session-env/`·`jobs/`·`daemon/` 서브시스템 발견, Step 3 재조사 대상).
 * 이 상수는 usage/attribution.ts(Step 3)가 "경로를 못 찾으면 조용히 0으로 떨어뜨리지 않고
 * unresolved로 남긴다"는 규약을 지킬 때 참조한다.
 */
export const SIDECHAIN_TRUE_OBSERVED_IN_AC0_6B = false;

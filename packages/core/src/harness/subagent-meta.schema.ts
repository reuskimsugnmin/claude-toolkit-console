import { z } from "zod";

/**
 * `<session-dir>/subagents/agent-<hash>.meta.json` — 서브에이전트 실행 1건의 사이드카 메타데이터.
 * 실측(2026-08-21, 실제 트랜스크립트): `{"agentType":"general-purpose","description":"...",
 * "toolUseId":"toolu_...","spawnDepth":1,"model":"sonnet"}`.
 *
 * **`toolUseId`가 부모 세션 파일의 `Agent` tool_use 블록 `id`와 일치한다** — 이 필드로 "이
 * 서브에이전트 파일이 어느 `Agent` 호출에서 나왔는가"를 역추적하고, R17이 요구하는 "Agent
 * tool_use 건수 대비 실제 귀속 건수 괴리" 대조의 근거가 된다(usage/attribution 크로스체크,
 * probe/transcripts에서 소비).
 */
export const SubagentMetaSchema = z
  .object({
    agentType: z.string().min(1),
    description: z.string().optional(),
    toolUseId: z.string().min(1),
    spawnDepth: z.number().int().nonnegative().optional(),
    model: z.string().optional(),
  })
  .passthrough();

export type SubagentMeta = z.infer<typeof SubagentMetaSchema>;

export function parseSubagentMeta(data: unknown): SubagentMeta {
  return SubagentMetaSchema.parse(data);
}

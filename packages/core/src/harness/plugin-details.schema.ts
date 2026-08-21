import { z } from "zod";

/**
 * `claude plugin details <id>`의 **파싱 결과** 스키마 (AC-0.5 실측, 2026-08-20).
 *
 * `--json` 옵션이 없다(R13 노출 큼 — 텍스트 파서가 문구 변경에 취약하다). 이 스키마는
 * 원문 텍스트가 아니라 probe의 (Step 2/3에서 구현할) 정규식 파서가 만들어낼 **구조화된 결과**의
 * 계약이다. `.strict()`로 고정해 파서 출력이 드리프트하면 즉시 실패하게 한다.
 */
export const PluginDetailsSchema = z
  .object({
    id: z.string().regex(/^[^@]+@[^@]+$/),
    version: z.string(),
    description: z.string().optional(),
    source: z.string(),
    components: z
      .object({
        skills: z.number().int().nonnegative(),
        agents: z.number().int().nonnegative(),
        hooks: z.number().int().nonnegative(),
        mcp_servers: z.number().int().nonnegative(),
        lsp_servers: z.number().int().nonnegative(),
      })
      .strict(),
    /**
     * "Projected token cost — Always-on". AC-0.5 실측: MCP는 "tool schemas resolved at runtime;
     * not counted", hooks는 "harness-only — no model context cost" — 둘 다 이 값에 반영 안 됨.
     * ctk idle 정의(usage/tool-names.ts 참조)와는 애초에 다른 두 정의라 "일치"를 기대하지 않는다
     * (AC-4.8 교차검증 설계의 근거).
     */
    projected_token_cost: z
      .object({
        always_on_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type PluginDetails = z.infer<typeof PluginDetailsSchema>;

export function parsePluginDetails(data: unknown): PluginDetails {
  return PluginDetailsSchema.parse(data);
}

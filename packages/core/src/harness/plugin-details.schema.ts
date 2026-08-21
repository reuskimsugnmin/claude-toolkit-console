import { z } from "zod";

/**
 * `claude plugin details <id>`의 **파싱 결과** 스키마 (AC-0.5 실측, 2026-08-20 · Step 3 재실측
 * 2026-08-21로 `version` 정정).
 *
 * `--json` 옵션이 없다(R13 노출 큼 — 텍스트 파서가 문구 변경에 취약하다). 이 스키마는
 * 원문 텍스트가 아니라 probe(Step 3, `sources/plugins.ts`)의 정규식 파서가 만들어낼 **구조화된
 * 결과**의 계약이다. `.strict()`로 고정해 파서 출력이 드리프트하면 즉시 실패하게 한다.
 *
 * ⚠️ **`version` 재실측 정정 — 필수에서 선택으로 변경.** AC-0.5 원 실측은 버전 문자열이 항상
 * 첫 줄에 실린다고 가정했으나, Step 3 실측(실제 `claude plugin details` 3건 — `context7`·
 * `frontend-design`·`oh-my-claudecode`)에서 **`context7`·`frontend-design`은 첫 줄에 버전이
 * 전혀 없었고**(`"context7"`만, `"oh-my-claudecode 4.15.7"`처럼 버전이 붙는 것과 대조), 문서에
 * 근거를 남기지 않고 결론으로 썼던 값이 틀렸다(CLAUDE.md "자동 스캐너는 부정문을 오독한다 —
 * 판정을 결론으로 쓰지 말고 원문을 확인한다"와 같은 계열의 함정, 이번엔 긍정 가정 오류).
 */
export const PluginDetailsSchema = z
  .object({
    id: z.string().regex(/^[^@]+@[^@]+$/),
    version: z.string().optional(),
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

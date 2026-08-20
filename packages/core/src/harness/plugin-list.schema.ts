import { z } from "zod";

/**
 * `claude plugin list --json` 출력 스키마 — AC-0.3 실측(2026-08-20, CLI 2.1.237)으로 정정된 버전.
 * 착수 조건 C1. 원문 근거: spikes/results/AC-0.3.md.
 *
 * plan의 최초 가정(8키 고정 셋)은 실측과 달랐다 — 계획의 가정이 틀린 것이지 하네스가 틀린 게 아니다
 * (§11 판정 표기 규칙). 실측 68/68 전부 이 스키마로 strict parse를 통과했다.
 *
 * - `mcpServers`는 선택 필드다 — MCP 서버가 없는 플러그인(예: bmad-*@bmad-method)엔 아예 없다.
 * - `projectPath`는 `scope==="local"`일 때만 존재하는 조건부 필드다. id 기준 "중복"으로 보이는
 *   엔트리는 실은 중복이 아니라 프로젝트별 local-scope 설치다(P1-13) — `projectPath`가 그 구분자다.
 */
export const PluginListEntrySchema = z
  .object({
    id: z.string().regex(/^[^@]+@[^@]+$/, "id는 name@marketplace 형식이어야 한다"),
    version: z.string(),
    scope: z.enum(["user", "project", "local"]),
    enabled: z.boolean(),
    installPath: z.string(),
    installedAt: z.string(), // ISO 8601
    lastUpdated: z.string(), // ISO 8601
    mcpServers: z.array(z.unknown()).optional(),
    projectPath: z.string().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    // 착수 조건 C1 — 단순 optional은 "local인데 경로 없음"을 조용히 통과시킨다. superRefine으로 강제.
    if (entry.scope === "local" && entry.projectPath == null) {
      ctx.addIssue({
        code: "custom",
        message: "scope=local requires projectPath",
        path: ["projectPath"],
      });
    }
  });

export type PluginListEntry = z.infer<typeof PluginListEntrySchema>;

export const PluginListSchema = z.array(PluginListEntrySchema);

export function parsePluginList(data: unknown): PluginListEntry[] {
  return PluginListSchema.parse(data);
}

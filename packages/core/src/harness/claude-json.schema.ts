import { z } from "zod";

/**
 * `~/.claude.json` 스키마 — probe/sources/mcp.ts가 쓰는 부분만 강제한다(AC-0.4ⓐⓑ 실측 형태).
 *
 * 실측(spikes/results/AC-0.4.md): 이 파일은 하네스 내부 상태(수십 개 키)를 담는 최상위 레지스트리다.
 * `.passthrough()`로 무관한 키를 통과시키고, MCP 소스로 쓰는 필드만 구조를 강제한다:
 * - 루트 `mcpServers` — user 스코프 MCP 서버 정의 (결정 7 · AC-0.4ⓐ)
 * - `projects.<path>.mcpServers` — 프로젝트별 로컬 MCP 서버 정의("local" install_scope로 매핑)
 * - `projects.<path>.{enabledMcpServers,disabledMcpServers}` — 프로젝트별 토글 이력(AC-0.4ⓑ①②)
 * - `projects.<path>.{enabledMcpjsonServers,disabledMcpjsonServers}` — AC-0.4ⓑ③ 판정불가
 *   (16개 프로젝트 전부 빈 배열, `mcp_state_unverified`로 남긴다). 구조만 파싱하고 값 해석은 하지 않는다.
 */
export const ClaudeJsonProjectEntrySchema = z
  .object({
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    enabledMcpServers: z.array(z.string()).optional(),
    disabledMcpServers: z.array(z.string()).optional(),
    enabledMcpjsonServers: z.array(z.string()).optional(),
    disabledMcpjsonServers: z.array(z.string()).optional(),
  })
  .passthrough();

export type ClaudeJsonProjectEntry = z.infer<typeof ClaudeJsonProjectEntrySchema>;

export const ClaudeJsonSchema = z
  .object({
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    projects: z.record(z.string(), ClaudeJsonProjectEntrySchema).optional(),
  })
  .passthrough();

export type ClaudeJsonFile = z.infer<typeof ClaudeJsonSchema>;

export function parseClaudeJsonFile(data: unknown): ClaudeJsonFile {
  return ClaudeJsonSchema.parse(data);
}

/** `<project>/.mcp.json` — project-local MCP 정의 파일 (결정 7 표의 ".mcp.json(project)" 출처). */
export const McpJsonFileSchema = z
  .object({
    mcpServers: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type McpJsonFile = z.infer<typeof McpJsonFileSchema>;

export function parseMcpJsonFile(data: unknown): McpJsonFile {
  return McpJsonFileSchema.parse(data);
}

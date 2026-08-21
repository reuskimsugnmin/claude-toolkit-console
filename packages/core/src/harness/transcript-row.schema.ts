import { z } from "zod";

/**
 * 세션 트랜스크립트(`~/.claude/projects/*.jsonl`) 행 스키마 — AC-0.6b 실측(2026-08-20, CLI 2.1.237,
 * 표본 30/285파일·18,761행) 기반. 원문 근거: spikes/results/AC-0.6b.md.
 *
 * **범위 결정 (R13 트레이드오프).** 트랜스크립트 행은 `type`별로 필드 구성이 크게 다르다(실측
 * 분포: queue-operation·user·attachment·last-prompt·ai-title·assistant·mode·permission-mode·
 * bridge-session·system·file-history-snapshot·file-history-delta·pr-link·atis-latch·relocated·
 * worktree-state — 16종). 행 전체를 `.strict()`로 고정하면 우리가 모르는 필드가 하나만 추가돼도
 * 파서가 즉시 깨진다. 그래서 **usage 파싱이 실제로 의존하는 필드만 strict로 고정**하고
 * (`type`·`isSidechain`·`toolUseResult`의 존재 여부·`message.content[]`의 tool_use/tool_result
 * 블록), 나머지 행 필드는 `.passthrough()`로 남긴다 — R13은 "우리가 의존하는 계약이 깨지면 즉시
 * 안다"는 뜻이지 "모든 필드를 다 안다"는 뜻이 아니다.
 */
export const TranscriptRowTypeSchema = z.enum([
  "user",
  "assistant",
  "system",
  "attachment",
  "queue-operation",
  "last-prompt",
  "ai-title",
  "mode",
  "permission-mode",
  "bridge-session",
  "file-history-snapshot",
  "file-history-delta",
  "pr-link",
  "atis-latch",
  "relocated",
  "worktree-state",
]);
export type TranscriptRowType = z.infer<typeof TranscriptRowTypeSchema>;

/** Anthropic Messages API 표준 tool_result 콘텐츠 블록. AC-0.6b: type:"user" 행 안에 나타난다. */
export const ToolResultContentBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string().optional(),
  })
  .passthrough();

/**
 * tool_use 콘텐츠 블록. `name`이 usage/tool-names.ts의 상수와 일치해야 귀속이 성립한다.
 * `Skill` tool_use의 `input.skill`은 "plugin:skill" 또는 "bare-name" 두 형태로 관측됐다(AC-0.6b ⓓ).
 */
export const ToolUseContentBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const MessageContentBlockSchema = z.union([
  ToolResultContentBlockSchema,
  ToolUseContentBlockSchema,
  z.unknown(),
]);

/**
 * 행 envelope. `toolUseResult`(레거시/보조 표현)와 `message.content[]`의 tool_result 블록(표준
 * 표현)이 **공존**한다(AC-0.6b ⓐ, 각 1,742건 실측) — 파서는 양쪽을 다 봐야 계수 누락이 없다.
 */
export const TranscriptRowSchema = z
  .object({
    type: TranscriptRowTypeSchema,
    /** user/assistant/system/attachment 행에만 존재 (AC-0.6b ⓑ). 실측 표본에서 true 0건 — 서브에이전트
     * 귀속 경로가 이 필드만으로는 해소되지 않을 수 있다 (R17, usage/tool-names.ts 참조) */
    isSidechain: z.boolean().optional(),
    toolUseResult: z.unknown().optional(),
    message: z
      .object({
        content: z.array(MessageContentBlockSchema).optional(),
      })
      .passthrough()
      .optional(),
    attributionSkill: z.string().optional(),
    attributionPlugin: z.string().optional(),
    attributionMcpServer: z.string().optional(),
    attributionMcpTool: z.string().optional(),
  })
  .passthrough();

export type TranscriptRow = z.infer<typeof TranscriptRowSchema>;

export function parseTranscriptRow(data: unknown): TranscriptRow {
  return TranscriptRowSchema.parse(data);
}

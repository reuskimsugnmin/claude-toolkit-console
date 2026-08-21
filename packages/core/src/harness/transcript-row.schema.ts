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
 * `message.usage` — assistant 행에만 실린다. **AC-0.7 실측 정정: `input_tokens`는 유저 턴 토큰일
 * 뿐 세션 초기 컨텍스트의 대리값이 아니다**(실측 `input_tokens = 2`). 점유 근사에는
 * `cache_creation_input_tokens`(콜드) / `cache_read_input_tokens`(재사용)를 쓴다 — **캐시 재사용
 * 시 서로 다른 구성이 같은 수치로 보이므로 구성 간 비교는 콜드 캐시에서만 유효하다**(§4 Step 3
 * 지시사항 그대로). 실측 원문(`docs/harness-facts.md` 갱신, 2026-08-21)에는 `cache_creation`
 * (ephemeral_5m/1h 세부값)·`service_tier`·`inference_geo` 등도 실리지만 우리가 쓰는 4키만
 * 구조를 강제하고 나머지는 `.passthrough()`로 흘린다(R13).
 */
export const MessageUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/**
 * 행 envelope. `toolUseResult`(레거시/보조 표현)와 `message.content[]`의 tool_result 블록(표준
 * 표현)이 **공존**한다(AC-0.6b ⓐ, 각 1,742건 실측) — 파서는 양쪽을 다 봐야 계수 누락이 없다.
 *
 * **Step 3 실측 정정(harness-facts.md 갱신, 2026-08-21) — `attributionAgent`/`agentId`.**
 * 서브에이전트 트랜스크립트(`<session-dir>/subagents/agent-<hash>.jsonl`)의 assistant 행에
 * `attributionAgent`(스폰된 에이전트 자산 id, 예: `"general-purpose"`·`"oh-my-claudecode:critic"`)와
 * `agentId`(같은 실행을 묶는 불투명 식별자)가 실린다 — 넷째 귀속 필드다.
 */
export const TranscriptRowSchema = z
  .object({
    type: TranscriptRowTypeSchema,
    /** user/assistant/system/attachment 행에만 존재 (AC-0.6b ⓑ). 메인 세션 파일에서는 true가
     * 관측되지 않는다(R17 — 서브에이전트 대화는 별도 파일에 있다, subagents 디렉터리 실측 참조).
     * 서브에이전트 파일 자체의 행에는 true로 실린다. */
    isSidechain: z.boolean().optional(),
    toolUseResult: z.unknown().optional(),
    message: z
      .object({
        // ⚠️ Step 3 실측 정정(2026-08-21, 실제 트랜스크립트 — `-claude-toolkit-ops` 프로젝트,
        // 562행 중 5건에서 재현) — type:"user" 행 중 **사람이 직접 입력한 평문 프롬프트**는
        // `message.content`가 블록 배열이 아니라 **문자열 그대로**다(Anthropic Messages API의
        // 표준 단축형 — 대부분의 user 턴이 이 형태다, tool_result가 있을 때만 배열 형태). 배열만
        // 허용했던 원 스키마는 이 형태의 모든 행을 통째로 parse 실패시켰다(R13 — 하네스 필드
        // 구조가 계획의 가정보다 컸다).
        content: z.union([z.string(), z.array(MessageContentBlockSchema)]).optional(),
        usage: MessageUsageSchema.optional(),
      })
      .passthrough()
      .optional(),
    sessionId: z.string().optional(),
    timestamp: z.string().optional(),
    /** 프로젝트 절대경로(실측) — 트랜스크립트 파일이 놓인 디렉터리명 디코딩보다 신뢰할 수 있는
     * 출처다(디렉터리명은 "/"→"-" 치환이라 원본 경로에 "-"가 있으면 손실 인코딩이 된다). */
    cwd: z.string().optional(),
    attributionSkill: z.string().optional(),
    attributionPlugin: z.string().optional(),
    attributionMcpServer: z.string().optional(),
    attributionMcpTool: z.string().optional(),
    attributionAgent: z.string().optional(),
    agentId: z.string().optional(),
  })
  .passthrough();

export type TranscriptRow = z.infer<typeof TranscriptRowSchema>;

export function parseTranscriptRow(data: unknown): TranscriptRow {
  return TranscriptRowSchema.parse(data);
}

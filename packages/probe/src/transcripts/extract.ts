import type { ExplicitAttributionFields, TranscriptRow } from "@ctk/core";

/**
 * probe/src/transcripts/extract.ts — 행 종류별 추출기(plan §4 Step 3). `iterate.ts`가 스트리밍으로
 * 내주는 `TranscriptRow` 하나를 받아 usage 파싱이 실제로 쓰는 형태로 정규화한다. I/O 없음 — 순수
 * 변환이지만, `TranscriptRow`(core 타입)에 강하게 의존하므로 core를 아는 probe 계층에 둔다
 * (attribution 판정 자체는 core/usage/attribution.ts의 순수 함수가 한다 — 여기는 입력 정리만).
 */

export interface ExtractedToolUse {
  toolUseId: string | undefined;
  toolName: string;
  toolInput: Record<string, unknown> | undefined;
  explicit: ExplicitAttributionFields;
}

export interface ExtractedToolResult {
  toolUseId: string | undefined;
  /** count_tokens 대상 텍스트. AC-4.3 측정 정의(`tool_result_payload_count_tokens_v1`)의 입력. */
  text: string;
}

export interface ExtractedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ExtractedRow {
  sessionId: string | null;
  timestamp: string | null;
  /** `cwd` 필드 실측값 — 디렉터리명 디코딩보다 신뢰할 수 있는 프로젝트 경로 출처. */
  projectPath: string | null;
  isSidechain: boolean;
  toolUses: ExtractedToolUse[];
  toolResults: ExtractedToolResult[];
  usage: ExtractedUsage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * tool_result 콘텐츠에서 텍스트를 최선으로 복원한다. Anthropic API 표준상 `content`는 문자열이거나
 * `{type:"text", text: string}` 블록 배열일 수 있다 — 그 외 형태(구조화 객체 등)는 JSON 직렬화로
 * 대체한다(무엇을 쟀는지 재현 가능해야 한다는 CLAUDE.md 원칙 — 근사가 필요하면 근사임을 숨기지
 * 않는다. 이 함수 자체가 이미 "measurement definition"의 일부이므로 새 분기를 추가할 때는
 * usage.ts의 `TOKEN_SUM_DEFINITION_V1` 버전을 올려야 한다).
 *
 * ⚠️ **알려진 한계(문서화 — 실제 트랜스크립트 관측).** 대형 tool_result는 하네스가 본문을 잘라
 * `<persisted-output>... Full output saved to: <절대경로>...`로 치환하고 실제 페이로드를
 * `tool-results/*.txt` 파일에 별도 저장한다(실측, 2026-08-21). 이 함수는 **트랜스크립트에 실제로
 * 실린 텍스트만** 측정한다 — 외부 persisted-output 파일을 열어 원문을 복원하지 않는다. 그 파일
 * 경로 자체가 홈 절대경로 원문이라(AC-1.7 위생 규칙 대상) 안일하게 읽고 그 파일명을 레코드에
 * 남기면 유출 위험이 생기고, 원문을 읽어 들이는 것은 이 Step의 범위(트랜스크립트 파싱)를 넘는
 * 별도 기능이다. 즉 대형 출력을 낸 호출의 `token_sum` 기여분은 실제보다 작게(치환 문구+미리보기
 * 2KB 수준으로) 잡힌다 — v1의 정직한 한계로 최종 보고서에 남긴다.
 */
function extractTextFromToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (isRecord(block) && typeof block.text === "string") return block.text;
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content === undefined) return "";
  return JSON.stringify(content);
}

function explicitFieldsOf(row: TranscriptRow): ExplicitAttributionFields {
  return {
    attributionSkill: row.attributionSkill,
    attributionPlugin: row.attributionPlugin,
    attributionMcpServer: row.attributionMcpServer,
    attributionMcpTool: row.attributionMcpTool,
    attributionAgent: row.attributionAgent,
  };
}

export function extractRow(row: TranscriptRow): ExtractedRow {
  const toolUses: ExtractedToolUse[] = [];
  const toolResults: ExtractedToolResult[] = [];
  let usage: ExtractedUsage | null = null;

  const explicit = explicitFieldsOf(row);

  if (row.type === "assistant" && row.message?.content !== undefined) {
    for (const block of row.message.content) {
      if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
        const input = isRecord(block.input) ? block.input : undefined;
        toolUses.push({
          toolUseId: typeof block.id === "string" ? block.id : undefined,
          toolName: block.name,
          toolInput: input,
          explicit,
        });
      }
    }
    if (row.message.usage !== undefined) {
      usage = {
        input_tokens: row.message.usage.input_tokens,
        output_tokens: row.message.usage.output_tokens,
        cache_creation_input_tokens: row.message.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: row.message.usage.cache_read_input_tokens ?? 0,
      };
    }
  }

  if (row.type === "user") {
    // AC-0.6b ⓐ — toolUseResult(레거시)와 message.content[]의 tool_result 블록(표준)이 같은 행에
    // 공존한다(같은 이벤트의 두 표현, 1,742=1,742 실측). 표준 표현이 있으면 그것만 쓰고, 없을 때만
    // 레거시로 폴백한다 — 둘 다 더하면 같은 결과를 두 번 세어 token_sum이 부풀려진다.
    let usedStandardForm = false;
    if (row.message?.content !== undefined) {
      for (const block of row.message.content) {
        if (isRecord(block) && block.type === "tool_result") {
          usedStandardForm = true;
          toolResults.push({
            toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
            text: extractTextFromToolResultContent(block.content),
          });
        }
      }
    }
    if (!usedStandardForm && row.toolUseResult !== undefined) {
      toolResults.push({ toolUseId: undefined, text: extractTextFromToolResultContent(row.toolUseResult) });
    }
  }

  return {
    sessionId: row.sessionId ?? null,
    timestamp: row.timestamp ?? null,
    projectPath: row.cwd ?? null,
    isSidechain: row.isSidechain ?? false,
    toolUses,
    toolResults,
    usage,
  };
}

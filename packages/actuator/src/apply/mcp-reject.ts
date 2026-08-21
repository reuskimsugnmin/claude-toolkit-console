/**
 * actuator/src/apply/mcp-reject.ts — MCP·CLI 자산에 대한 이관 요청은 명시적으로 거부한다
 * (AC-2.9). 거부 메시지 문구는 OQ-7 안 C로 확정됐다 — 그대로 쓴다(재서술 금지, 문자열 동일성이
 * 검사 대상).
 *
 * 이 함수는 **어떤 파일도 읽거나 쓰지 않는다** — kind 판정만으로 즉시 던진다. 호출자(cli
 * move.ts)가 이 오류를 exit code ≠ 0으로 변환한다.
 */

export const MCP_MOVE_REJECTED_MESSAGE = "v1 미지원 — MCP는 상태 조회만 가능합니다. 변경은 /mcp로 하세요." as const;

export class McpMoveRejectedError extends Error {
  constructor() {
    super(MCP_MOVE_REJECTED_MESSAGE);
    this.name = "McpMoveRejectedError";
  }
}

export class CliToolMoveUnsupportedError extends Error {
  constructor() {
    super("v1 미지원 — CLI 도구는 PATH 기반이라 이관 개념이 없습니다(상시 토큰 0).");
    this.name = "CliToolMoveUnsupportedError";
  }
}

/** `kind`가 "mcp"/"cli"면 즉시 거부한다. "plugin"/"skill"만 통과시킨다. */
export function assertMovableAssetKind(kind: "plugin" | "skill" | "mcp" | "cli"): asserts kind is "plugin" | "skill" {
  if (kind === "mcp") throw new McpMoveRejectedError();
  if (kind === "cli") throw new CliToolMoveUnsupportedError();
}

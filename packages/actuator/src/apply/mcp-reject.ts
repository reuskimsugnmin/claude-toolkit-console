import type { AssetKind } from "@ctk/core";

/**
 * actuator/src/apply/mcp-reject.ts — MCP·CLI·번들 자식(agent/command) 자산에 대한 이관 요청은
 * 명시적으로 거부한다(AC-2.9). MCP 거부 메시지 문구는 OQ-7 안 C로 확정됐다 — 그대로 쓴다
 * (재서술 금지, 문자열 동일성이 검사 대상).
 *
 * 이 함수는 **어떤 파일도 읽거나 쓰지 않는다** — kind 판정만으로 즉시 던진다. 호출자(cli
 * move.ts)가 이 오류를 exit code ≠ 0으로 변환한다.
 *
 * ⚠️ **B1 Step 2 — 파라미터를 손으로 베낀 4-리터럴 유니온에서 `AssetKind`로 교체했다.** 전에는
 * `AssetKindSchema`가 값을 얻어도 이 함수의 시그니처가 따로 놀 수 있었다(우연히 맞았을 뿐). 지금은
 * `AssetKind`를 참조하므로 호출부가 자동으로 넓은 타입을 받되, 판정 자체(`classifyMoveRejection`)는
 * **exhaustive switch + 반환형에 undefined 없음**이라 새 kind가 늘어나면 이 파일이 컴파일에서
 * 깨진다(선례: `gen/src/source-resolve.ts`).
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

/** `agent`·`command`는 부모 플러그인에 종속된 번들 자식이라(D2) 독립적으로 이관할 개념이 없다. */
export class BundledAssetMoveUnsupportedError extends Error {
  constructor(kind: "agent" | "command") {
    super(`v1 미지원 — ${kind}는 부모 플러그인에 종속된 번들 자식이라 독립적으로 이관할 수 없습니다.`);
    this.name = "BundledAssetMoveUnsupportedError";
  }
}

type MoveRejectionReason = "mcp" | "cli" | "bundled_child" | null;

/**
 * `kind`별 이관 거부 사유를 판정한다. **exhaustive switch, no default, 반환형에 undefined 없음**
 * — 이 판정이 이 파일의 유일한 관문이고, `AssetKind`에 새 값이 늘어나면 여기서 컴파일이 깬다.
 */
function classifyMoveRejection(kind: AssetKind): MoveRejectionReason {
  switch (kind) {
    case "plugin":
    case "skill":
      return null;
    case "mcp":
      return "mcp";
    case "cli":
      return "cli";
    case "agent":
    case "command":
      return "bundled_child";
  }
}

/** `kind`가 "mcp"/"cli"/"agent"/"command"면 즉시 거부한다. "plugin"/"skill"만 통과시킨다. */
export function assertMovableAssetKind(kind: AssetKind): asserts kind is "plugin" | "skill" {
  const reason = classifyMoveRejection(kind);
  if (reason === "mcp") throw new McpMoveRejectedError();
  if (reason === "cli") throw new CliToolMoveUnsupportedError();
  if (reason === "bundled_child") throw new BundledAssetMoveUnsupportedError(kind as "agent" | "command");
}

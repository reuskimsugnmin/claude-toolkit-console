import { z } from "zod";
import { InstallScopeSchema } from "./installation.js";

/**
 * core/src/schema/web-action.ts — Step 6b 액션 API의 요청 계약 (R6).
 *
 * **자유 문자열이 액션 인자로 들어갈 자리를 스키마에서 없앤다.** 프로젝트 대상은 경로가 아니라
 * **서버가 이미 스캔해 둔 목록의 인덱스**로만 지정한다 — 경로를 받으면 그 문자열이 결국
 * 파일시스템에 닿고, 이 저장소는 이미 그 형태의 취약점을 한 번 겪었다(`name: ../../evil`).
 * `--catalog` 같은 경로 인자는 웹 표면에 아예 노출하지 않는다.
 *
 * `.strict()`라 모르는 키가 하나라도 오면 파싱이 실패한다 — 화이트리스트 밖 파라미터가
 * 조용히 무시되는 대신 400이 된다.
 */

/** v1 웹에서 실행 가능한 액션. 이 목록 밖은 존재하지 않는다(F6). */
export const WebActionNameSchema = z.enum(["scan", "rollback", "move", "gen_estimate", "gen_execute"]);
export type WebActionName = z.infer<typeof WebActionNameSchema>;

/** `ctk scan`은 파라미터가 없다 — `--label`은 서버가 생성한다. */
const ScanActionSchema = z.object({ action: z.literal("scan") }).strict();

/** v1 롤백은 `--last` 하나뿐이다(임의 journal id 지정은 범위 밖). */
const RollbackActionSchema = z.object({ action: z.literal("rollback") }).strict();

/**
 * 이관. `to`/`from`은 열거값이고 프로젝트는 **인덱스**다.
 *
 * 인덱스가 실제 목록 범위 안인지는 스키마가 알 수 없다(목록은 런타임 상태다) — 그 판정은
 * 핸들러가 하고 `project_index_out_of_range`로 거부한다. 스키마는 "정수이고 음수가 아니다"까지만
 * 책임진다. 두 검사를 한쪽으로 뭉뚱그리지 않는다.
 */
const MoveActionSchema = z
  .object({
    action: z.literal("move"),
    asset_id: z.string().min(1),
    to: InstallScopeSchema.exclude(["local"]),
    to_project_index: z.number().int().nonnegative().optional(),
    from: InstallScopeSchema.exclude(["local"]).optional(),
    from_project_index: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * `gen`의 파라미터는 **수치 둘뿐**이며 둘 다 서버 최대치로 클램프된다.
 * `--catalog`·`--query` 같은 경로·자유 문자열은 웹에 노출하지 않는다.
 */
const GenParamsShape = {
  max_assets: z.number().int().positive().optional(),
  max_budget_usd: z.number().positive(),
} as const;

const GenEstimateActionSchema = z.object({ action: z.literal("gen_estimate"), ...GenParamsShape }).strict();

/**
 * 실행에는 **estimate가 발급한 토큰**이 필요하다(F6 2-phase). 토큰 없이 온 execute는 400이며,
 * 이 규칙이 "승인 없이는 어떤 API 호출도 일어나지 않는다"(전역 CLAUDE.md 비용 규칙)의 강제 수단이다.
 */
const GenExecuteActionSchema = z
  .object({ action: z.literal("gen_execute"), estimate_token: z.string().min(1), ...GenParamsShape })
  .strict();

export const WebActionRequestSchema = z.discriminatedUnion("action", [
  ScanActionSchema,
  RollbackActionSchema,
  MoveActionSchema,
  GenEstimateActionSchema,
  GenExecuteActionSchema,
]);

export type WebActionRequest = z.infer<typeof WebActionRequestSchema>;
export type MoveActionRequest = z.infer<typeof MoveActionSchema>;
export type GenEstimateActionRequest = z.infer<typeof GenEstimateActionSchema>;
export type GenExecuteActionRequest = z.infer<typeof GenExecuteActionSchema>;

export function parseWebActionRequest(data: unknown): WebActionRequest {
  return WebActionRequestSchema.parse(data);
}

/**
 * 서버가 강제하는 상한. 웹 버튼은 **사용자가 보지 않는 시점**에 유료 세션을 띄울 수 있는
 * 표면이므로(nightly·연타), 클라이언트가 보낸 값을 그대로 믿지 않고 여기서 자른다.
 */
export const WEB_GEN_MAX_BUDGET_USD = 2 as const;
export const WEB_GEN_MAX_ASSETS = 25 as const;

export interface ClampedGenParams {
  maxAssets: number;
  maxBudgetUsd: number;
  /** 요청값이 상한에 걸려 줄어들었는가 — 화면이 "요청한 대로 돌았다"고 오해하지 않게 알린다. */
  clamped: boolean;
}

export function clampGenParams(request: { max_assets?: number | undefined; max_budget_usd: number }): ClampedGenParams {
  const requestedAssets = request.max_assets ?? WEB_GEN_MAX_ASSETS;
  const maxAssets = Math.min(requestedAssets, WEB_GEN_MAX_ASSETS);
  const maxBudgetUsd = Math.min(request.max_budget_usd, WEB_GEN_MAX_BUDGET_USD);
  return { maxAssets, maxBudgetUsd, clamped: maxAssets !== requestedAssets || maxBudgetUsd !== request.max_budget_usd };
}

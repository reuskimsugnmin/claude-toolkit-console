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
  /**
   * **이 승인 1회로 지출할 총액 상한.** 호출당 상한이 아니다.
   *
   * ⚠️ 처음에는 `max_budget_usd`라는 이름으로 받아 그대로 `runGen`에 넘겼는데, `runGen`의
   * 그 인자는 **호출당** 상한이고 자산 1건마다 `claude -p`가 1회 돈다. 승인 화면에는 $2가
   * 뜨는데 자산 25건이면 실제 상한은 $50이었다(보안 심사 H2). 이름을 총액으로 바꾸고
   * 호출당 값은 여기서 나눠 계산한다 — 사용자가 승인하는 숫자와 실제 상한이 같아야 한다.
   */
  max_total_usd: z.number().positive(),
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
/** 승인 1회로 지출할 수 있는 **총액** 상한. 호출당 상한이 아니다. */
export const WEB_GEN_MAX_TOTAL_USD = 2 as const;
export const WEB_GEN_MAX_ASSETS = 25 as const;

export interface ClampedGenParams {
  maxAssets: number;
  /** 승인 1회의 총 지출 상한 — 사용자가 화면에서 승인하는 숫자다. */
  maxTotalUsd: number;
  /** 요청값이 상한에 걸려 줄어들었는가 — 화면이 "요청한 대로 돌았다"고 오해하지 않게 알린다. */
  clamped: boolean;
}

export function clampGenParams(request: { max_assets?: number | undefined; max_total_usd: number }): ClampedGenParams {
  const requestedAssets = request.max_assets ?? WEB_GEN_MAX_ASSETS;
  const maxAssets = Math.min(requestedAssets, WEB_GEN_MAX_ASSETS);
  const maxTotalUsd = Math.min(request.max_total_usd, WEB_GEN_MAX_TOTAL_USD);
  return { maxAssets, maxTotalUsd, clamped: maxAssets !== requestedAssets || maxTotalUsd !== request.max_total_usd };
}

/**
 * 총액 상한을 실제 호출 수로 나눠 **호출당** 상한을 만든다 — `runGen`이 받는 값이 이것이다.
 *
 * `callCount`는 dry-run이 센 실제 대상 자산 수다. 상한(`maxAssets`)이 아니라 실제 수로 나눠야
 * 자산이 적을 때 불필요하게 작은 호출당 예산이 걸리지 않는다. 실행 시점에는 이 `callCount`를
 * `maxAssets`로 되꽂아 총액이 그대로 유지된다.
 */
export function toPerCallBudgetUsd(maxTotalUsd: number, callCount: number): number {
  return maxTotalUsd / Math.max(callCount, 1);
}

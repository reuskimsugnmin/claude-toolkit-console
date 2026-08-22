import { randomBytes, timingSafeEqual } from "node:crypto";
import { ActionError, type ActionHandlers } from "@ctk/web";
import { LockContendedError } from "@ctk/sync";
import { runScan } from "./scan.js";
import { runMove, ProjectIndexOutOfRangeError } from "./move.js";
import { runRollback } from "./rollback.js";
import { runGenCli, runGenDryRun } from "./gen.js";

/**
 * cli/src/commands/web-actions.ts — Step 6b 합성 루트. **웹이 열 수 있는 조작은 여기 적힌 것뿐이다.**
 *
 * `web/server`는 `actuator`를 import하지 않는다(계층 lint). 웹에서 무언가를 실행하려면 반드시
 * 이 파일에 핸들러가 추가돼야 하고, 그래서 "웹이 무엇을 할 수 있는가"의 답이 한 파일에 모인다 —
 * 셸 조합 경로도, 동적 디스패치도 없다.
 *
 * 여기서 하는 일은 세 가지뿐이다: ⓐ 기존 CLI 명령을 그대로 호출하고 ⓑ 그쪽이 던진 실패를
 * 웹 상태 코드로 **분류**하고 ⓒ `gen`의 2-phase 토큰을 관리한다. 새 조작을 만들지 않는다 —
 * 웹 버튼과 CLI가 같은 코드를 타야 "버튼이 CLI와 같은 결과를 낸다"가 성립한다.
 */

/** 기동 시 1회 생성해 메모리에만 두는 세션 토큰. 파일·로그에 남기지 않는다. */
export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * `gen` 2-phase의 estimate 토큰 보관소.
 *
 * ⚠️ **토큰은 파라미터에 묶인다.** 싸게 견적내고 비싸게 실행하는 것을 막으려면 발급 시점의
 * `maxAssets`/`maxBudgetUsd`를 함께 기억하고 실행 요청과 대조해야 한다. 토큰만 대조하면
 * "승인받은 비용"과 "실제 지출"이 갈린다.
 *
 * 1회용이다 — 쓰면 사라진다. 버튼 연타로 같은 승인이 두 번 실행되지 않는다.
 */
export class EstimateTokenStore {
  private readonly issued = new Map<string, { maxAssets: number; maxBudgetUsd: number; issuedAt: number }>();

  /** 승인 화면을 열어둔 채 오래 두면 그 사이 카탈로그가 바뀐다 — 견적이 낡으면 다시 받는다. */
  constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  issue(params: { maxAssets: number; maxBudgetUsd: number }, now = Date.now()): string {
    const token = randomBytes(24).toString("base64url");
    this.issued.set(token, { ...params, issuedAt: now });
    return token;
  }

  /**
   * 토큰을 소비하고 발급 시점 파라미터를 돌려준다. 없거나·만료됐거나·파라미터가 다르면
   * `null`이다 — 어느 경우인지 호출자에게 구분해 알리지 않는다(탐색 단서가 된다).
   */
  consume(token: string, params: { maxAssets: number; maxBudgetUsd: number }, now = Date.now()): boolean {
    const found = this.findConstantTime(token);
    if (found === null) return false;
    this.issued.delete(found.key);
    if (now - found.value.issuedAt > this.ttlMs) return false;
    return found.value.maxAssets === params.maxAssets && found.value.maxBudgetUsd === params.maxBudgetUsd;
  }

  /** 존재 여부를 타이밍으로 흘리지 않는다 — 모든 항목을 상수 시간으로 비교한다. */
  private findConstantTime(token: string): { key: string; value: { maxAssets: number; maxBudgetUsd: number; issuedAt: number } } | null {
    const candidate = Buffer.from(token, "utf8");
    let hit: { key: string; value: { maxAssets: number; maxBudgetUsd: number; issuedAt: number } } | null = null;
    for (const [key, value] of this.issued) {
      const known = Buffer.from(key, "utf8");
      if (known.length === candidate.length && timingSafeEqual(known, candidate)) hit = { key, value };
    }
    return hit;
  }
}

/**
 * CLI가 던지는 실패를 웹 상태 코드로 분류한다. **분류되지 않은 예외는 500으로 남긴다** —
 * 여기서 넓게 잡아 400으로 바꾸면 서버 결함이 사용자 입력 오류로 보고된다.
 */
function toActionError(err: unknown): unknown {
  if (err instanceof LockContendedError) return new ActionError("lock_contended", err.message);
  if (err instanceof ProjectIndexOutOfRangeError) return new ActionError("project_index_out_of_range", err.message);
  return err;
}

async function rethrowClassified<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toActionError(err);
  }
}

export interface CreateActionHandlersOptions {
  estimates?: EstimateTokenStore;
  /** `gen` 실행에 필수인 벽시계 상한(초). 웹에서 자유 문자열로 받지 않고 서버가 고정한다. */
  genTimeoutSec?: number;
}

export function createActionHandlers(options: CreateActionHandlersOptions = {}): ActionHandlers {
  const estimates = options.estimates ?? new EstimateTokenStore();
  const timeoutSec = options.genTimeoutSec ?? 300;

  return {
    scan: () => rethrowClassified(() => runScan()),

    rollback: () => rethrowClassified(() => runRollback({ last: true })),

    move: (request) =>
      rethrowClassified(() =>
        runMove({
          assetId: request.asset_id,
          to: request.to,
          ...(request.to_project_index === undefined ? {} : { toProjectIndex: request.to_project_index }),
          ...(request.from === undefined ? {} : { from: request.from }),
          ...(request.from_project_index === undefined ? {} : { fromProjectIndex: request.from_project_index }),
        }),
      ),

    // ⓐ dry-run 경로를 그대로 쓴다 — 동기 함수이며 API 호출도 서브프로세스 spawn도 하지 않는다(AC-3.8).
    genEstimate: async (params) => {
      const data = await rethrowClassified(async () => runGenDryRun({ maxAssets: params.maxAssets }));
      return {
        estimateToken: estimates.issue(params),
        // 승인 화면이 보여줄 값에 **적용될 상한**을 함께 싣는다 — 사용자가 승인하는 것은
        // 자기가 보낸 값이 아니라 서버가 클램프한 값이다.
        data: { ...data, max_assets: params.maxAssets, max_budget_usd: params.maxBudgetUsd },
      };
    },

    // ⓑ 발급된 토큰이 **같은 파라미터로** 유효할 때만 실행한다.
    genExecute: async (params) => {
      if (!estimates.consume(params.estimateToken, { maxAssets: params.maxAssets, maxBudgetUsd: params.maxBudgetUsd })) {
        throw new ActionError(
          "estimate_token_invalid",
          "유효한 견적 승인이 없다 — 비용을 확인하는 화면을 다시 열어 승인해야 실행된다",
        );
      }
      return rethrowClassified(() =>
        runGenCli({
          maxAssets: params.maxAssets,
          maxBudgetUsd: params.maxBudgetUsd,
          timeoutSec,
          // ⚠️ `yes: true`는 "승인을 건너뛴다"가 **아니다.** 비대화형에서 gen은 프롬프트를
          // 띄울 수 없어 그냥 취소되는데, 웹에서는 승인이 이미 일어났다 — 그 증거가 방금
          // 소비한 estimate 토큰이다. 토큰 검사 **뒤에만** 이 플래그가 붙는다는 순서가
          // 이 값의 정당성 전부다.
          yes: true,
        }),
      );
    },
  };
}

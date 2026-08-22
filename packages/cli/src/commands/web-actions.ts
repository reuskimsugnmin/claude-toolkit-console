import { randomBytes, timingSafeEqual } from "node:crypto";
import { toPerCallBudgetUsd } from "@ctk/core";
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

/** 발급 시점에 확정돼 실행까지 그대로 유지돼야 하는 승인 내용. */
export interface ApprovedGenPlan {
  maxAssets: number;
  /** 사용자가 화면에서 승인한 **총액**. */
  maxTotalUsd: number;
  /** dry-run이 센 실제 대상 자산 수 = `claude -p` 호출 수. 호출당 예산의 분모다. */
  callCount: number;
}

/** 미소비 토큰 보유 상한 — 발급만 반복해 맵을 불리는 것을 막는다(심사 M3). */
const MAX_OUTSTANDING_ESTIMATES = 8;

/**
 * `gen` 2-phase의 estimate 토큰 보관소.
 *
 * ⚠️ **토큰은 승인 내용에 묶인다.** 싸게 견적내고 비싸게 실행하는 것을 막으려면 발급 시점의
 * `maxAssets`/`maxTotalUsd`/`callCount`를 함께 기억하고 실행 요청과 대조해야 한다.
 * 토큰만 대조하면 "승인받은 비용"과 "실제 지출"이 갈린다.
 *
 * 1회용이다 — 쓰면 사라진다. 버튼 연타로 같은 승인이 두 번 실행되지 않는다.
 */
export class EstimateTokenStore {
  private readonly issued = new Map<string, { plan: ApprovedGenPlan; issuedAt: number }>();

  /** 승인 화면을 열어둔 채 오래 두면 그 사이 카탈로그가 바뀐다 — 견적이 낡으면 다시 받는다. */
  constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  issue(plan: ApprovedGenPlan, now = Date.now()): string {
    this.evictExpired(now);
    if (this.issued.size >= MAX_OUTSTANDING_ESTIMATES) {
      throw new ActionError(
        "estimate_token_invalid",
        `승인 대기 중인 견적이 ${MAX_OUTSTANDING_ESTIMATES}건을 넘었다 — 기존 승인을 실행하거나 ${Math.round(this.ttlMs / 60000)}분 뒤 다시 시도한다`,
      );
    }
    const token = randomBytes(24).toString("base64url");
    this.issued.set(token, { plan, issuedAt: now });
    return token;
  }

  /**
   * 토큰을 소비하고 **발급 시점의 승인 내용**을 돌려준다. 없거나·만료됐거나·승인 내용이
   * 다르면 `null`이다 — 어느 경우인지 호출자에게 구분해 알리지 않는다(탐색 단서가 된다).
   *
   * 검증 **전에** 삭제한다 — 불일치로 거부된 토큰도 재사용할 수 없어야 한다.
   */
  consume(token: string, expected: { maxAssets: number; maxTotalUsd: number }, now = Date.now()): ApprovedGenPlan | null {
    const found = this.findConstantTime(token);
    if (found === null) return null;
    this.issued.delete(found.key);
    if (now - found.value.issuedAt > this.ttlMs) return null;
    const plan = found.value.plan;
    if (plan.maxAssets !== expected.maxAssets || plan.maxTotalUsd !== expected.maxTotalUsd) return null;
    return plan;
  }

  private evictExpired(now: number): void {
    for (const [key, value] of this.issued) {
      if (now - value.issuedAt > this.ttlMs) this.issued.delete(key);
    }
  }

  /** 존재 여부를 타이밍으로 흘리지 않는다 — 모든 항목을 상수 시간으로 비교한다. */
  private findConstantTime(token: string): { key: string; value: { plan: ApprovedGenPlan; issuedAt: number } } | null {
    const candidate = Buffer.from(token, "utf8");
    let hit: { key: string; value: { plan: ApprovedGenPlan; issuedAt: number } } | null = null;
    for (const [key, value] of this.issued) {
      const known = Buffer.from(key, "utf8");
      if (known.length === candidate.length && timingSafeEqual(known, candidate)) hit = { key, value };
    }
    return hit;
  }
}

/**
 * 액션 응답에 실을 값을 **명시적으로 고른다.**
 *
 * ⚠️ **CLI summary를 그대로 통과시키면 절대경로가 브라우저로 나간다.** 네 액션의 summary가
 * 전부 경로 필드를 갖고 있다 — `ScanSummary`(catalogPath·snapshotPath·runLogPath) ·
 * `RollbackSummary`(journalPath) · `MoveSummary`(journalPath) · `RunGenSummary`(indexPath).
 * 심사 M1을 위생 에러 메시지에서 고치면서 **액션 응답 전체를 감사하지 않아** 같은 유출이
 * 성공 응답에 남아 있었다(브라우저 실측으로 발견).
 *
 * 화이트리스트로 고르는 이유: 제외 목록으로 두면 새 필드가 추가될 때 조용히 새어 나간다.
 * 여기 적히지 않은 값은 나가지 않는다.
 */
function scanView(s: Awaited<ReturnType<typeof runScan>>) {
  return {
    asset_counts: s.assetCounts,
    installation_count: s.installationCount,
    toggle_count: s.toggleCount,
    scope_distribution: s.scopeDistribution,
    duration_ms: s.durationMs,
  };
}

function rollbackView(s: Awaited<ReturnType<typeof runRollback>>) {
  return { asset_id: s.assetId, action: s.action };
}

function moveView(s: Awaited<ReturnType<typeof runMove>>) {
  return { asset_id: s.assetId, kind: s.kind, from: s.from, to: s.to };
}

function genView(s: Awaited<ReturnType<typeof runGenCli>>) {
  return {
    generated: s.results.length,
    stopped_early: s.stoppedEarly,
    injection_findings: s.injectionFindingsTotal,
    skipped: s.plan.skipped,
    empty_asset_ids: s.plan.emptyAssetIds,
  };
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

/**
 * 서버가 살아 있는 동안의 **누적** 지출 상한(심사 M3). estimate 토큰은 1회용이지만 승인
 * 사이클 자체는 무한 반복할 수 있어, 이 상한이 없으면 시간당 지출에 사실상 천장이 없다.
 * 재시작으로 초기화된다 — 거부에 복구 경로를 함께 준다(안전 원칙 6).
 */
export const SESSION_CUMULATIVE_USD_CAP = 10;

export interface CreateActionHandlersOptions {
  estimates?: EstimateTokenStore;
  /** `gen` 실행에 필수인 벽시계 상한(초). 웹에서 자유 문자열로 받지 않고 서버가 고정한다. */
  genTimeoutSec?: number;
  cumulativeUsdCap?: number;
}

export function createActionHandlers(options: CreateActionHandlersOptions = {}): ActionHandlers {
  const estimates = options.estimates ?? new EstimateTokenStore();
  const timeoutSec = options.genTimeoutSec ?? 300;
  const cumulativeCap = options.cumulativeUsdCap ?? SESSION_CUMULATIVE_USD_CAP;
  let cumulativeApprovedUsd = 0;

  return {
    scan: () => rethrowClassified(async () => scanView(await runScan())),

    rollback: () => rethrowClassified(async () => rollbackView(await runRollback({ last: true }))),

    move: (request) =>
      rethrowClassified(async () =>
        moveView(await runMove({
          assetId: request.asset_id,
          to: request.to,
          ...(request.to_project_index === undefined ? {} : { toProjectIndex: request.to_project_index }),
          ...(request.from === undefined ? {} : { from: request.from }),
          ...(request.from_project_index === undefined ? {} : { fromProjectIndex: request.from_project_index }),
        })),
      ),

    // ⓐ dry-run 경로를 그대로 쓴다 — 동기 함수이며 API 호출도 서브프로세스 spawn도 하지 않는다(AC-3.8).
    genEstimate: async (params) => {
      const data = await rethrowClassified(async () => runGenDryRun({ maxAssets: params.maxAssets }));
      const callCount = data.assetCount;
      const perCallBudgetUsd = toPerCallBudgetUsd(params.maxTotalUsd, callCount);
      return {
        estimateToken: estimates.issue({ ...params, callCount }),
        // 승인 화면이 보여줄 값에 **적용될 상한**을 함께 싣는다. 이름을 총액/호출당으로
        // 갈라 적는다 — 한 이름으로 뭉치면 사용자가 승인한 숫자와 실제 상한이 갈린다(H2).
        data: {
          ...data,
          max_assets: params.maxAssets,
          call_count: callCount,
          per_call_budget_usd: perCallBudgetUsd,
          max_total_usd: params.maxTotalUsd,
          session_remaining_usd: Math.max(cumulativeCap - cumulativeApprovedUsd, 0),
        },
      };
    },

    // ⓑ 발급된 토큰이 **같은 승인 내용으로** 유효할 때만 실행한다.
    genExecute: async (params) => {
      const approved = estimates.consume(params.estimateToken, {
        maxAssets: params.maxAssets,
        maxTotalUsd: params.maxTotalUsd,
      });
      if (approved === null) {
        throw new ActionError(
          "estimate_token_invalid",
          "유효한 견적 승인이 없다 — 비용을 확인하는 화면을 다시 열어 승인해야 실행된다",
        );
      }
      if (cumulativeApprovedUsd + approved.maxTotalUsd > cumulativeCap) {
        throw new ActionError(
          "action_failed",
          `이 서버 세션의 누적 승인 한도($${cumulativeCap})에 도달했다 — ctk를 재시작하면 초기화된다`,
        );
      }
      cumulativeApprovedUsd += approved.maxTotalUsd;

      return rethrowClassified(async () =>
        genView(await runGenCli({
          // 승인 시점에 센 호출 수를 상한으로 되꽂는다 — 그 사이 대상이 늘어도 총액은 유지된다.
          maxAssets: Math.min(approved.maxAssets, approved.callCount),
          // `runGen`이 받는 값은 **호출당** 상한이다. 총액을 호출 수로 나눈 값을 넘겨야
          // 사용자가 승인한 총액이 실제 상한과 같아진다.
          maxBudgetUsd: toPerCallBudgetUsd(approved.maxTotalUsd, approved.callCount),
          timeoutSec,
          // ⚠️ `yes: true`는 "승인을 건너뛴다"가 **아니다.** 비대화형에서 gen은 프롬프트를
          // 띄울 수 없어 그냥 취소되는데, 웹에서는 승인이 이미 일어났다 — 그 증거가 방금
          // 소비한 estimate 토큰이다. 토큰 검사 **뒤에만** 이 플래그가 붙는다는 순서가
          // 이 값의 정당성 전부다.
          yes: true,
        })),
      );
    },
  };
}

import { randomBytes, timingSafeEqual } from "node:crypto";
import { deriveObservedUnitCost, projectGenTotalUsd, toPerCallBudgetUsd, type GenCost } from "@ctk/core";
import { resolveHomeContext } from "@ctk/probe";
import { readLatestGenCost } from "@ctk/sync";
import { readLocalConfig, readMachineIdentityOrNull } from "../local-config.js";
import { ActionError, type ActionHandlers } from "@ctk/web";
import { LockContendedError } from "@ctk/sync";
import { runScan } from "./scan.js";
import {
  runMove,
  AssetNotFoundError,
  NoOpMoveError,
  ProjectIndexOutOfRangeError,
  ProjectListChangedError,
  SkillLocationAmbiguousError,
} from "./move.js";
import { runRollback, InvalidBackupRefError, NoRollbackTargetError } from "./rollback.js";
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
    unresolved: s.plan.unresolved,
  };
}

/**
 * CLI가 던지는 실패를 웹 상태 코드로 분류한다. **분류되지 않은 예외는 500으로 남긴다** —
 * 여기서 넓게 잡아 400으로 바꾸면 서버 결함이 사용자 입력 오류로 보고된다.
 *
 * ⚠️ **반대 방향도 결함이다.** 처음에는 세 개만 분류해, `AssetNotFoundError` 같은 **명백한
 * 사용자 입력 오류가 500 `action_failed`로** 나갔다(실측 발견) — 화면은 "서버가 고장났다"고
 * 말하고 사용자는 자기 입력을 고칠 생각을 못 한다. `move`/`rollback`이 던지는 클라이언트
 * 입력 계열을 **전부** 등재한다. 새 에러 클래스를 만들면 여기도 함께 고친다.
 */
function toActionError(err: unknown): unknown {
  if (err instanceof LockContendedError) return new ActionError("lock_contended", err.message);
  if (err instanceof ProjectIndexOutOfRangeError) return new ActionError("project_index_out_of_range", err.message);
  // 아래는 전부 "사용자가 무엇을 고쳐야 하는지" 아는 실패다 — 서버 결함으로 보고하지 않는다.
  if (
    err instanceof ProjectListChangedError ||
    err instanceof AssetNotFoundError ||
    err instanceof NoOpMoveError ||
    err instanceof SkillLocationAmbiguousError ||
    err instanceof NoRollbackTargetError ||
    err instanceof InvalidBackupRefError
  ) {
    return new ActionError("bad_request", err.message);
  }
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
  /**
   * 견적 화면 조립부의 **테스트 이음매**(심사 M-4). 기본값은 실제 dry-run과 실제 run log다.
   *
   * ⚠️ 이것이 없으면 이 경로에 테스트를 붙일 수 없다 — 실제 카탈로그와 실제 실행 기록을 읽으므로
   * 단언이 코드가 아니라 **그 머신**에 대한 진술이 된다. 실제로 `observed_unit_cost` 조립부는
   * 어떤 테스트도 지나가지 않았고, 잘못된 개수를 곱해도 전 스위트가 통과했다.
   */
  dryRunFn?: typeof runGenDryRun;
  observedCostFn?: () => GenCost | null;
}

/**
 * 이 머신의 지난 `gen` 실행이 남긴 실측 단가를 읽는다. **못 읽으면 `null`이고 대체값을 만들지
 * 않는다**(안전 원칙 7) — 화면은 그때 "실측 없음"이라고 말해야지 그럴듯한 숫자를 보여선 안 된다.
 *
 * 카탈로그가 아직 없는 로컬(초기화 전)에서도 견적 화면은 떠야 하므로 여기서 던지지 않는다.
 */
function readObservedGenCost(): GenCost | null {
  try {
    const home = resolveHomeContext();
    const localConfig = readLocalConfig(home);
    if (localConfig === null) return null;
    const machine = readMachineIdentityOrNull(home);
    if (machine === null) return null;
    return readLatestGenCost(localConfig.catalog_path, machine.machine_id);
  } catch {
    return null;
  }
}

export function createActionHandlers(options: CreateActionHandlersOptions = {}): ActionHandlers {
  const estimates = options.estimates ?? new EstimateTokenStore();
  const timeoutSec = options.genTimeoutSec ?? 300;
  const cumulativeCap = options.cumulativeUsdCap ?? SESSION_CUMULATIVE_USD_CAP;
  const dryRunFn = options.dryRunFn ?? runGenDryRun;
  const observedCostFn = options.observedCostFn ?? readObservedGenCost;
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
          ...(request.to_project_hash_prefix === undefined
            ? {}
            : { toProjectHashPrefix: request.to_project_hash_prefix }),
          ...(request.from === undefined ? {} : { from: request.from }),
          ...(request.from_project_index === undefined ? {} : { fromProjectIndex: request.from_project_index }),
        })),
      ),

    // ⓐ dry-run 경로를 그대로 쓴다 — 동기 함수이며 API 호출도 서브프로세스 spawn도 하지 않는다(AC-3.8).
    genEstimate: async (params) => {
      const data = await rethrowClassified(async () => dryRunFn({ maxAssets: params.maxAssets }));
      const callCount = data.assetCount;
      const perCallBudgetUsd = toPerCallBudgetUsd(params.maxTotalUsd, callCount);
      // 이 머신의 지난 실행이 남긴 실측 단가. **없으면 null이고 지어내지 않는다.**
      // 이것이 없으면 화면은 상한만 보여주고, 사용자는 그 상한이 현실적인지 알 수 없다 —
      // 실측(2026-08-24) 중앙값이 기본 총액을 호출수로 나눈 값보다 커서 대부분 사전 거부됐다.
      const observedCost = observedCostFn();
      // 브라우저가 직접 곱하지 않는다 — 총액 투사는 core 한 곳에서만 한다(둘 다 중앙값으로
      // 곱해 총액을 10~21% 낮게 말하던 결함이 여기서 갈라져 있었다).
      const observedUnit = deriveObservedUnitCost(observedCost);
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
          // `observed_cost`(원자료)는 더 이상 화면이 쓰지 않는다 — 소비되지 않는 머신별 비용
          // 원자료를 브라우저로 내보내지 않는다(심사 L-5). 파생값만 싣는다.
          observed_unit_cost:
            observedUnit === null
              ? null
              : {
                  mean_usd: observedUnit.meanUsd,
                  median_usd: observedUnit.medianUsd,
                  max_usd: observedUnit.maxUsd,
                  sample_size: observedUnit.sampleSize,
                  partial: observedUnit.partial,
                  projected_total_usd: projectGenTotalUsd(observedUnit, callCount),
                },
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

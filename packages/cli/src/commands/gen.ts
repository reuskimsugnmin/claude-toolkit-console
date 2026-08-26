import { createInterface } from "node:readline/promises";
import { resolveHomeContext } from "@ctk/probe";
import { readManagedPolicies } from "@ctk/probe";
import {
  acquireLock,
  commitAll,
  listAllAssets,
  readCatalogConfig,
  readCatalogIndex,
  readLatestGenCost,
  writeRunLog,
} from "@ctk/sync";
import {
  FailureClassSchema,
  gradeManagedPolicy,
  projectGenTotalUsd,
  unresolvedReasonLabel,
  type FailureClass,
} from "@ctk/core";
import {
  estimateGenCost,
  planGenTargets,
  runGen,
  summarizeGenCost,
  GenRunAbortedError,
  type EstimateResult,
  type GenAssetOutcome,
  type RunGenAssetResult,
  type GenUnresolvedAsset,
  type RunGenSummary,
} from "@ctk/gen";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { ensureSealedLiveCwd } from "../sealed-cwd.js";
import { CatalogNotInitializedError } from "./scan.js";

/**
 * cli/src/commands/gen.ts — `ctk gen`(§4 Step 4). 비용 사전 고지(P4) → 명시 승인 → `@ctk/gen`의
 * `runGen()` 실행 → 커밋. `--dry-run`은 **로컬 전용 미리보기**만 한다 — plan(파일 직독)만 돌리고
 * `estimateGenCost()`(claude auth status spawn + count_tokens 네트워크 호출)를 아예 부르지
 * 않는다(AC-3.8: "네트워크 호출 0 · 서브프로세스 spawn 0"). 실제 실행 직전의 비용 표시는
 * `estimateGenCost()`가 맡고, 그 호출 자체는 0원에 가깝지만(auth status는 구조적 서브커맨드)
 * count_tokens는 실제 네트워크 호출이다 — 그래서 dry-run과는 다른 함수를 쓴다.
 */

export interface RunGenCliOptions {
  dryRun?: boolean;
  checkCitations?: boolean; // 예약 — v1은 runGen 내부에서 항상 인용 검사를 돈다.
  maxAssets?: number;
  maxBudgetUsd?: number;
  /** `--allow-concurrent-sessions` — 봉인 config 감사에서 다른 세션 churn을 위반으로 보지 않는다. */
  allowConcurrentSessions?: boolean;
  timeoutSec?: number;
  resume?: boolean;
  noLlm?: boolean;
  /** `--retry-blocked` — 정책 차단된 자산도 다시 시도한다. */
  retryBlocked?: boolean;
  allowManagedPolicy?: boolean;
  yes?: boolean;
  routingProbeCommand?: string;
  /**
   * `--plugin`(반복 가능) — 문서 생성 대상으로 삼을 번들 부모 id. 미지정이면 `[]`(결정 6
   * "기본 무동작") — `parent_asset_id`가 있는 자식은 전부 대상에서 빠진다.
   */
  bundledParents?: readonly string[];
}

/**
 * 미해결 자산을 **사유별로** 줄 세운다. 한 목록으로 합쳐 보여주면 사용자는 있지도 않은
 * 드리프트를 조사하러 간다(실측: 12건 중 드리프트 0건). 라벨은 `core`가 단독으로 갖는다.
 */
export function summarizeUnresolved(unresolved: readonly GenUnresolvedAsset[]): string[] {
  const byReason = new Map<GenUnresolvedAsset["reason"], string[]>();
  for (const u of unresolved) {
    const ids = byReason.get(u.reason) ?? [];
    ids.push(u.locationCount === undefined ? u.assetId : `${u.assetId}(${u.locationCount}곳)`);
    byReason.set(u.reason, ids);
  }
  return [...byReason].map(([reason, ids]) => `${unresolvedReasonLabel(reason)} ${ids.length}건: ${ids.join(", ")}`);
}

/**
 * 비용을 **하한·상한·실측** 세 줄로 적는다.
 *
 * ⚠️ 예전에는 한 줄이었고 그 값은 **입력 토큰만** 곱한 것이었다 — 실측(2026-08-24) 결과 실제
 * 비용은 그 값의 약 20배였고, 승인은 그 20배 낮은 숫자 위에서 이뤄지고 있었다. 이 저장소의
 * 원칙이 "비용을 먼저 투명하게 알리고 승인받는다"인데 **숫자 자체가 틀리면 승인은 정보에
 * 근거한 것이 아니다.** 하나의 값으로 뭉칠 수 없으므로 뭉치지 않는다(안전 원칙 7).
 */
export function describeCostEstimate(estimate: EstimateResult, maxBudgetUsd: number): string[] {
  const lines: string[] = [];
  lines.push(
    estimate.estimatedInputTokens !== null
      ? `예상 입력 토큰: ${estimate.estimatedInputTokens}tok`
      : `예상 입력 토큰: 측정 불가 — approx_bytes=${estimate.approxBytes} (토큰 아님, count_tokens 크레덴셜 없음)`,
  );
  if (estimate.costFloorUsd !== null) {
    lines.push(`비용 하한: $${estimate.costFloorUsd.toFixed(4)} — **입력 토큰만**이다. 출력·캐시가 빠져 있어 총비용이 아니다`);
  }
  lines.push(
    `비용 상한: $${estimate.costCeilingUsd.toFixed(2)} = 호출 ${estimate.callCount}회 × --max-budget-usd ${maxBudgetUsd}` +
      ` (하네스가 호출당 상한을 넘는 요청을 사전 거부하므로 이 값을 넘지 않는다)`,
  );
  if (estimate.observed === null) {
    lines.push(`실측 단가: 없음 — 이 머신의 지난 gen 실행 기록이 없다. 추정치를 지어내지 않는다`);
  } else {
    const partial = estimate.observed.partial ? " · 일부 호출은 비용 미보고라 표본이 불완전하다" : "";
    // 투사는 **평균 × 건수**다 — 중앙값으로 곱하면 총액을 계속 낮게 말한다(분포가 오른쪽으로
    // 길다: 최대가 중앙값의 약 4배). 곱셈은 core가 한다.
    lines.push(
      `실측 단가(지난 실행 ${estimate.observed.sampleSize}건): 자산당 평균 $${estimate.observed.meanUsd.toFixed(3)}` +
        ` · 중앙값 $${estimate.observed.medianUsd.toFixed(3)} · 최대 $${estimate.observed.maxUsd.toFixed(3)}`,
    );
    // ⚠️ 총액을 estimate.callCount에서 직접 곱하지 않는다 — **행마다** 투사해 더한다.
    // byParent가 targets 전체를 빠짐없이 분할하므로 행의 합은 항상 estimate.callCount와
    // 같지만, 계산 자체를 행 단위로 강제해 "총액"과 "부모별 합"이 서로 다른 공식으로
    // 갈라지는 것을 구조적으로 막는다(core/view/gen-cost-projection.ts).
    const observed = estimate.observed;
    const projectedTotal = estimate.byParent.reduce((sum, row) => sum + projectGenTotalUsd(observed, row.callCount), 0);
    lines.push(
      `이번 ${estimate.callCount}건 예상 총액: 약 $${projectedTotal.toFixed(2)}` +
        ` (평균 × 건수 — 상한이 아니라 예상치다)${partial}`,
    );
  }
  return lines;
}

/**
 * 번들 자식이 미지정으로 제외됐다는 사실을 고지한다. **제외는 조용히 하지 않는다** — 0건이면
 * 아무것도 말하지 않지만, 0건이 아니면 항상 이 줄이 나와야 한다(AC-6 "기본 무동작"은
 * 무동작을 말하는 것까지가 요구다).
 */
export function describeExcludedBundled(excludedBundled: number): string | null {
  if (excludedBundled <= 0) return null;
  return `번들 자산 ${excludedBundled}건은 미지정으로 제외됨 — --plugin으로 지정한 부모의 자식만 대상이 된다`;
}

/** 실행이 끝난 뒤 **실제로 나간 돈**을 적는다. 미보고가 있으면 총액이 아니라 하한이라고 말한다. */
export function describeActualCost(cost: RunGenSummary["cost"]): string {
  if (cost.calls_reported === 0) {
    return `실측 비용: 보고 없음 — 호출 ${cost.calls_unreported}건 전부 total_cost_usd가 실리지 않았다(0원이라는 뜻이 아니다)`;
  }
  const bound = cost.calls_unreported > 0 ? "이상(하한)" : "";
  return (
    `실측 비용: $${cost.reported_total_usd.toFixed(2)}${bound} · 보고 ${cost.calls_reported}건` +
    (cost.calls_unreported > 0 ? ` · 미보고 ${cost.calls_unreported}건` : "") +
    (cost.median_usd === null ? "" : ` · 자산당 중앙값 $${cost.median_usd.toFixed(3)}`)
  );
}

/**
 * 중단시킨 실패의 분류를 꺼낸다. **모르면 `null`이고 아무 이름이나 붙이지 않는다** —
 * `exit_code`가 1로 남으므로 "성공"으로 읽히지는 않는다(안전 원칙 7).
 */
function failureClassOf(cause: unknown): FailureClass | null {
  const fc = (cause as { failureClass?: unknown } | null)?.failureClass;
  // 열거에 없는 이름은 기록하지 않는다 — 스키마가 거부하면 장부 전체가 안 써진다.
  const parsed = FailureClassSchema.safeParse(fc);
  return parsed.success ? parsed.data : null;
}

export class MissingRequiredFlagError extends Error {
  constructor(flag: string) {
    super(`${flag}은(는) 필수 플래그다 — 미지정 시 실행을 거부한다(전역 CLAUDE.md 비용/타임아웃 규칙)`);
    this.name = "MissingRequiredFlagError";
  }
}

export interface GenDryRunReport {
  assetCount: number;
  approxBytes: number;
  /** 원문을 못 구한 자산 — **사유별로 처방이 다르므로** id만 나열하지 않는다. */
  unresolved: GenUnresolvedAsset[];
  /** 파일 위생(심볼릭 링크·크기 상한)에 걸려 건너뛴 자산. 조용히 빼지 않는다. */
  skipped: { assetId: string; failureClass: string; reason: string }[];
  /** 번들 자식인데 부모가 `bundledParents`에 없어 대상에서 빠진 건수. 조용히 빼지 않는다. */
  excludedBundled: number;
}

/** `--dry-run` — 파일 직독만. API 호출도 서브프로세스 spawn도 하지 않는다(AC-3.8). */
export function runGenDryRun(
  options: { maxAssets?: number; retryBlocked?: boolean; bundledParents?: readonly string[] } = {},
): GenDryRunReport {
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;

  const assets = listAllAssets(catalogPath);
  const index = readCatalogIndex(catalogPath);
  const plan = planGenTargets({
    home,
    assets,
    index,
    maxAssets: options.maxAssets,
    retryPolicyBlocked: options.retryBlocked,
    bundledParents: options.bundledParents ?? [],
  });
  const approxBytes = plan.targets.reduce(
    (sum, t) => sum + t.sections.reduce((s, sec) => s + Buffer.byteLength(sec.content, "utf8"), 0),
    0,
  );
  return {
    assetCount: plan.targets.length,
    approxBytes,
    unresolved: plan.unresolved,
    skipped: plan.skipped,
    excludedBundled: plan.excludedBundled,
  };
}

async function confirmInteractively(promptText: string): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false; // 비대화형에서는 프롬프트를 띄우지 않는다 — --yes가 필요하다.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${promptText} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function runGenCli(options: RunGenCliOptions): Promise<RunGenSummary> {
  if (options.maxBudgetUsd === undefined) throw new MissingRequiredFlagError("--max-budget-usd");
  if (options.timeoutSec === undefined) throw new MissingRequiredFlagError("--timeout-sec");

  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;
  const catalogConfig = readCatalogConfig(catalogPath);
  if (catalogConfig === null) throw new CatalogNotInitializedError();
  const machine = readOrCreateMachineIdentity(home, "local-machine");

  const startedAt = new Date();
  const lock = acquireLock(catalogPath, {
    command: "gen",
    origin: "cli",
    started_at: startedAt.toISOString(),
    machine_id: machine.machine_id,
  });

  try {
    const bundledParents = options.bundledParents ?? [];
    const assets = listAllAssets(catalogPath);
    const index = readCatalogIndex(catalogPath);
    const plan = planGenTargets({
      home,
      assets,
      index,
      maxAssets: options.maxAssets,
      retryPolicyBlocked: options.retryBlocked,
      bundledParents,
    });

    // ⚠️ `.policies`만 꺼내면 파싱 실패가 빈 배열로 흘러 "정책 없음"과 같아진다(안전 원칙 7).
    const managed = options.noLlm === true ? { policies: [], parseFailures: [] } : readManagedPolicies();
    const managedPolicies = managed.policies;
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

    if (!options.noLlm) {
      const estimate = await estimateGenCost({
        home,
        targets: plan.targets,
        tokenizerModel: catalogConfig.tokenizer_model,
        cwd: ensureSealedLiveCwd(),
        timeoutSec: options.timeoutSec,
        maxBudgetUsd: options.maxBudgetUsd,
        // 이 머신의 지난 실행이 남긴 실비용. 없으면 null이고 실측 줄을 띄우지 않는다.
        observedCost: readLatestGenCost(catalogPath, machine.machine_id),
      });

      console.log(`ctk gen — 대상 자산 ${estimate.assetCount}건, claude -p 호출 ${estimate.callCount}회 예정`);
      for (const line of describeCostEstimate(estimate, options.maxBudgetUsd)) console.log(`  ${line}`);
      if (plan.skipped.length > 0) {
        // 위생 거부는 "생성 안 됨"의 이유가 다르므로 빈 자산과 분리해 보여준다.
        console.log(`  위생 검사가 거부해 건너뛴 자산 ${plan.skipped.length}건:`);
        for (const s of plan.skipped) console.log(`    - ${s.assetId} (${s.failureClass})`);
      }
      for (const line of summarizeUnresolved(plan.unresolved)) console.log(`  ${line}`);
      const excludedNotice = describeExcludedBundled(plan.excludedBundled);
      if (excludedNotice !== null) console.log(`  ⚠️ ${excludedNotice}`);

      const grade = gradeManagedPolicy(managedPolicies);
      if (grade.hasRisk) {
        console.log(`  ⚠️ managed 정책 위험 키 감지: ${grade.keysPresent.join(", ")}`);
      }
      // 경로만 알린다 — 정책 **내용**은 어떤 로그에도 옮기지 않는다(§7.1).
      if (managed.parseFailures.length > 0) {
        console.log(`  ⚠️ managed 정책 파일을 읽지 못했다(위험 판정 불가): ${managed.parseFailures.join(", ")}`);
      }

      if (options.yes !== true) {
        const approved = await confirmInteractively("위 비용으로 실행합니까?");
        if (!approved) {
          console.log("승인되지 않아 실행을 취소한다. --yes로 비대화형 승인을 줄 수 있다.");
          return {
            plan,
            results: [],
            stoppedEarly: false,
            injectionFindingsTotal: { directive: 0, executable: 0, url: 0, length: 0 },
            // 승인하지 않았으므로 호출이 **하나도 없었다** — 미보고 0건이 사실이다(0원으로
            // 뭉갠 것이 아니다). 표본이 없으니 중앙값·최대값은 null로 남는다.
            cost: summarizeGenCost([], 0),
            urlScrub: { removed: 0, hosts: [] }, // 실행이 없었으므로 제거도 없다.
            sealAudit: { sessionOwnedExcluded: 0, concurrencyOverrides: 0 },
            indexPath: "",
          };
        }
      }
    }

    let summary: Awaited<ReturnType<typeof runGen>>;
    let abortedCause: unknown = null;
    try {
      summary = await runGen({
      home,
      catalogRoot: catalogPath,
      assets,
      maxAssets: options.maxAssets,
      maxBudgetUsd: options.maxBudgetUsd,
      allowConcurrentSessions: options.allowConcurrentSessions === true,
      timeoutSec: options.timeoutSec,
      noLlm: options.noLlm === true,
      retryPolicyBlocked: options.retryBlocked === true,
      // 위에서 승인·고지에 쓴 계획과 **같은 값**을 넘긴다 — runGen이 내부에서 다시 계획을
      // 세우므로(gen/index.ts) 여기서 갈리면 "고지한 건수 ≠ 실행한 건수"가 된다(결정 6).
      bundledParents,
      verifiedCliVersion: catalogConfig.verified_cli_version,
      routingProbeCommand: options.routingProbeCommand,
      sealedCwd: ensureSealedLiveCwd(),
      interactive,
      allowManagedPolicy: options.allowManagedPolicy === true,
      managedPolicies,
        managedPolicyParseFailures: managed.parseFailures,
      });
    } catch (err) {
      // ⚠️ **중단이어도 장부는 쓴다.** 실측(2026-08-25): 감사 위반으로 멈춘 배치가 문서 10건을
      // 만들고 돈을 썼는데 run-log를 한 줄도 남기지 않았다 — 카탈로그는 나아가고 장부는
      // 안 나아갔다. 그러면 다음 실행의 견적이 **성공한 실행만**으로 계산되고, 중단은 대개
      // 비싼 자산에서 나므로 그 표본은 아래로 편향된다(안전 원칙 8).
      // ⚠️ **이 배선은 아직 테스트가 지나가지 않는다**(2026-08-25 파괴 실험: 이 줄을 `throw err`로
      // 되돌려도 1147개가 전부 통과했다). `runGenCli`를 태우는 테스트가 하나도 없기 때문이다 —
      // 실증은 다음 실제 배치가 중단됐을 때 run-log가 남는지로 한다. 그때까지 **미측정**이다.
      if (!(err instanceof GenRunAbortedError)) throw err;
      summary = err.partial;
      abortedCause = err.cause;
    }

    const finishedAt = new Date();
    writeRunLog(catalogPath, {
      schema_version: 1,
      _scope: "machine_dependent",
      command: "gen",
      args: {
        counts: {
          targets: summary.plan.targets.length,
          fresh: summary.results.filter((r) => r.outcome === "fresh").length,
          pending: summary.results.filter((r) => r.outcome === "pending").length,
          stale: summary.results.filter((r) => r.outcome === "stale").length,
        },
        no_llm: options.noLlm === true,
        // 통과한 실행에서도 감사 집계를 남긴다(보안 재심 M3) — "조용히 지움"을 정상 경로에서도 막는다.
        session_owned_excluded: summary.sealAudit.sessionOwnedExcluded,
        concurrency_overrides: summary.sealAudit.concurrencyOverrides,
        allow_concurrent_sessions: options.allowConcurrentSessions === true,
      },
      machine_id: machine.machine_id,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      exit_code: abortedCause === null ? 0 : 1,
      // 중단이면 그 실패를, 아니면 예산 초과 여부를 적는다. 둘을 뭉개지 않는다.
      failure_class: abortedCause !== null ? failureClassOf(abortedCause) : summary.stoppedEarly ? "budget_exceeded" : null,
      seal_profile: options.noLlm === true ? "test-isolated" : "sealed-live",
      injection_findings: summary.injectionFindingsTotal,
      // 다음 실행의 견적이 이 값을 읽어 실측 범위를 보여준다 — 상수로 박지 않는 이유는
      // 자산당 실비용이 그 머신의 툴 원문 크기에 달린 **머신 종속** 사실이기 때문이다.
      gen_cost: summary.cost,
      // 제거 사실을 **지속 기록**에 남긴다(심사 M1) — 콘솔 경고만으로는 사후 감사가 불가능하고,
      // injection_findings.url은 제거 도입 후 통과 문서에서 구조적으로 항상 0이다.
      url_scrub: summary.urlScrub,
    });

    if (summary.results.some((r) => r.outcome === "fresh")) {
      commitAll(catalogPath, `ctk gen: ${startedAt.toISOString()}`);
    }

    // 장부를 남긴 뒤 원래 실패를 그대로 올린다 — 중단을 성공으로 바꾸지 않는다.
    if (abortedCause !== null) throw abortedCause;
    return summary;
  } finally {
    lock.release();
  }
}

/**
 * cli/src/commands/gen.ts — `gen` 실행 요약 문구.
 *
 * ⚠️ **`bin/ctk.ts` 안에 인라인으로 있던 것을 함수로 뺐다(2026-08-26).** 그 자리에 있는 동안
 * **어떤 테스트도 이 문자열을 태우지 않았고**, 그 사이에 `policy_blocked` outcome이 어느
 * 카운터에도 잡히지 않아 3건이 요약에서 통째로 사라지는 회귀가 생겼다. 못 태우는 축이 있으면
 * 이음매를 넣어 태운다(CLAUDE.md).
 */
export function countGenOutcomes(results: readonly RunGenAssetResult[]): Record<GenAssetOutcome, number> {
  const counts: Record<GenAssetOutcome, number> = { fresh: 0, pending: 0, stale: 0, policy_blocked: 0 };
  for (const r of results) {
    // ⚠️ `switch`다 — outcome이 늘면 여기서 컴파일이 깨져 "이걸 어떻게 보여줄지"를 반드시 정하게
    // 된다. `filter(...).length`를 쓰던 때는 새 값이 **조용히 어디에도 안 잡혔다.**
    switch (r.outcome) {
      case "fresh":
        counts.fresh += 1;
        break;
      case "pending":
        counts.pending += 1;
        break;
      case "stale":
        counts.stale += 1;
        break;
      case "policy_blocked":
        counts.policy_blocked += 1;
        break;
    }
  }
  return counts;
}

/**
 * 요약 줄과, 필요하면 그 뒤에 붙는 안내를 만든다.
 *
 * **`stale`과 `policy_blocked`를 뭉치지 않는다** — 전자는 "다음 실행이 다시 시도한다"이고
 * 후자는 "원문이 그대로면 다시 시도해도 같은 결과"다. 뭉치면 사용자가 돈을 다시 쓴다.
 */
export function describeGenSummary(results: readonly RunGenAssetResult[]): string[] {
  const c = countGenOutcomes(results);
  const lines = [
    `ctk gen 완료 — 최신 ${c.fresh}건 · 미처리 ${c.pending}건 · 갱신필요 ${c.stale}건 · ` +
      `정책차단 ${c.policy_blocked}건`,
  ];
  if (c.policy_blocked > 0) {
    lines.push(
      "  ℹ️ 정책차단은 재시도로 풀리지 않는다 — 원문이 바뀌면 자동으로 다시 대상이 된다. " +
        "지금 강제하려면 `--retry-blocked`를 준다",
    );
  }
  return lines;
}

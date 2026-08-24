// @ctk/gen — AI 문서 생성, 위험도 중간(비용)·파괴도는 봉인 전제 하 낮음 (결정 4).
//
// gen은 카탈로그 저장소 외 어떤 경로에도 직접 쓰지 않는다 — 쓰기는 전부 @ctk/sync에 위임한다
// (계층 lint가 fs 쓰기 계열 호출을 이미 차단한다). 봉인 프로파일은 test-isolated | sealed-live
// 둘뿐이며 --bare는 전 경로에서 폐기됐다(Step 0 실측, AC-0.10ⓑ).

import {
  gradeManagedPolicy,
  decideManagedPolicyGate,
  type Asset,
  type ManagedPolicyGrade,
} from "@ctk/core";
import { spawnClaude, type HomeContext } from "@ctk/probe";
import {
  readCatalogIndex,
  setAssetGenState,
  writeAnnotationDoc,
  writeUsageDoc,
  rebuildCatalogIndex,
  type CatalogIndex,
} from "@ctk/sync";
import { assertOutputFieldsClean, InjectionPatternDetectedError, type InjectionFindingsSummary } from "./output-verify.js";
import { checkAllCitations } from "./citation-check.js";
import { planGenTargets, type GenPlanResult, type GenPlanTarget } from "./plan.js";
import { ruleExtract } from "./rule-extract.js";
import { ClaudePCallFailedError, runClaudePForTarget } from "./run-claude-p.js";
import {
  auditSealedLiveConfigDir,
  captureConfigDirSnapshot,
  readClaudeJsonRawOrNull,
  sealedLiveAuditPassed,
  type SealedLiveAuditResult,
} from "./tree-audit.js";

export * from "./plan.js";
export * from "./estimate.js";
export * from "./prompt-envelope.js";
export * from "./output-schema.js";
export * from "./output-verify.js";
export * from "./source-trust.js";
export * from "./file-hygiene.js";
export * from "./source-resolve.js";
export * from "./extract-frontmatter.js";
export * from "./rule-extract.js";
export * from "./citation-check.js";
export * from "./tree-audit.js";
export * from "./run-claude-p.js";
export * from "./agent-probe.js";
export * from "./seal-live-test.js";

export class ManagedPolicyBlockedError extends Error {
  readonly failureClass = "managed_policy_blocked" as const;
  constructor(readonly grade: ManagedPolicyGrade) {
    super(
      `managed 정책에 위험 키(${grade.keysPresent.join(", ")})가 있고 비대화형 실행이다 — ` +
        "--allow-managed-policy 명시 옵트인 없이는 sealed-live 실행을 거부한다",
    );
    this.name = "ManagedPolicyBlockedError";
  }
}

export class SealedLiveConfigDirAuditViolationError extends Error {
  readonly failureClass = "whitelist_violation" as const;
  constructor(
    readonly assetId: string,
    readonly audit: SealedLiveAuditResult,
  ) {
    // ⚠️ **감사가 아는 것 이상을 말하지 않는다.** 이 판정은 "창(window) 동안 config dir이
    // 바뀌었다"이지 "봉인 세션이 바꿨다"가 아니다 — 다른 살아 있는 세션도 같은 디렉터리에
    // 쓴다(2026-08-24 실측). 귀속 불가로 알려진 경로는 판정 전에 걷어냈고 그 건수를 함께
    // 싣는다: 제외가 0건인데 위반이 남았다면 자식일 가능성이 높고, 제외가 많다면 아직
    // 걷어내지 못한 다른 세션 경로가 있을 수 있다는 단서다.
    super(
      `자산 ${assetId} 생성 중 config dir이 허용목록 밖에서 변경됐다(귀속 불가 경로 ` +
        `${audit.sessionOwnedExcluded.length}건 제외 후) — 실행을 중단한다: ` +
        `${JSON.stringify(audit.verdict.violations)}` +
        (audit.incompleteObservationReasons.length > 0
          ? ` · 관측 불완전: ${audit.incompleteObservationReasons.join(", ")}`
          : ""),
    );
    this.name = "SealedLiveConfigDirAuditViolationError";
  }
}

export type GenAssetOutcome = "fresh" | "pending" | "stale";
export type GenAssetSkipReason =
  | "budget_exceeded"
  | "injection_pattern_detected"
  | "citation_missing"
  | "call_failed";

export interface RunGenAssetResult {
  assetId: string;
  outcome: GenAssetOutcome;
  reason?: GenAssetSkipReason;
  /** 거부 사유의 구체적 근거(예: 인용이 빠진 문단의 앞부분). 진단 없는 실패는 추측을 부른다. */
  detail?: readonly string[];
}

export interface RunGenSummary {
  plan: GenPlanResult;
  results: RunGenAssetResult[];
  /** true면 --max-budget-usd 초과로 조기 종료됐다 — 남은 대상은 전부 pending이다. */
  stoppedEarly: boolean;
  injectionFindingsTotal: InjectionFindingsSummary;
  /**
   * 봉인 config 감사 집계 — **통과한 실행에서도** 남긴다.
   *
   * ⚠️ 보안 재심 M3: `sessionOwnedExcluded`가 위반 에러 메시지 한 곳에서만 읽히고 있었다.
   * 즉 통과하는 실행에서는 제외가 몇 건이었는지 아무도 모르는 상태였고, 그건 주석이 피하겠다고
   * 선언한 "조용히 지움"이 정상 경로에서 그대로 일어난 것이다(안전 원칙 5).
   */
  sealAudit: {
    /** 다른 세션 소유로 판정해 제외한 **변경된** 경로 수(전 자산 합). */
    sessionOwnedExcluded: number;
    /** `--allow-concurrent-sessions`로 위반을 눈감은 자산 수. 0이 아니면 그 실행의 config 감사는 무력했다. */
    concurrencyOverrides: number;
  };
  indexPath: string;
}

export interface RunGenOptions {
  home: HomeContext;
  catalogRoot: string;
  assets: readonly Asset[];
  maxAssets?: number;
  /** 각 `claude -p` 호출(자산 1건)의 예산 상한 — gen은 이 값을 매 호출에 그대로 전달한다.
   * "배치 전체 공유 예산 풀"이 아니라 **호출당 상한**이다(단순·보수적 설계): 여러 자산에 걸친
   * 공유 잔여 예산 추적은 `claude -p`가 실제 지출을 구조화된 형태로 보고하지 않아(v1 범위에서
   * 확인되지 않음) 신뢰할 수 있게 구현할 수 없었다. */
  maxBudgetUsd: number;
  timeoutSec: number;
  /** `--no-llm` — claude -p를 전혀 띄우지 않는다. */
  noLlm: boolean;
  verifiedCliVersion: string;
  /**
   * `--allow-concurrent-sessions` — 살아 있는 다른 Claude Code 세션의 config dir churn을
   * 위반으로 보지 않는다. **이번 실행의 config 감사는 사실상 무력해진다**(tree-audit.ts).
   * 기본값 없음(호출자가 항상 명시) — 기본값을 두면 어느 경로가 무엇을 넘겼는지 흐려진다.
   */
  allowConcurrentSessions: boolean;
  routingProbeCommand?: string;
  /** 고정 sealed-live cwd(B3) — 호출자가 이미 만들어 넘긴다. */
  sealedCwd: string;
  interactive: boolean;
  allowManagedPolicy: boolean;
  managedPolicies?: readonly unknown[];
  /**
   * 존재하는데 파싱하지 못한 managed 정책 파일 경로. **빈 배열과 "읽지 못했다"는 다르다** —
   * 넘기지 않으면 깨진 정책 파일이 "정책 없음"으로 통과한다(안전 원칙 7).
   */
  managedPolicyParseFailures?: readonly string[];
  now?: Date;
  spawnFn?: typeof spawnClaude;
}

/** `claude -p` 실패 메시지에서 예산 관련 실패인지 최선의 추정으로 판정한다(실측 문구 미확인
 * — 보수적으로 "budget" 문자열 포함 여부만 본다). 오탐이면 일반 실패로 처리될 뿐 안전 방향이다. */
function looksLikeBudgetFailure(err: ClaudePCallFailedError): boolean {
  return /budget/i.test(err.message) || /budget/i.test(err.stderr);
}

/**
 * `gen`의 메인 오케스트레이터. plan → (managed policy 게이트) → 대상별 생성(LLM 또는
 * rule_extract) → citation-check → output-verify → `sync` 쓰기 → `gen_state` 갱신 →
 * (전체 종료 시 1회) 인덱스 재생성. `estimate.ts`의 승인 절차는 **호출자(CLI)**가 이 함수를
 * 부르기 전에 이미 통과시킨 상태여야 한다(비용 고지는 이 함수의 책임이 아니다 — P4는 CLI
 * 레이어가 담당).
 */
export async function runGen(options: RunGenOptions): Promise<RunGenSummary> {
  const {
    home,
    catalogRoot,
    assets,
    maxAssets,
    maxBudgetUsd,
    timeoutSec,
    noLlm,
    verifiedCliVersion,
    routingProbeCommand,
    sealedCwd,
    interactive,
    allowManagedPolicy,
    managedPolicies = [],
    managedPolicyParseFailures = [],
    spawnFn = spawnClaude,
  } = options;
  const now = options.now ?? new Date();

  if (!noLlm) {
    const grade = gradeManagedPolicy(managedPolicies);
    const decision = decideManagedPolicyGate(grade, {
      interactive,
      allowManagedPolicy,
      unreadablePolicyPresent: managedPolicyParseFailures.length > 0,
    });
    if (decision === "blocked") {
      throw new ManagedPolicyBlockedError(grade);
    }
  }

  const index: CatalogIndex = readCatalogIndex(catalogRoot);
  const plan = planGenTargets({ home, assets, index, maxAssets });

  const results: RunGenAssetResult[] = [];
  const injectionFindingsTotal: InjectionFindingsSummary = { directive: 0, executable: 0, url: 0, length: 0 };
  let stoppedEarly = false;
  let treeCache: Parameters<typeof captureConfigDirSnapshot>[1];
  // 통과한 실행에서도 남긴다(보안 재심 M3) — 제외가 몇 건이었는지 로그가 볼 수 있어야 한다.
  let sessionOwnedExcludedTotal = 0;
  let concurrencyOverridesTotal = 0;

  for (let i = 0; i < plan.targets.length; i++) {
    const target = plan.targets[i];
    if (target === undefined) continue;

    let generated: { annotation: Awaited<ReturnType<typeof runClaudePForTarget>>["annotation"]; docPage: Awaited<ReturnType<typeof runClaudePForTarget>>["docPage"] };

    try {
      if (noLlm) {
        generated = ruleExtract(target.asset, target.sections, now);
      } else {
        const claudeJsonBefore = readClaudeJsonRawOrNull(home.ctkConfigDir);
        const before = captureConfigDirSnapshot(home.ctkConfigDir, treeCache);
        const llmResult = await runClaudePForTarget({
          home,
          cwd: sealedCwd,
          timeoutSec,
          maxBudgetUsd,
          verifiedCliVersion,
          routingProbeCommand,
          target,
          now,
          spawnFn,
        });
        const after = captureConfigDirSnapshot(home.ctkConfigDir, before.cache);
        treeCache = after.cache;
        const audit = auditSealedLiveConfigDir(home.ctkConfigDir, before, after, claudeJsonBefore, {
          allowConcurrentSessions: options.allowConcurrentSessions,
        });
        sessionOwnedExcludedTotal += audit.sessionOwnedExcluded.length;
        if (audit.concurrencyOverrideApplied) {
          concurrencyOverridesTotal += 1;
          // 크게 알린다 — 조용히 낮추면 사용자는 감사가 돌았다고 믿는다.
          console.warn(
            `⚠️  --allow-concurrent-sessions: 자산 ${target.asset.id}에서 config dir 변경 ` +
              `${audit.verdict.violations.length}건을 위반으로 보지 않았다. ` +
              `이번 실행에서 "자식이 config를 바꿨나"는 검증되지 않았다.`,
          );
        }
        if (!sealedLiveAuditPassed(audit)) {
          throw new SealedLiveConfigDirAuditViolationError(target.asset.id, audit);
        }
        generated = { annotation: llmResult.annotation, docPage: llmResult.docPage };
      }
    } catch (err) {
      if (err instanceof ClaudePCallFailedError && looksLikeBudgetFailure(err)) {
        results.push({ assetId: target.asset.id, outcome: "pending", reason: "budget_exceeded" });
        setAssetGenState(catalogRoot, target.asset.id, "pending");
        stoppedEarly = true;
        break;
      }
      if (err instanceof ClaudePCallFailedError) {
        // ⚠️ **범위 축소(2026-08-24).** 예산 실패가 아닌 `claude -p` 실패도 전체를 중단시키고
        // 있었다. E5.12가 위생 실패에 대해 이미 내린 판단과 같다 — "거부는 옳지만 **범위가
        // 틀렸다**: 그 자산만 빼고 나머지는 처리한다".
        //
        // `stale` 재시도 규칙과 맞물리면 **영구 차단**이 된다: 한 번 실패한 자산은 `stale`로
        // 기록돼 다음 실행에서도 항상 1순위로 잡히고, 그 자산이 계속 실패하면 뒤의 자산은
        // 영영 처리되지 않는다. 실측에서 자산 하나가 큐를 통째로 막았다.
        //
        // **삼키지 않는다**(안전 원칙 7): 사유와 진단을 결과에 남기고, `stale`로 기록해 다음
        // 실행이 다시 시도하며, 호출자는 `results`의 실패 건수로 종료 코드를 정한다.
        results.push({
          assetId: target.asset.id,
          outcome: "stale",
          reason: "call_failed",
          detail: [err.message.slice(0, 500)],
        });
        setAssetGenState(catalogRoot, target.asset.id, "stale");
        continue;
      }
      throw err; // SealedLiveConfigDirAuditViolationError·SealUnverifiedCliError 등은 즉시 전체 중단.
    }

    const { annotation, docPage } = generated;

    // 인젝션 후검증을 인용 검사보다 먼저 돈다 — 둘 다 위반이면 더 심각한 쪽(인젝션)을 보고한다.
    // 인용 검사(P5, 날조 방어)와 인젝션 검사(B1-3, 신뢰 경계 방어)는 서로 다른 문제를 잡으므로
    // 순서가 findings 집계에 영향을 주지 않는다 — 둘 다 위반이면 어차피 커밋되지 않는다.
    let findings: InjectionFindingsSummary;
    try {
      findings = assertOutputFieldsClean(target.asset.id, {
        role: annotation.role,
        purpose: annotation.purpose,
        when_to_use: annotation.when_to_use,
        usage_title: docPage.title,
        usage_body: docPage.body,
      });
    } catch (err) {
      if (err instanceof InjectionPatternDetectedError) {
        results.push({ assetId: target.asset.id, outcome: "stale", reason: "injection_pattern_detected" });
        setAssetGenState(catalogRoot, target.asset.id, "stale");
        injectionFindingsTotal.directive += err.result.summary.directive;
        injectionFindingsTotal.executable += err.result.summary.executable;
        injectionFindingsTotal.url += err.result.summary.url;
        injectionFindingsTotal.length += err.result.summary.length;
        continue;
      }
      throw err;
    }
    injectionFindingsTotal.directive += findings.directive;
    injectionFindingsTotal.executable += findings.executable;
    injectionFindingsTotal.url += findings.url;
    injectionFindingsTotal.length += findings.length;

    const citationResult = checkAllCitations({
      role: annotation.role,
      purpose: annotation.purpose,
      when_to_use: annotation.when_to_use,
      usage_body: docPage.body,
    });
    if (citationResult.status === "violation") {
      // 위반 스니펫을 결과에 실어 보낸다 — 무엇이 왜 거부됐는지 안 보이면 호출자는 추측하게 되고,
      // 그 추측이 "가드가 너무 엄격하다"로 흐르면 가드를 푸는 방향으로 간다.
      results.push({
        assetId: target.asset.id,
        outcome: "stale",
        reason: "citation_missing",
        detail: citationResult.violations.slice(0, 3).map((v) => v.snippet),
      });
      setAssetGenState(catalogRoot, target.asset.id, "stale");
      continue;
    }

    writeAnnotationDoc(catalogRoot, target.asset.kind, target.asset.name, annotation);
    writeUsageDoc(catalogRoot, target.asset.kind, target.asset.name, docPage);
    setAssetGenState(catalogRoot, target.asset.id, "fresh", target.sourceContentSha256);
    results.push({ assetId: target.asset.id, outcome: "fresh" });
  }

  if (stoppedEarly) {
    for (const remaining of plan.targets.slice(results.length)) {
      setAssetGenState(catalogRoot, remaining.asset.id, "pending");
      results.push({ assetId: remaining.asset.id, outcome: "pending" });
    }
  }

  // §4 Step 4 부분 실패 규약 ① — 인덱스는 실행 종료 시점에 1회만 재생성한다(성공·budget_exceeded·
  // 중단 모두 포함).
  const { path: indexPath } = rebuildCatalogIndex(catalogRoot);

  return {
    plan,
    results,
    stoppedEarly,
    injectionFindingsTotal,
    sealAudit: {
      sessionOwnedExcluded: sessionOwnedExcludedTotal,
      concurrencyOverrides: concurrencyOverridesTotal,
    },
    indexPath,
  };
}

export type { GenPlanTarget };

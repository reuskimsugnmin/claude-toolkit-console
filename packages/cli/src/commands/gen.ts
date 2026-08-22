import { createInterface } from "node:readline/promises";
import { resolveHomeContext } from "@ctk/probe";
import { readManagedPolicies } from "@ctk/probe";
import {
  acquireLock,
  commitAll,
  listAllAssets,
  readCatalogConfig,
  readCatalogIndex,
  writeRunLog,
} from "@ctk/sync";
import { gradeManagedPolicy } from "@ctk/core";
import { estimateGenCost, planGenTargets, runGen, type RunGenSummary } from "@ctk/gen";
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
  timeoutSec?: number;
  resume?: boolean;
  noLlm?: boolean;
  allowManagedPolicy?: boolean;
  yes?: boolean;
  routingProbeCommand?: string;
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
  emptyAssetIds: string[];
  /** 파일 위생(심볼릭 링크·크기 상한)에 걸려 건너뛴 자산. 조용히 빼지 않는다. */
  skipped: { assetId: string; failureClass: string; reason: string }[];
}

/** `--dry-run` — 파일 직독만. API 호출도 서브프로세스 spawn도 하지 않는다(AC-3.8). */
export function runGenDryRun(options: { maxAssets?: number } = {}): GenDryRunReport {
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;

  const assets = listAllAssets(catalogPath);
  const index = readCatalogIndex(catalogPath);
  const plan = planGenTargets({ home, assets, index, maxAssets: options.maxAssets });
  const approxBytes = plan.targets.reduce(
    (sum, t) => sum + t.sections.reduce((s, sec) => s + Buffer.byteLength(sec.content, "utf8"), 0),
    0,
  );
  return { assetCount: plan.targets.length, approxBytes, emptyAssetIds: plan.emptyAssetIds, skipped: plan.skipped };
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
    const assets = listAllAssets(catalogPath);
    const index = readCatalogIndex(catalogPath);
    const plan = planGenTargets({ home, assets, index, maxAssets: options.maxAssets });

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
      });

      console.log(`ctk gen — 대상 자산 ${estimate.assetCount}건, claude -p 호출 ${estimate.callCount}회 예정`);
      console.log(
        estimate.estimatedInputTokens !== null
          ? `  예상 입력 토큰: ${estimate.estimatedInputTokens}tok (근사 비용: $${(estimate.approxCostUsd ?? 0).toFixed(4)}, 참고치 — 실제 상한은 각 호출의 --max-budget-usd=${options.maxBudgetUsd})`
          : `  예상 입력 토큰: 측정 불가 — approx_bytes=${estimate.approxBytes} (토큰 아님, count_tokens 크레덴셜 없음)`,
      );
      if (plan.skipped.length > 0) {
        // 위생 거부는 "생성 안 됨"의 이유가 다르므로 빈 자산과 분리해 보여준다.
        console.log(`  위생 검사가 거부해 건너뛴 자산 ${plan.skipped.length}건:`);
        for (const s of plan.skipped) console.log(`    - ${s.assetId} (${s.failureClass})`);
      }
      if (plan.emptyAssetIds.length > 0) {
        console.log(`  원본을 찾지 못해 건너뛴 자산: ${plan.emptyAssetIds.join(", ")}`);
      }

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
            indexPath: "",
          };
        }
      }
    }

    const summary = await runGen({
      home,
      catalogRoot: catalogPath,
      assets,
      maxAssets: options.maxAssets,
      maxBudgetUsd: options.maxBudgetUsd,
      timeoutSec: options.timeoutSec,
      noLlm: options.noLlm === true,
      verifiedCliVersion: catalogConfig.verified_cli_version,
      routingProbeCommand: options.routingProbeCommand,
      sealedCwd: ensureSealedLiveCwd(),
      interactive,
      allowManagedPolicy: options.allowManagedPolicy === true,
      managedPolicies,
      managedPolicyParseFailures: managed.parseFailures,
    });

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
      },
      machine_id: machine.machine_id,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      exit_code: 0,
      failure_class: summary.stoppedEarly ? "budget_exceeded" : null,
      seal_profile: options.noLlm === true ? "test-isolated" : "sealed-live",
      injection_findings: summary.injectionFindingsTotal,
    });

    if (summary.results.some((r) => r.outcome === "fresh")) {
      commitAll(catalogPath, `ctk gen: ${startedAt.toISOString()}`);
    }

    return summary;
  } finally {
    lock.release();
  }
}

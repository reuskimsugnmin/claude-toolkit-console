#!/usr/bin/env node
// ctk CLI 진입점. 커맨드 표면은 plan §4.1 "CLI 표면 정의" 표를 따른다:
// init · scan · measure · gen · agent-probe · move · rollback · usage · web · doctor · verify.
// Step 2에서 구현: init · scan · doctor(--drift) · verify(ac1). 나머지는 이후 단계.
//
// 승인된 런타임 의존성이 zod 하나뿐이라(착수 조건 C5) CLI 파서 라이브러리를 쓰지 않고 argv를
// 직접 파싱한다 — 이 표면이 커지면 재검토 대상이다.

import { runInit } from "../src/commands/init.js";
import { runScan, CatalogNotInitializedError } from "../src/commands/scan.js";
import { runGenCli, runGenDryRun, MissingRequiredFlagError } from "../src/commands/gen.js";
import { runAgentProbeCli } from "../src/commands/agent-probe.js";
import { runVerifySeal } from "../src/commands/verify-seal.js";
import {
  runDoctorDrift,
  runDoctorInterruptedRestores,
  runDoctorSubagentAttribution,
  formatInterruptedRestoreAlert,
  NoSnapshotsError,
} from "../src/commands/doctor.js";
import { runVerifyAc1, NotYetScannedError } from "../src/commands/verify-ac1.js";
import { runVerifyAc3, SkillSourceNotFoundError } from "../src/commands/verify-ac3.js";
import { runMove, AssetNotFoundError, NoOpMoveError, ProjectIndexOutOfRangeError } from "../src/commands/move.js";
import { runRollback, NoRollbackTargetError } from "../src/commands/rollback.js";
import { runMeasure } from "../src/commands/measure.js";
import { runUsage, NoMeasurementError } from "../src/commands/usage.js";
import { runExportViewModel, runWebServe } from "../src/commands/web.js";
import { LockContendedError } from "@ctk/sync";
import { DuplicateKeyDiffError } from "@ctk/core";
import { McpMoveRejectedError, CliToolMoveUnsupportedError, RollbackFailedError } from "@ctk/actuator";

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  try {
    switch (command) {
      case "init": {
        const catalog = readFlagValue(rest, "--catalog");
        const machineAlias = readFlagValue(rest, "--machine-alias");
        const result = await runInit({ catalog, machineAlias });
        console.log(
          `ctk init ${result.created ? "완료" : "이미 초기화됨(카탈로그 설정 확인)"} — catalog: ${result.catalogPath}, machine_id: ${result.machineId}`,
        );
        return;
      }
      case "scan": {
        const summary = await runScan();
        console.log(`ctk scan 완료 (${summary.durationMs}ms)`);
        console.log(`  스냅샷: ${summary.snapshotPath}`);
        console.log(`  실행 로그: ${summary.runLogPath}`);
        console.log(
          `  자산: plugin=${summary.assetCounts.plugin} skill=${summary.assetCounts.skill} mcp=${summary.assetCounts.mcp} cli=${summary.assetCounts.cli}`,
        );
        console.log(`  Installation: ${summary.installationCount}건, Toggle: ${summary.toggleCount}건`);
        console.log(`  스코프 분포: ${JSON.stringify(summary.scopeDistribution)}`);
        return;
      }
      case "doctor": {
        // §7.2 — 중단된 복원은 다른 어떤 요약보다 먼저 표시한다. 대상 자리가 비어 보이지만
        // 사본이 남아 있는 유일한 상태이므로, 이 경보가 묻히면 복구 가능한 상황을 손실로 오인한다.
        const alert = formatInterruptedRestoreAlert(runDoctorInterruptedRestores());
        if (alert !== null) {
          console.error(alert);
          console.error("");
        }
        // R17 — 가장 최근 `ctk measure`가 Agent tool_use 건수 대비 신규 subagent 파일 수 괴리를
        // 남겼으면 여기서 노출한다(수용 기준: "subagent_attribution: unresolved + ctk doctor 노출").
        const subagentGap = runDoctorSubagentAttribution();
        if (subagentGap !== null) {
          console.error(
            `⚠️  R17 서브에이전트 귀속 괴리 (${subagentGap.runLogFile}) — Agent tool_use ${subagentGap.agentToolUseCount}건 vs ` +
              `신규 subagent 파일 ${subagentGap.newSubagentFiles}건. 해당 실행 범위에서 일부 서브에이전트 호출을 미확인.`,
          );
          console.error("");
        }
        if (rest.includes("--drift")) {
          const drift = runDoctorDrift();
          console.log(`드리프트 (${drift.fromSnapshot} → ${drift.toSnapshot})`);
          console.log(`  유입: ${drift.added.length > 0 ? drift.added.join(", ") : "(없음)"}`);
          console.log(`  이탈: ${drift.removed.length > 0 ? drift.removed.join(", ") : "(없음)"}`);
          console.log(`  무변경: ${drift.unchangedCount}건`);
          return;
        }
        console.error("사용법: ctk doctor --drift");
        process.exitCode = 1;
        return;
      }
      case "web": {
        const exportPath = readFlagValue(rest, "--export-view-model");
        if (exportPath === undefined) {
          const portFlag = readFlagValue(rest, "--port");
          const server = await runWebServe({ port: portFlag === undefined ? 0 : Number(portFlag) });
          console.log(`ctk web (조회 전용) — ${server.url}`);
          console.log("  GET/HEAD만 응답한다. 쓰기 액션은 아직 없다(Step 6b).");
          console.log("  Ctrl+C로 종료한다 — 데몬으로 상주하지 않는다.");
          // 포그라운드 프로세스로 남는다(ADR-003 데몬 불변식). 여기서 return하면 이벤트 루프가
          // 살아 있는 동안 프로세스가 유지된다.
          return;
        }
        const result = runExportViewModel(exportPath);
        console.log(`뷰모델 출력 완료 — ${result.path}`);
        console.log(`  자산 ${result.assetCount}건`);
        console.log(
          `  사용량 순위 ${result.rankedCount}건 · 순위 불가(미측정/근사) ${result.unrankableCount}건`,
        );
        console.log(
          result.freshnessDays === null
            ? "  마지막 스캔: 기록 없음"
            : `  마지막 스캔: ${result.freshnessDays}일 전`,
        );
        // 순위가 결론으로 읽힐 자격이 없으면 그 사실을 숫자보다 먼저 말한다.
        const quality = result.rankingQuality;
        if (!quality.is_meaningful) {
          const why =
            quality.reason === "no_measured_assets"
              ? "점유가 측정된 자산이 없다"
              : `점유가 측정된 ${quality.measured_count}건이 전부 0토큰이다`;
          console.log(
            `  ⚠️  "안 쓰는데 비싼 툴" 순위는 아직 결론이 될 수 없다 — ${why} ` +
              `(미측정 ${quality.unmeasured_count}건). \`ctk measure\`에 count_tokens 크레덴셜이 필요하다.`,
          );
        }
        return;
      }
      case "verify": {
        if (rest[0] === "seal") {
          const budget = readFlagValue(rest, "--max-budget-usd");
          const timeout = readFlagValue(rest, "--timeout-sec");
          const pluginCmd = readFlagValue(rest, "--installed-plugin-command");
          const report = await runVerifySeal({
            maxBudgetUsd: budget !== undefined ? Number(budget) : undefined,
            timeoutSec: timeout !== undefined ? Number(timeout) : undefined,
            installedPluginCommand: pluginCmd,
          });
          const sig = report.result.signals;
          console.log(`ctk verify seal — 검증 ${report.previousVerifiedVersion} → 실제 ${report.actualVersion}`);
          console.log(`  양성 대조군(탐지 가능한가): ${sig.positiveControlDetected ? "통과" : "실패"}`);
          console.log(`  (i) 훅 마커 미생성: ${sig.hookMarkerAbsent ? "통과" : "실패"}`);
          console.log(`  (ii) CLAUDE.md 미로드: ${sig.claudeMdStringAbsent ? "통과" : "실패"}`);
          console.log(`  (iii) 플러그인 커맨드 미인식: ${sig.installedPluginCommandUnrecognized ? "통과" : "실패"}`);
          if (report.updated) {
            console.log(`  ✅ 봉인 재증명 완료 — verified_cli_version을 ${report.actualVersion}로 갱신했다`);
          } else {
            console.error(`  ❌ 봉인 재증명 실패 — 기록을 갱신하지 않았다(봉인이 깨진 채 통과시키지 않는다)`);
            process.exitCode = 1;
          }
          return;
        }
        if (rest[0] === "ac1") {
          const report = await runVerifyAc1();
          console.log(
            `AC-1.1 독립 대조(plugin) — 스냅샷 ${report.snapshotPluginCount}건 vs 재구성 ${report.reconstructedPluginCount}건`,
          );
          if (report.independentPluginIdsMatch) {
            console.log("  일치 — diff 0건");
          } else {
            console.log(`  불일치 — 스냅샷에만: ${report.onlyInSnapshot.join(", ")}`);
            console.log(`  불일치 — 재구성에만: ${report.onlyInReconstruction.join(", ")}`);
            process.exitCode = 1;
          }
          return;
        }
        if (rest[0] === "ac3") {
          const report = await runVerifyAc3({ skillPath: readFlagValue(rest, "--skill") });
          console.log(`AC-3 진입 스킬 검증 — ${report.name}`);

          // AC-3.1 — 상한 비교는 measured일 때만 성립한다. 미측정을 통과로 인쇄하지 않는다.
          if (report.budgetValue.state === "measured") {
            const verdict = report.budgetExceeded === true ? "초과" : "이내";
            console.log(
              `  AC-3.1 상시 비용: ${report.budgetValue.value_tokens} 토큰 / 상한 ${report.budgetTokens} — ${verdict}`,
            );
          } else if (report.budgetValue.state === "unmeasured") {
            console.log(
              `  AC-3.1 상시 비용: 미측정(reason: ${report.budgetValue.reason}) — 상한 ${report.budgetTokens}과 비교하지 못했다`,
            );
          } else {
            console.log(`  AC-3.1 상시 비용: approx_bytes=${report.budgetValue.approx_bytes} (토큰 아님)`);
          }

          // AC-3.2 — 두 규칙의 상태를 따로 출력한다. 이름 대조 미실행을 "위반 0건"과 같은 줄에
          // 쓰면 검사하지 않은 것이 통과로 읽힌다.
          const pathViolations = report.lint.violations.filter((v) => v.rule === "concrete_asset_path");
          const nameViolations = report.lint.violations.filter((v) => v.rule === "asset_name_literal");
          console.log(`  AC-3.2 구체 자산 경로: 위반 ${pathViolations.length}건`);
          if (report.lint.nameCheck.state === "checked") {
            console.log(
              `  AC-3.2 자산 이름 리터럴: 위반 ${nameViolations.length}건 (카탈로그 자산 ${report.lint.nameCheck.namesCompared}개와 대조)`,
            );
          } else {
            console.log(
              `  AC-3.2 자산 이름 리터럴: 미검사(reason: ${report.lint.nameCheck.reason}) — 카탈로그가 없어 대조하지 못했다`,
            );
          }
          for (const violation of report.lint.violations) {
            console.error(`    ${report.skillPath}:${violation.line} [${violation.rule}] ${violation.match} — ${violation.note}`);
          }
          if (report.hasViolation) process.exitCode = 1;
          return;
        }
        console.error("사용법: ctk verify ac1 | ac3 [--skill <경로>] | seal");
        process.exitCode = 1;
        return;
      }
      case "move": {
        const assetId = readFlagValue(rest, "--asset");
        const to = readFlagValue(rest, "--to");
        if (!assetId || (to !== "user" && to !== "project")) {
          console.error("사용법: ctk move --asset <id> --to <user|project> [--project-index N] [--from <user|project>] [--from-project-index N]");
          process.exitCode = 1;
          return;
        }
        const toProjectIndexRaw = readFlagValue(rest, "--project-index");
        const fromRaw = readFlagValue(rest, "--from");
        const fromProjectIndexRaw = readFlagValue(rest, "--from-project-index");
        const summary = await runMove({
          assetId,
          to,
          toProjectIndex: toProjectIndexRaw !== undefined ? Number(toProjectIndexRaw) : undefined,
          from: fromRaw === "user" || fromRaw === "project" ? fromRaw : undefined,
          fromProjectIndex: fromProjectIndexRaw !== undefined ? Number(fromProjectIndexRaw) : undefined,
        });
        console.log(`ctk move 완료 — ${summary.assetId}(${summary.kind}) ${summary.from} -> ${summary.to}`);
        console.log(`  journal: ${summary.journalPath}`);
        return;
      }
      case "rollback": {
        if (!rest.includes("--last")) {
          console.error("사용법: ctk rollback --last");
          process.exitCode = 1;
          return;
        }
        const summary = await runRollback({ last: true });
        console.log(`ctk rollback 완료 — ${summary.assetId}(${summary.action}) 되돌림`);
        console.log(`  journal: ${summary.journalPath}`);
        return;
      }
      case "measure": {
        const transcriptsDir = readFlagValue(rest, "--transcripts");
        const noCredentialsOk = rest.includes("--no-credentials-ok");
        const summary = await runMeasure({ transcriptsDir, noCredentialsOk });
        console.log(`ctk measure 완료 (${summary.durationMs}ms)`);
        console.log(`  스냅샷: ${summary.snapshotPath}`);
        console.log(`  실행 로그: ${summary.runLogPath}`);
        console.log(
          `  트랜스크립트: ${summary.transcriptFilesParsed}개 파일 (파싱 실패 ${summary.parseFailureCount}건)`,
        );
        console.log(
          `  UsageMetric: ${summary.usageMetricCount}건 · SessionUsage: ${summary.sessionUsageCount}건 · Occupancy: ${summary.occupancyCount}건`,
        );
        console.log(
          `  미귀속 호출: ${summary.unattributedCallCount}건 · occupancy_divergence: ${summary.occupancyDivergenceCount}건 · usage_divergence: ${summary.usageDivergenceCount}건`,
        );
        console.log(
          `  R17 대조(이번 실행 범위) — Agent tool_use: ${summary.agentToolUseCountThisRun}건 vs 신규 subagent 파일: ${summary.newSubagentFilesThisRun}건` +
            (summary.subagentAttributionGap ? " ⚠️ 괴리" : " 일치"),
        );
        console.log(`  크레덴셜(ANTHROPIC_API_KEY): ${summary.credentialsAvailable ? "있음" : "없음(unmeasured로 열화)"}`);
        return;
      }
      case "gen": {
        const maxAssets = readFlagValue(rest, "--max-assets");
        if (rest.includes("--dry-run")) {
          // AC-3.8 — 네트워크 호출 0 · 서브프로세스 spawn 0. 파일 직독만 한다.
          const report = runGenDryRun({ maxAssets: maxAssets !== undefined ? Number(maxAssets) : undefined });
          console.log(`ctk gen --dry-run (로컬 전용 미리보기 — 네트워크·spawn 없음)`);
          console.log(`  생성 대상: ${report.assetCount}건 · 원본 크기 합계: ${report.approxBytes} bytes`);
          if (report.emptyAssetIds.length > 0) {
            console.log(`  ⚠️ 원본이 비어 생성 불가: ${report.emptyAssetIds.length}건`);
          }
          return;
        }
        const budget = readFlagValue(rest, "--max-budget-usd");
        const timeout = readFlagValue(rest, "--timeout-sec");
        const summary = await runGenCli({
          maxAssets: maxAssets !== undefined ? Number(maxAssets) : undefined,
          maxBudgetUsd: budget !== undefined ? Number(budget) : undefined,
          timeoutSec: timeout !== undefined ? Number(timeout) : undefined,
          resume: rest.includes("--resume"),
          noLlm: rest.includes("--no-llm"),
          allowManagedPolicy: rest.includes("--allow-managed-policy"),
          yes: rest.includes("--yes"),
        });
        const fresh = summary.results.filter((r) => r.outcome === "fresh").length;
        const pending = summary.results.filter((r) => r.outcome === "pending").length;
        const stale = summary.results.filter((r) => r.outcome === "stale").length;
        console.log(`ctk gen 완료 — 최신 ${fresh}건 · 미처리 ${pending}건 · 갱신필요 ${stale}건`);
        // 건너뛴 자산은 이유를 그대로 노출한다 — "처리됨"과 "조용히 빠짐"을 구분한다(안전 원칙 6).
        for (const r of summary.results.filter((x) => x.reason !== undefined)) {
          console.log(`    ${r.assetId}: ${r.reason}`);
          for (const d of r.detail ?? []) console.log(`        └ ${d}`);
        }
        if (summary.stoppedEarly) {
          console.log(`  ⚠️ 예산 초과로 조기 종료 — 남은 대상은 \`ctk gen --resume\`으로 이어서 처리한다`);
        }
        const inj = summary.injectionFindingsTotal;
        console.log(
          `  인젝션 후검증 — 지시문 ${inj.directive} · 실행명령 ${inj.executable} · URL ${inj.url} · 길이 ${inj.length}`,
        );
        console.log(`  인덱스: ${summary.indexPath}`);
        return;
      }
      case "agent-probe": {
        const catalog = readFlagValue(rest, "--catalog");
        const query = readFlagValue(rest, "--query");
        const budget = readFlagValue(rest, "--max-budget-usd");
        const timeout = readFlagValue(rest, "--timeout-sec");
        if (catalog === undefined || query === undefined) {
          console.error('사용법: ctk agent-probe --catalog <경로> --query "<질의>" --max-budget-usd <수치> --timeout-sec <초>');
          process.exitCode = 1;
          return;
        }
        const result = await runAgentProbeCli({
          catalog,
          query,
          maxBudgetUsd: budget !== undefined ? Number(budget) : undefined,
          timeoutSec: timeout !== undefined ? Number(timeout) : undefined,
        });
        console.log(`ctk agent-probe (AC-3.3 진단 — 카탈로그·config에 쓰지 않음)`);
        console.log(`  exit=${result.exitCode ?? "null"}${result.timedOut ? " (타임아웃)" : ""}`);
        console.log(result.stdout);
        return;
      }
      case "usage": {
        const nRaw = readFlagValue(rest, "--unused-expensive");
        const n = nRaw !== undefined ? Number(nRaw) : 5;
        const report = runUsage({ unusedExpensive: n });
        const asJson = rest.includes("--json");
        if (asJson) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(`ctk usage --unused-expensive ${n} — 스냅샷 ${report.snapshotId}`);
        for (const row of report.rows) {
          console.log(
            `  ${row.asset_id}: idle=${row.idle_tokens}tok call_count=${row.call_count} last_used_at=${row.last_used_at ?? "(없음)"} ` +
              `token_sum=${row.token_sum} attribution=${row.attribution_source ?? "(없음)"}/${row.attribution_rule ?? "(없음)"} ` +
              `(스냅샷:${row.snapshot_id}, 파싱한 트랜스크립트:${row.transcript_files_parsed}개)`,
          );
        }
        if (report.excludedUnmeasuredAssetIds.length > 0) {
          console.log(`  순위 제외(occupancy 미측정): ${report.excludedUnmeasuredAssetIds.join(", ")}`);
        }
        return;
      }
      default: {
        console.error(`알 수 없는 명령: ${command ?? "(없음)"}`);
        console.error("사용법: ctk <init|scan|measure|usage|doctor|verify|move|rollback> [...args]");
        process.exitCode = 1;
        return;
      }
    }
  } catch (err) {
    if (err instanceof MissingRequiredFlagError) {
      // 예산·타임아웃 미지정은 기본값으로 때우지 않고 거부한다 — 무인 실행에서 상한 없는
      // 유료 세션이 도는 것이 이 프로젝트가 막으려는 실패 모드다(전역 CLAUDE.md 비용 규칙).
      console.error(`FAIL missing_required_flag: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (err instanceof LockContendedError) {
      console.error(`FAIL lock_contended: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (
      err instanceof CatalogNotInitializedError ||
      err instanceof NoSnapshotsError ||
      err instanceof NotYetScannedError ||
      err instanceof AssetNotFoundError ||
      err instanceof NoOpMoveError ||
      err instanceof ProjectIndexOutOfRangeError ||
      err instanceof NoRollbackTargetError ||
      err instanceof NoMeasurementError ||
      err instanceof SkillSourceNotFoundError
    ) {
      console.error(`FAIL: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (err instanceof McpMoveRejectedError || err instanceof CliToolMoveUnsupportedError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    if (err instanceof RollbackFailedError) {
      console.error(`FAIL rollback_failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (err instanceof DuplicateKeyDiffError) {
      console.error(`FAIL duplicate_snapshot_key: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    // ⚠️ Step 5 보안 심사 수정(AC-2.6) — 위 분기들은 알려진 몇몇 클래스만 처리한다. 이 프로젝트가
    // 늘려온 failure_class 타입 오류(ForbiddenPathWriteError·WhitelistViolationError·
    // ConfigClobberedError·BackupManifestTamperedError·ForbiddenRestoreTargetError·
    // SkillLocationAmbiguousError 등)가 여기 개별 분기로 추가되지 않으면, 이전에는 순수
    // err.message만 찍혀 어떤 실패 분류였는지 stdout/stderr에서 전혀 드러나지 않았다 — §7의
    // 관측 가능성이 CLI 최종 출력에서는 끊겨 있었던 셈이다. `failureClass` 필드가 있는 오류는
    // 여기서 그 값을 일반적으로 찍는다(개별 분기가 없는 새 오류 클래스가 추가돼도 자동으로
    // 커버된다) — AC-2.6 주입 테스트가 "stdout/stderr에 failure_class 문자열 출현"을 확인한다.
    if (typeof err === "object" && err !== null && "failureClass" in err && typeof (err as { failureClass: unknown }).failureClass === "string") {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`FAIL ${(err as { failureClass: string }).failureClass}: ${message}`);
      process.exitCode = 1;
      return;
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]?.endsWith("ctk.ts") || process.argv[1]?.endsWith("ctk.js");
if (isMain) {
  void main();
}

export { main };

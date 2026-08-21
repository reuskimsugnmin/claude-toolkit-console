#!/usr/bin/env node
// ctk CLI 진입점. 커맨드 표면은 plan §4.1 "CLI 표면 정의" 표를 따른다:
// init · scan · measure · gen · agent-probe · move · rollback · usage · web · doctor · verify.
// Step 2에서 구현: init · scan · doctor(--drift) · verify(ac1). 나머지는 이후 단계.
//
// 승인된 런타임 의존성이 zod 하나뿐이라(착수 조건 C5) CLI 파서 라이브러리를 쓰지 않고 argv를
// 직접 파싱한다 — 이 표면이 커지면 재검토 대상이다.

import { runInit } from "../src/commands/init.js";
import { runScan, CatalogNotInitializedError } from "../src/commands/scan.js";
import {
  runDoctorDrift,
  runDoctorInterruptedRestores,
  formatInterruptedRestoreAlert,
  NoSnapshotsError,
} from "../src/commands/doctor.js";
import { runVerifyAc1, NotYetScannedError } from "../src/commands/verify-ac1.js";
import { runMove, AssetNotFoundError, NoOpMoveError, ProjectIndexOutOfRangeError } from "../src/commands/move.js";
import { runRollback, NoRollbackTargetError } from "../src/commands/rollback.js";
import { runMeasure } from "../src/commands/measure.js";
import { runUsage, NoMeasurementError } from "../src/commands/usage.js";
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
      case "verify": {
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
        console.error("사용법: ctk verify ac1");
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
      err instanceof NoMeasurementError
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

#!/usr/bin/env node
// ctk CLI 진입점. 커맨드 표면은 plan §4.1 "CLI 표면 정의" 표를 따른다:
// init · scan · measure · gen · agent-probe · move · rollback · usage · web · doctor · verify.
// Step 2에서 구현: init · scan · doctor(--drift) · verify(ac1). 나머지는 이후 단계.
//
// 승인된 런타임 의존성이 zod 하나뿐이라(착수 조건 C5) CLI 파서 라이브러리를 쓰지 않고 argv를
// 직접 파싱한다 — 이 표면이 커지면 재검토 대상이다.

import { runInit } from "../src/commands/init.js";
import { runScan, CatalogNotInitializedError } from "../src/commands/scan.js";
import { runDoctorDrift, NoSnapshotsError } from "../src/commands/doctor.js";
import { runVerifyAc1, NotYetScannedError } from "../src/commands/verify-ac1.js";
import { LockContendedError } from "@ctk/sync";
import { DuplicateKeyDiffError } from "@ctk/core";

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
      default: {
        console.error(`알 수 없는 명령: ${command ?? "(없음)"}`);
        console.error("사용법: ctk <init|scan|doctor|verify> [...args]");
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
    if (err instanceof CatalogNotInitializedError || err instanceof NoSnapshotsError || err instanceof NotYetScannedError) {
      console.error(`FAIL: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (err instanceof DuplicateKeyDiffError) {
      console.error(`FAIL duplicate_snapshot_key: ${err.message}`);
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

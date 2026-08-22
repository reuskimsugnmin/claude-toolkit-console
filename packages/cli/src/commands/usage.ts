import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  assessRankingQuality,
  machineDir,
  parseSessionUsage,
  parseUsageMetric,
  rankUnusedExpensive,
  type RankingQualityView,
  type SessionUsage,
  type UsageMetric,
} from "@ctk/core";
import { resolveHomeContext } from "@ctk/probe";
import { listAllOccupancy } from "@ctk/sync";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { CatalogNotInitializedError } from "./scan.js";

/**
 * cli/src/commands/usage.ts — `ctk usage --unused-expensive N` (AC-4.6). `ctk measure`가 마지막으로
 * 쓴 스냅샷(UsageMetric/SessionUsage 포함)을 찾아 core/usage/rank.ts로 순위를 계산한다.
 */
export class NoMeasurementError extends Error {
  constructor() {
    super("사용량 측정 기록이 없다 — 먼저 `ctk measure`를 실행해야 한다.");
    this.name = "NoMeasurementError";
  }
}

function isUsageMetricLine(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && "call_count" in raw && !("__kind" in raw);
}

function isSessionUsageLine(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && "__kind" in raw && (raw as { __kind: unknown }).__kind === "session_usage";
}

interface LatestMeasureSnapshot {
  snapshotId: string;
  usageMetrics: UsageMetric[];
  sessionUsage: SessionUsage[];
}

/** 가장 최근 `measure` run-log에서 `args.counts.transcript_files`(근거 필드, AC-4.6)를 읽는다. */
function findLatestMeasureTranscriptFileCount(catalogPath: string, machineId: string): number {
  const runsDir = path.join(catalogPath, machineDir(machineId), "runs");
  let files: string[];
  try {
    files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return 0;
  }
  for (const file of files) {
    const rawLines = readFileSync(path.join(runsDir, file), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { command?: string; args?: { counts?: { transcript_files?: number } } });
    for (const entry of rawLines.reverse()) {
      if (entry.command === "measure" && typeof entry.args?.counts?.transcript_files === "number") {
        return entry.args.counts.transcript_files;
      }
    }
  }
  return 0;
}

/** 가장 최근 측정 스냅샷(UsageMetric이 실제로 담긴 파일)을 찾는다 — `scan`이 남긴 스냅샷은 건너뛴다. */
function findLatestMeasureSnapshot(catalogPath: string, machineId: string): LatestMeasureSnapshot | null {
  const snapshotsDir = path.join(catalogPath, machineDir(machineId), "snapshots");
  let files: string[];
  try {
    files = readdirSync(snapshotsDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return null;
  }

  for (const file of files) {
    const absPath = path.join(snapshotsDir, file);
    const rawLines = readFileSync(absPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as unknown);

    const usageMetrics: UsageMetric[] = [];
    const sessionUsage: SessionUsage[] = [];
    for (const raw of rawLines) {
      if (isUsageMetricLine(raw)) {
        try {
          usageMetrics.push(parseUsageMetric(raw));
        } catch {
          // 이 스냅샷은 usage 파일이 아니었다 — 다음 스냅샷으로.
        }
      } else if (isSessionUsageLine(raw)) {
        try {
          sessionUsage.push(parseSessionUsage(raw));
        } catch {
          // 무시 — session_usage 판별 실패는 usage 순위에 영향 없음.
        }
      }
    }
    if (usageMetrics.length > 0 || sessionUsage.length > 0) {
      return { snapshotId: file, usageMetrics, sessionUsage };
    }
  }
  return null;
}

export interface UsageReportRow {
  asset_id: string;
  call_count: number;
  last_used_at: string | null;
  idle_tokens: number;
  token_sum: number;
  attribution_source: string | null;
  attribution_rule: string | null;
  snapshot_id: string;
  transcript_files_parsed: number;
}

export interface UsageReport {
  rows: UsageReportRow[];
  excludedUnmeasuredAssetIds: string[];
  snapshotId: string;
  /**
   * 이 순위를 결론으로 제시할 수 있는가. **`ctk web --export-view-model`은 이 판정을 싣는데
   * CLI는 싣지 않았다**(안전 원칙 5 — 방어를 만든 것과 모든 경로에 배선한 것은 다르다).
   *
   * 크레덴셜이 없으면 대부분의 자산이 `unmeasured`로 빠지고 **비용이 정말로 0인 것만 순위에
   * 남는다.** 개별 숫자는 다 맞는데 "안 쓰는데 비싼 툴"이라는 질문에는 거짓이 된다(원칙 8).
   * 두 경로가 각자 판정하면 어긋나므로 `core`의 같은 함수를 쓴다.
   */
  rankingQuality: RankingQualityView;
}

export function runUsage(options: { unusedExpensive: number }): UsageReport {
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;
  const machine = readOrCreateMachineIdentity(home, "local-machine");

  const latest = findLatestMeasureSnapshot(catalogPath, machine.machine_id);
  if (latest === null) throw new NoMeasurementError();

  const occupancy = listAllOccupancy(catalogPath);
  const { ranked, excludedUnmeasuredAssetIds } = rankUnusedExpensive({
    usage: latest.usageMetrics,
    occupancy,
    limit: options.unusedExpensive,
  });

  const transcriptFilesParsed = findLatestMeasureTranscriptFileCount(catalogPath, machine.machine_id);
  const rankingQuality = assessRankingQuality(
    ranked.map((r) => r.idle_tokens),
    excludedUnmeasuredAssetIds.length,
  );
  const rows: UsageReportRow[] = ranked.map((r) => ({
    ...r,
    snapshot_id: latest.snapshotId,
    transcript_files_parsed: transcriptFilesParsed,
  }));

  return { rows, excludedUnmeasuredAssetIds, snapshotId: latest.snapshotId, rankingQuality };
}

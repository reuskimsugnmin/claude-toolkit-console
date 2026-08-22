import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { diffById, machineDir, parseInstallation, type Installation } from "@ctk/core";
import { resolveHomeContext } from "@ctk/probe";
import { findInterruptedRestores, type InterruptedRestore } from "@ctk/actuator";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";

export class NoSnapshotsError extends Error {
  constructor() {
    super("드리프트를 계산하려면 스냅샷이 2개 이상 필요하다 — `ctk scan`을 두 번 이상 실행하라.");
    this.name = "NoSnapshotsError";
  }
}

function isInstallationLine(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !("__kind" in raw);
}

function readInstallationsFromSnapshot(absPath: string): Installation[] {
  const lines = readFileSync(absPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const installations: Installation[] = [];
  for (const line of lines) {
    const raw = JSON.parse(line) as unknown;
    if (!isInstallationLine(raw)) continue; // toggle 레코드(__kind:"toggle")는 건너뛴다.
    try {
      installations.push(parseInstallation(raw));
    } catch {
      // Project 등 다른 레코드 종류일 수 있다 — Installation으로 파싱 안 되면 건너뛴다.
    }
  }
  return installations;
}

function installationKey(inst: Installation): string {
  return `${inst.asset_id}|${inst.install_scope ?? ""}|${inst.project_path_hash ?? ""}`;
}

export interface DriftSummary {
  fromSnapshot: string;
  toSnapshot: string;
  added: string[];
  removed: string[];
  unchangedCount: number;
}

/** `ctk doctor --drift` — 마지막 두 스냅샷 diff로 "기록 없이 유입/이탈한 툴"을 표시한다(Step 2). */
export function runDoctorDrift(): DriftSummary {
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) {
    throw new Error("카탈로그가 초기화되지 않았다 — 먼저 `ctk init`을 실행해야 한다.");
  }
  const machine = readOrCreateMachineIdentity(home, "local-machine");
  const snapshotsDir = path.join(localConfig.catalog_path, machineDir(machine.machine_id), "snapshots");

  let files: string[];
  try {
    files = readdirSync(snapshotsDir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    files = [];
  }
  if (files.length < 2) {
    throw new NoSnapshotsError();
  }

  const fromFile = files[files.length - 2];
  const toFile = files[files.length - 1];
  if (fromFile === undefined || toFile === undefined) {
    throw new NoSnapshotsError();
  }

  const before = readInstallationsFromSnapshot(path.join(snapshotsDir, fromFile));
  const after = readInstallationsFromSnapshot(path.join(snapshotsDir, toFile));
  const diff = diffById(before, after, installationKey);

  return {
    fromSnapshot: fromFile,
    toSnapshot: toFile,
    added: diff.added.map((i) => i.asset_id),
    removed: diff.removed.map((i) => i.asset_id),
    unchangedCount: diff.unchanged.length,
  };
}

export interface SubagentAttributionGapReport {
  runLogFile: string;
  agentToolUseCount: number;
  newSubagentFiles: number;
}

interface MeasureRunLogEntry {
  command?: string;
  failure_class?: string | null;
  args?: { counts?: { agent_tool_use_count_this_run?: number; new_subagent_files_this_run?: number } };
}

/**
 * `ctk doctor` — R17(§3 AC-4 표) 서브에이전트 귀속 괴리 노출. 최근 `measure` run-log 중
 * `failure_class: "subagent_attribution_unresolved"`로 표시된(measure.ts가 남긴다) 가장 최근
 * 건을 찾는다. 괴리가 없으면 `null` — "0을 사실로 기록"하지 않도록 대상이 없을 때와 괴리가 없을
 * 때를 호출자가 구분할 수 있게 `runs` 자체가 없으면 별도로 빈 배열을 반환한다(예외를 던지지 않음
 * — doctor는 진단 도구이므로 측정 이력이 없어도 그냥 "정보 없음"을 보여줘야 한다).
 */
export function runDoctorSubagentAttribution(): SubagentAttributionGapReport | null {
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) return null;
  const machine = readOrCreateMachineIdentity(home, "local-machine");
  const runsDir = path.join(localConfig.catalog_path, machineDir(machine.machine_id), "runs");

  let files: string[];
  try {
    files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return null;
  }

  for (const file of files) {
    const lines = readFileSync(path.join(runsDir, file), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as MeasureRunLogEntry);
    for (const entry of lines.reverse()) {
      if (entry.command !== "measure") continue;
      if (entry.failure_class !== "subagent_attribution_unresolved") return null; // 가장 최근 measure가 이미 괴리 없음
      return {
        runLogFile: file,
        agentToolUseCount: entry.args?.counts?.agent_tool_use_count_this_run ?? 0,
        newSubagentFiles: entry.args?.counts?.new_subagent_files_this_run ?? 0,
      };
    }
  }
  return null;
}

/**
 * `ctk doctor`의 **최상단 경보**. 중단된 복원이 남아 있으면 다른 어떤 요약보다 먼저 보여야 한다(§7.2) —
 * 대상 자리가 비어 있어 사용자 눈에는 파일이 소실된 것으로 보이지만 실제로는 evicted에 온전히 남아
 * 있는 상태이고, 그 사실을 알려주지 않으면 복구 가능한 상황을 손실로 오인하게 된다.
 */
export function runDoctorInterruptedRestores(): InterruptedRestore[] {
  const home = resolveHomeContext();
  return findInterruptedRestores(path.join(home.ctkHome, ".ctk-backups"));
}

/** 최상단 경보를 사람이 읽는 형태로 만든다. 잔존물이 없으면 `null`. */
export function formatInterruptedRestoreAlert(found: readonly InterruptedRestore[]): string | null {
  if (found.length === 0) return null;
  const lines = [
    `⚠️  중단된 복원 ${found.length}건 — 복구 가능한 사본이 남아 있다.`,
    "",
    "   복원 중 프로세스가 멈춰 대상 자리가 비어 있을 수 있다. 파일은 삭제되지 않았고",
    "   아래 위치에 온전히 보관돼 있다. 수동 복구: evicted 경로를 대상 경로로 옮긴다.",
    "",
  ];
  for (const item of found) {
    lines.push(`   [${item.key}] ${item.targetMissing ? "대상 자리 비어 있음" : "대상 존재"}`);
    lines.push(`     보관: ${item.evictedAbs}`);
    lines.push(`     대상: ${item.targetAbs ?? "(manifest를 읽을 수 없어 미상)"}`);
  }
  return lines.join("\n");
}

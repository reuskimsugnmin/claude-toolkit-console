import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { diffById, machineDir, parseInstallation, type Installation } from "@ctk/core";
import { resolveHomeContext } from "@ctk/probe";
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

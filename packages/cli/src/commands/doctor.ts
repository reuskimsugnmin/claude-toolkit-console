import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { diffById, gradeManagedPolicy, machineDir, parseInstallation, type Installation } from "@ctk/core";
import { managedPolicyCandidatePaths, readManagedPolicies, resolveHomeContext } from "@ctk/probe";
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

/**
 * `ctk doctor --managed-policy` — R15 릴리스 게이트. **탐지기는 이미 있었고 `gen`은 쓰고
 * 있었는데 조회 경로에는 배선돼 있지 않았다**(계획서 §4.1이 이 명령을 지정했는데 `doctor`의
 * 표면은 `--drift`뿐이었다). 방어를 만든 것과 모든 경로에 배선한 것은 다르다(안전 원칙 5).
 *
 * `--safe-mode`는 사용자 커스터마이즈를 전면 차단하지만 **admin/managed 정책은 여전히
 * 적용된다.** 기업 관리 훅이 걸린 환경에서는 `sealed-live` 봉인이 원리상 불완전하다 — 우리가
 * 끌 수 없는 훅이 유료 서브프로세스와 함께 돈다. 사용자가 그 사실을 **물어볼 수 있어야** 한다.
 *
 * ⚠️ **정책 내용은 절대 반환하지 않는다**(§7.1). 나가는 것은 경로와 위험 **키 이름**뿐이다 —
 * managed 정책에는 `apiKeyHelper`처럼 크레덴셜을 다루는 값이 들어 있을 수 있다.
 */
export interface DoctorManagedPolicyReport {
  /** 이 OS에서 검사한 경로 전부. 부재도 사실이므로 함께 싣는다. */
  candidates: { path: string; present: boolean }[];
  /** 존재하는데 파싱하지 못한 경로. **"없음"이 아니라 "판정 불가"다.** */
  parseFailures: string[];
  /** 위험 키 이름만. 값은 담지 않는다. */
  riskKeysPresent: string[];
  /**
   * 봉인이 완전하다고 말할 수 있는가. 위험 키가 있거나 **판정할 수 없으면** `false`다 —
   * 판정 불가를 "위험 없음"으로 접으면 깨진 정책 파일이 게이트를 여는 열쇠가 된다(안전 원칙 7).
   */
  sealComplete: boolean;
}

export function runDoctorManagedPolicy(): DoctorManagedPolicyReport {
  const candidates = managedPolicyCandidatePaths();
  const { policies, parseFailures } = readManagedPolicies(candidates);
  const grade = gradeManagedPolicy(policies);
  return {
    candidates: candidates.map((c) => ({ path: c.path, present: existsSync(c.path) })),
    parseFailures,
    riskKeysPresent: [...grade.keysPresent],
    sealComplete: !grade.hasRisk && parseFailures.length === 0,
  };
}

/**
 * 릴리스 게이트의 종료 코드. **사람 눈에만 기대면 CI에서 아무것도 막지 못한다** —
 * "실패가 아무것도 막지 않으면 신호가 아니다". `bin/ctk.ts`가 이 값을 그대로 쓴다.
 */
export function managedPolicyExitCode(report: DoctorManagedPolicyReport): 0 | 1 {
  return report.sealComplete ? 0 : 1;
}

/** 사람이 읽을 형태로. 판정 불가를 "이상 없음"으로 쓰지 않는다. */
export function formatManagedPolicyReport(report: DoctorManagedPolicyReport): string {
  const lines = ["managed 정책 탐지 (R15) — **이 머신 기준**, 정책 내용은 출력하지 않는다"];
  for (const c of report.candidates) lines.push(`  ${c.present ? "발견" : "없음"}  ${c.path}`);
  if (report.candidates.length === 0) lines.push("  이 플랫폼에는 알려진 managed 정책 경로가 없다");
  if (report.parseFailures.length > 0) {
    lines.push(`  ⚠️ 읽지 못한 정책 파일 ${report.parseFailures.length}건 — **위험 판정 불가**:`);
    for (const p of report.parseFailures) lines.push(`      ${p}`);
  }
  lines.push(
    report.riskKeysPresent.length > 0
      ? `  ⚠️ 위험 키: ${report.riskKeysPresent.join(", ")}`
      : "  위험 키: 없음",
  );
  lines.push(
    report.sealComplete
      ? "  → 봉인 완전: managed 정책이 sealed-live 세션에 개입하지 않는다"
      : "  → ⚠️ 봉인 불완전: --safe-mode로도 끌 수 없는 정책이 있거나 판정할 수 없다. " +
          "유료 세션(gen)은 비대화형에서 --allow-managed-policy 없이는 거부된다.",
  );
  return lines.join("\n");
}

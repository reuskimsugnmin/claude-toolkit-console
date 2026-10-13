import path from "node:path";
import { applyMcpToggle, buildMcpToggleJournalEntry, pruneBackupRuns, type ApplyMcpToggleOutcome } from "@ctk/actuator";
import { collectBundled, collectMcp, listPluginInstallPaths, resolveHomeContext, type HomeContext } from "@ctk/probe";
import {
  bundledAssetId,
  extractFailureClass,
  hashPath,
  isDisplayableAssetId,
  parseAsset,
  resolveMcpToggleTarget,
  type Asset,
  type FailureClass,
  type InstalledPluginRef,
  type McpToggleJournalState,
  type McpToggleOp,
} from "@ctk/core";
import { acquireLock, commitAll, readCatalogIndexOrNull, writeJournalEntry, type CatalogIndexEntry } from "@ctk/sync";
import { readLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { McpToggleRefusedError, selectProject, type ProjectSelector } from "../project-select.js";
import { writeRunLogSafely } from "../run-log-safe.js";
import { CatalogNotInitializedError } from "./scan.js";

/**
 * cli/src/commands/mcp-toggle.ts — `ctk mcp <disable|enable>` 오케스트레이션(R7). **사용자의 실제 `~/.claude.json`을 쓰는
 * 첫 ctk 경로**라서 판정은 전부 core(`resolveMcpToggleTarget`)·actuator(`applyMcpToggle`)에 있고, 여기는 선택 → 적격성 →
 * 쓰기 → 기록의 순서와 모든 종단 상태의 journal/run-log 규칙만 둔다.
 *
 * 규칙: 쓴 뒤에는 되돌리기도 두 번째 쓰기도 하지 않는다(E1) — 복구는 **출력된 역방향 `ctk mcp` 명령**이다. `ctk rollback`은 이 레코드를
 * 거부한다(rollback.ts). journal/run-log에는 프로젝트 `hashPath`만 싣는다. 백업 경로는 홈 상대 표기만 출력한다(절대경로엔 홈이 섞인다).
 */

export { CatalogNotInitializedError };

export interface McpToggleOptions extends ProjectSelector {
  op: McpToggleOp;
  assetId: string;
  /** 테스트 주입용 — 기본은 `process.cwd()`. */
  cwd?: string;
}

export interface McpToggleSummary {
  outcome: "applied" | "noop";
  op: McpToggleOp;
  assetId: string;
  /** 화면 표시용 앞 8자. */
  projectHash8: string;
  /** 홈 상대(`~/...`) 백업 참조. noop이면 null. */
  backupRef: string | null;
  pendingApproval: boolean;
  concurrentWriteObserved: boolean;
  /** 되돌리는 명령. 자산 id가 안전하게 찍을 수 없는 모양이면 null. */
  inverseCommand: string | null;
  warnings: string[];
}

/** 쓰기 이후(또는 쓰기 시도 이후) 단계가 판정을 못 내리거나 실패한 종단 상태. `failureClass`는 run-log가 그대로 읽는다. */
export class McpToggleFailedError extends Error {
  readonly failureClass: FailureClass;
  readonly guard: string | null;
  constructor(failureClass: FailureClass, message: string, guard: string | null = null) {
    super(message);
    this.name = "McpToggleFailedError";
    this.failureClass = failureClass;
    this.guard = guard;
  }
}

const RESTART_NOTICE = "해당 프로젝트에서 실행 중인 Claude Code 세션은 재시작해야 반영된다.";

const homeRelative = (home: HomeContext, abs: string): string => `~/${path.relative(home.ctkHome, abs)}`;

/** 역방향 명령. 같은 프로젝트를 해시로 지목해 cwd와 무관하게 동작한다. 안전하게 찍을 수 없는 id면 null(셸에 넣을 문자열을 만들지 않는다). */
export function inverseMcpToggleCommand(op: McpToggleOp, assetId: string, projectHash16: string): string | null {
  if (!isDisplayableAssetId(assetId)) return null;
  return `ctk mcp ${op === "disable" ? "enable" : "disable"} --asset ${assetId} --project-hash ${projectHash16}`;
}

const inverseHint = (cmd: string | null): string =>
  cmd !== null ? `되돌리려면: ${cmd}` : "되돌리려면 같은 자산에 반대 동사를 직접 실행한다(자산 id에 셸에 안전하지 않은 문자가 있어 명령을 출력하지 않는다).";

/**
 * 인덱스 행 → `Asset`. 인덱스는 동기화되는 — 신뢰할 수 없는 — 데이터인데 판정은 `asset.name`을 하네스 이름으로 쓴다.
 * 그래서 probe가 지키는 불변식(독립 서버 `id === name`, 번들 서버 `id === bundledAssetId(부모, "mcp", name)`)을 **정확 일치**로 확인한다 —
 * 어긋난 행은 id와 다른 서버를 쓰고도 id를 보고하게 된다.
 */
function assetFromIndexRow(entry: CatalogIndexEntry): Asset {
  if (entry.kind !== "mcp") return { schema_version: 1, _scope: "machine_independent", id: entry.id, kind: entry.kind, name: entry.name };
  const expectedId = entry.parent_asset_id === undefined ? entry.name : bundledAssetId(entry.parent_asset_id, "mcp", entry.name);
  if (entry.id !== expectedId) {
    throw new McpToggleRefusedError("index_name_mismatch", "카탈로그 인덱스 행의 id와 name이 서로 맞지 않는다 — 다른 서버를 가리킬 수 있어 쓰지 않았다. `ctk scan` 후 다시 시도한다.");
  }
  try {
    return parseAsset({
      schema_version: 1,
      _scope: "machine_independent",
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      ...(entry.parent_asset_id !== undefined ? { parent_asset_id: entry.parent_asset_id } : {}),
    });
  } catch {
    throw new McpToggleRefusedError("index_asset_invalid", "카탈로그 인덱스 행이 자산 스키마를 통과하지 못했다 — `ctk scan` 후 다시 시도한다.");
  }
}

export async function runMcpToggle(options: McpToggleOptions): Promise<McpToggleSummary> {
  const startedAt = new Date();
  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;
  const machine = readOrCreateMachineIdentity(home, "local-machine");
  const { op, assetId } = options;

  const lock = acquireLock(catalogPath, {
    command: "mcp",
    origin: "cli",
    started_at: startedAt.toISOString(),
    machine_id: machine.machine_id,
  });

  // 모든 종단 상태가 같은 필드로 run-log 한 건을 남긴다 — 화면 메시지는 사라지고 이것만 남는다.
  const rec = {
    projectPathHash: null as string | null,
    outcome: "refused" as string,
    guard: null as string | null,
    concurrentWriteObserved: false,
    journalWritten: false,
  };
  let failure: unknown = null;

  try {
    const key = selectProject(home, { projectHash: options.projectHash, project: options.project }, options.cwd);
    const projectHash = hashPath(key);
    rec.projectPathHash = projectHash;

    // 자산은 카탈로그 인덱스에서 온다 — 없으면 `undefined`로 넘겨 적격성 판정이 사유를 낸다. 손상은 "없음"이 아니라 거부다.
    const indexRead = readCatalogIndexOrNull(catalogPath);
    if (indexRead.corrupted) throw new McpToggleRefusedError("index_corrupted", "카탈로그 인덱스를 읽을 수 없다 — `ctk scan` 후 다시 시도한다.");
    const entry = indexRead.index?.assets.find((a) => a.id === assetId);
    const asset: Asset | undefined = entry === undefined ? undefined : assetFromIndexRow(entry);

    // 독립 서버의 정의 행. **이 머신의 행만** 넘긴다 — 판정 입력의 `Pick`에는 machine_id가 없어, 다른 머신의 행이 섞이면 조용히 통과한다.
    // 자산이 카탈로그에 없을 때도 읽는다 — 깨진 `.mcp.json`이 서버를 지워 자산이 없어졌을 수 있다(아래 mcp_json_unreadable).
    const collected =
      asset === undefined || (asset.kind === "mcp" && asset.parent_asset_id === undefined)
        ? collectMcp({ home, machineId: machine.machine_id, installedPluginNames: new Set() })
        : null;
    const installations = asset === undefined ? [] : (collected?.installations.filter((i) => i.machine_id === machine.machine_id) ?? []);

    // 플러그인 서버: 부모의 설치 스코프(D7)와 번들 서버 목록. claude 서브프로세스는 띄우지 않는다.
    let installedPlugins: InstalledPluginRef[] = [];
    let bundledMcpAssetIds: ReadonlySet<string> | null = new Set();
    if (asset?.kind === "mcp" && asset.parent_asset_id !== undefined) {
      const parent = asset.parent_asset_id;
      const index = listPluginInstallPaths(home);
      installedPlugins = index.ids().flatMap((id) =>
        index.scopes(id).map((s) => ({ id, scope: s.scope, projectPathHash: s.projectPath === null ? null : hashPath(s.projectPath) })),
      );
      // synced manifest를 못 읽으면 synced id는 열거되지 않고 `get`이 그 id에만 `missing`을 낸다 — "미설치"가 아니라 미측정이다.
      const parentEntry = index.get(parent);
      if (!installedPlugins.some((p) => p.id === parent) && parentEntry !== undefined && "missing" in parentEntry) {
        installedPlugins.push({ id: parent, scope: "synced", projectPathHash: null });
      }
      const bundled = collectBundled({ home, pluginIds: [parent] });
      const report = bundled.perParent[0];
      bundledMcpAssetIds =
        report !== undefined && report.state === "ok" && report.mcpServers !== null
          ? new Set(bundled.assets.filter((a) => a.kind === "mcp").map((a) => a.id))
          : null;
    }

    const target = resolveMcpToggleTarget({ assetId, asset, projectPathHash: projectHash, installations, installedPlugins, bundledMcpAssetIds });
    if (!target.ok) {
      // 이 프로젝트의 .mcp.json을 못 읽었다면 "정의돼 있지 않다"는 거짓 사유다 — 못 읽은 사실을 먼저 말한다.
      const undefinedHere = target.reason === "not_defined_for_project" || (target.reason === "not_mcp" && asset === undefined);
      if (undefinedHere && collected?.unreadableMcpJsonProjectHashes.includes(projectHash) === true) {
        throw new McpToggleRefusedError(
          "mcp_json_unreadable",
          "이 프로젝트의 .mcp.json을 읽거나 파싱하지 못했다 — 그 파일에 정의된 서버는 판정할 수 없어 쓰지 않았다. 파일을 고친 뒤 `ctk scan`을 다시 실행한다.",
        );
      }
      throw new McpToggleRefusedError(target.reason, target.hint);
    }

    const result: ApplyMcpToggleOutcome = applyMcpToggle({ home, projectKey: key, name: target.harnessName, op });
    rec.outcome = result.outcome;
    const inverse = inverseMcpToggleCommand(op, assetId, projectHash);
    const priorDisabled = op === "enable";
    const state = (disabled: boolean): McpToggleJournalState => ({ harness_name: target.harnessName, project_path_hash: projectHash, disabled });

    /** 기록할 백업이 있는 종단 상태의 journal. 실패해도 원래 결과를 가리지 않는다(`journal_written`으로만 남는다). */
    const journalFailure = (backupRoot: string, manifestSha256: string, afterDisabled: boolean): void => {
      try {
        writeJournalEntry(
          catalogPath,
          buildMcpToggleJournalEntry({
            assetId,
            machineId: machine.machine_id,
            homeDir: home.ctkHome,
            before: state(priorDisabled),
            after: state(afterDisabled),
            backupRootAbs: backupRoot,
            manifestSha256,
            result: "failure",
          }),
        );
        rec.journalWritten = true;
        commitAll(catalogPath, `ctk mcp ${op} (failure): ${assetId}`);
      } catch {
        /* 원래 결과를 가리지 않는다 */
      }
    };

    switch (result.outcome) {
      case "noop":
        return {
          outcome: "noop",
          op,
          assetId,
          projectHash8: projectHash.slice(0, 8),
          backupRef: null,
          pendingApproval: target.pendingApproval,
          concurrentWriteObserved: false,
          inverseCommand: inverse,
          warnings: [],
        };
      case "refused":
        rec.guard = result.guard;
        throw new McpToggleFailedError(
          result.failureClass,
          `${result.guard} 검사가 쓰기를 막았다${result.detail !== undefined ? `(${result.detail})` : ""} — 아무것도 바꾸지 않았다.`,
          result.guard,
        );
      case "aborted_unchanged": {
        rec.guard = result.guard;
        if (result.backupRoot !== null && result.manifestSha256 !== null) journalFailure(result.backupRoot, result.manifestSha256, priorDisabled);
        throw new McpToggleFailedError(
          result.failureClass,
          `${result.guard} 검사에서 중단했다 — .claude.json은 바뀌지 않았다. 다른 Claude Code 세션이 쓰는 중일 수 있다. 잠시 뒤 다시 실행한다.`,
          result.guard,
        );
      }
      case "post_write_unmeasured": {
        journalFailure(result.backupRoot, result.manifestSha256, op === "disable");
        throw new McpToggleFailedError(
          result.failureClass,
          `쓴 뒤 .claude.json을 읽거나 해석하지 못해 결과를 확인할 수 없다 — 성공으로 보지 않는다. 직접 확인한다(백업: ${homeRelative(home, result.backupRoot)}). ${RESTART_NOTICE}`,
        );
      }
      case "clobbered_after_write": {
        journalFailure(result.backupRoot, result.manifestSha256, priorDisabled);
        throw new McpToggleFailedError(
          result.failureClass,
          `쓴 뒤 다른 세션이 .claude.json을 바꿔 우리 변경이 사라졌다. 두 번째 쓰기는 하지 않았다. 필요하면 같은 명령을 다시 실행한다(백업: ${homeRelative(home, result.backupRoot)}).`,
        );
      }
      case "applied": {
        const backupRef = homeRelative(home, result.backupRoot);
        rec.concurrentWriteObserved = result.concurrentWriteObserved;
        const warnings: string[] = [];
        try {
          writeJournalEntry(
            catalogPath,
            buildMcpToggleJournalEntry({
              assetId,
              machineId: machine.machine_id,
              homeDir: home.ctkHome,
              before: state(priorDisabled),
              after: state(op === "disable"),
              backupRootAbs: result.backupRoot,
              manifestSha256: result.manifestSha256,
              result: "success",
            }),
          );
          rec.journalWritten = true; // 파일은 디스크에 있다 — 커밋이 실패해도 run-log는 사실대로 남긴다
        } catch {
          // 파일은 이미 바뀌었다 — rollback은 journal 없이는 힌트를 못 주므로 되돌리는 명령을 여기서 직접 낸다.
          throw new McpToggleFailedError(
            "journal_write_failed",
            `.claude.json은 이미 바뀌었지만 journal 기록에 실패했다(백업: ${backupRef}). ${inverseHint(inverse)} ${RESTART_NOTICE}`,
          );
        }
        try {
          commitAll(catalogPath, `ctk mcp ${op}: ${assetId}`);
        } catch {
          throw new McpToggleFailedError(
            "journal_commit_failed",
            `.claude.json은 이미 바뀌었고 journal 파일도 썼지만 카탈로그 커밋에 실패했다(백업: ${backupRef}). ${inverseHint(inverse)} ${RESTART_NOTICE}`,
          );
        }
        // 토글 한 건도 백업 쿼터 10개 중 하나를 쓴다 — 오래된 이동의 백업이 밀려날 수 있다(문서화). 정리 실패는 적용 결과를 바꾸지 않는다.
        try {
          pruneBackupRuns(path.join(home.ctkHome, ".ctk-backups"));
        } catch {
          warnings.push("오래된 백업 정리에 실패했다 — 토글 결과에는 영향이 없다.");
        }
        return {
          outcome: "applied",
          op,
          assetId,
          projectHash8: projectHash.slice(0, 8),
          backupRef,
          pendingApproval: target.pendingApproval,
          concurrentWriteObserved: result.concurrentWriteObserved,
          inverseCommand: inverse,
          warnings,
        };
      }
    }
    const unreachable: never = result;
    return unreachable;
  } catch (err) {
    failure = err;
    const guard = (err as { guard?: unknown } | null)?.guard;
    if (rec.guard === null && typeof guard === "string") rec.guard = guard;
    throw err;
  } finally {
    writeRunLogSafely(catalogPath, {
      schema_version: 1,
      _scope: "machine_dependent",
      command: "mcp",
      args: {
        op,
        // 사용자가 친 값이 경로일 수 있다 — 안전하게 찍을 수 있는 모양만 싣는다.
        asset_id: isDisplayableAssetId(assetId) ? assetId : null,
        project_path_hash: rec.projectPathHash,
        outcome: rec.outcome,
        guard: rec.guard,
        concurrent_write_observed: rec.concurrentWriteObserved,
        journal_written: rec.journalWritten,
      },
      machine_id: machine.machine_id,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      exit_code: failure === null ? 0 : 1,
      failure_class: failure === null ? null : extractFailureClass(failure),
    });
    lock.release();
  }
}

/** 성공·무변경 종료의 화면 출력 줄. 경고는 stdout 뒤에 따로 줄을 낸다. */
export function formatMcpToggleSummary(s: McpToggleSummary): string[] {
  const verb = s.op === "disable" ? "비활성" : "활성";
  const lines =
    s.outcome === "noop"
      ? [`ctk mcp ${s.op} — 이미 ${verb} 상태다. 아무것도 바꾸지 않았다. (${s.assetId}, 프로젝트 #${s.projectHash8})`]
      : [`ctk mcp ${s.op} 완료 — ${s.assetId}를 프로젝트 #${s.projectHash8}에서 ${verb}했다.`, `  백업: ${s.backupRef}`];
  lines.push(`  ${RESTART_NOTICE}`);
  if (s.pendingApproval) {
    // 헤드리스 실측(CLI 2.1.296): 승인 전 서버는 표시가 Pending이어도 뜨고, 끈 서버는 안 뜬다. 거부(disabledMcpjsonServers)된 서버는 켜도 안 뜬다.
    lines.push(
      s.op === "disable"
        ? "  ⚠️ 이 서버는 프로젝트 .mcp.json 정의다 — 승인 전이면 표시는 'Pending'으로 남지만, 끈 서버는 세션이 띄우지 않는다(헤드리스 실행 실측)."
        : "  ⚠️ 이 서버는 프로젝트 .mcp.json 정의다 — `claude mcp get`이 'Rejected'로 보이면 켜도 뜨지 않는다. ctk는 승인 설정을 읽거나 바꾸지 않는다.",
    );
  }
  if (s.concurrentWriteObserved) {
    lines.push("  ⚠️ 쓰는 동안 다른 세션이 .claude.json의 다른 부분도 바꿨다(우리 변경은 보존됐다).");
  }
  if (s.outcome === "applied") lines.push(`  ${inverseHint(s.inverseCommand)}`);
  for (const w of s.warnings) lines.push(`  ⚠️ ${w}`);
  return lines;
}

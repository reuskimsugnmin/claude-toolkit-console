import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { claudeJsonPath, type HomeContext } from "@ctk/probe";
import {
  isExactMcpToggleVerdict,
  ownedSubtreeEquals,
  planMcpToggle,
  serializeClaudeJson,
  snapshotIdFsSafe,
  type McpToggleOp,
} from "@ctk/core";
import { judgeClaudeJson } from "../audit.js";
import { atomicWriteFile } from "../guard/atomic-write.js";
import { backupFile, beginBackupRun, CLAUDE_JSON_BACKUP_KEY, removeBackupRun, writeManifest } from "../backup.js";

/**
 * actuator/src/apply/mcp-toggle.ts — `ctk mcp <disable|enable>`의 쓰기. **사용자의 실제 `~/.claude.json`을 쓰는 첫 코드**다.
 * 쓰는 것은 `projects[<기존 키>].disabledMcpServers`의 이름 하나뿐이고, 판정(무엇을 써도 되는가)은 전부 core의
 * `planMcpToggle`·`judgeClaudeJson(mcpToggle)`·`isExactMcpToggleVerdict`·`ownedSubtreeEquals`에 있다 — 여기는 순서와 문만 둔다.
 *
 * 순서(씨앗 = 이음매 위치): ①② open(O_NOFOLLOW)+fstat+읽기(S0) → ③ plan → [afterPlan] → ④ 판정 → [beforeBackup] → ⑤ 백업
 * → [beforeCas] → ⑥ 같은 방식으로 재읽기 CAS → [beforeRename] → ⑦ atomicWriteFile(reparse 안에서 [afterRename]) → [afterWrite] → ⑧ 분류.
 *
 * ⚠️ 쓴 **뒤에는** 되돌리기도 두 번째 쓰기도 하지 않는다(E1) — 롤백이 다른 세션의 변경을 덮어쓸 수 있고, 복구는 사용자가
 * 출력된 역방향 `ctk mcp` 동사로 한다. CAS~rename 사이(risk 7)는 프로세스 간 락 없이는 닫을 수 없다(CLI도 같은 창을 갖는다).
 * 모든 거부·중단 outcome은 어느 검사가 발동했는지 `guard`로 밝힌다 — 같은 실패 클래스 안에서도 처방이 달라서다.
 */

/** 같은 클래스(`config_clobbered`)를 던지는 outcome용. 복원 직전 문구인 `ConfigClobberedError`는 이 경로와 뜻이 달라 재사용하지 않는다. */
export class McpToggleClobberedError extends Error {
  readonly failureClass = "config_clobbered" as const;
  readonly guard: string;
  constructor(guard: string, afterWrite: boolean) {
    super(
      afterWrite
        ? `쓰기 뒤 .claude.json의 우리 변경(disabledMcpServers)이 다른 세션에 의해 사라졌다(guard=${guard}). 두 번째 쓰기는 하지 않았다 — 필요하면 같은 명령을 다시 실행한다.`
        : `쓰기 전 .claude.json이 읽은 뒤 다른 세션에 의해 바뀌었다(guard=${guard}). 아무것도 쓰지 않았다 — 다시 실행한다.`,
    );
    this.name = "McpToggleClobberedError";
    this.guard = guard;
  }
}

export interface ApplyMcpToggleRequest {
  home: HomeContext;
  /** `projects`의 **기존** 키(호출자가 realpath·nearest-.git 규칙으로 확인한 값). */
  projectKey: string;
  /** 하네스가 읽는 서버 이름(`resolveMcpToggleTarget`의 `harnessName`). */
  name: string;
  op: McpToggleOp;
}

export type McpToggleRefuseGuard = "lstat_absent" | "lstat_type" | "hardlink" | "lstat_error" | "owner" | "read_failed" | "round_trip" | "plan" | "verdict";
export type McpToggleAbortGuard = "backup_threw" | "backup_sha" | "cas_lstat" | "cas_sha" | "write_not_applied";

export type ApplyMcpToggleOutcome =
  | { outcome: "noop" }
  | {
      outcome: "refused";
      failureClass: "claude_json_format_unrecognized" | "mcp_toggle_refused" | "forbidden_path_write";
      guard: McpToggleRefuseGuard;
      /** 비밀이 아닌 진단(`plan` 거부 사유·`round_trip` 첫 차이 오프셋). 경로·값은 싣지 않는다. */
      detail?: string;
    }
  | {
      outcome: "aborted_unchanged";
      failureClass: "backup_failed" | "config_clobbered" | "claude_json_write_failed";
      guard: McpToggleAbortGuard;
      /** 백업 런이 만들어졌고 남아 있으면 그 경로. `backup_threw`는 런 디렉터리를 지우므로 null. */
      backupRoot: string | null;
      manifestSha256: string | null;
      /** `backup_threw`에서만 의미 — 런 디렉터리를 실제로 지웠는가(지우지 못하면 false로 남긴다). */
      backupRunRemoved?: boolean;
    }
  | {
      outcome: "applied";
      before: string[];
      after: string[];
      backupRoot: string;
      manifestSha256: string;
      /** 우리가 쓴 뒤 다른 세션이 파일의 **다른 부분**을 또 바꿨다(우리 변경은 보존). */
      concurrentWriteObserved: boolean;
    }
  | { outcome: "post_write_unmeasured"; failureClass: "claude_json_post_write_unmeasured"; backupRoot: string; manifestSha256: string }
  | { outcome: "clobbered_after_write"; failureClass: "config_clobbered"; backupRoot: string; manifestSha256: string };

/** 테스트 전용 — 경쟁 재현 이음매. 제품 코드는 `applyMcpToggle`만 쓴다. */
export interface McpToggleTestSeam {
  /** plan 직후. 문자열을 돌려주면 그것이 쓸 바이트가 된다(플래너 결함 재현) — 이후 검사는 그 값을 본다. */
  afterPlan?: (nextRaw: string) => string | void;
  beforeBackup?: () => void;
  beforeCas?: () => void;
  beforeRename?: () => void;
  /** `atomicWriteFile`의 reparse 안 — rename 직후. 던지면 쓰기가 던진 것으로 취급된다. */
  afterRename?: () => void;
  afterWrite?: () => void;
}

const shaOf = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** 현재 프로세스 사용자의 파일인가 — sudo로 돌면 root 소유가 돼 사용자 파일을 못 쓰게 되는 사고를 막는다. 판별 불가(Windows)면 통과. */
export function isOwnedByCurrentUser(st: { uid: number }, currentUid: number | null = typeof process.getuid === "function" ? process.getuid() : null): boolean {
  return currentUid === null || st.uid === currentUid;
}

type OpenedRegular =
  | { ok: true; bytes: Buffer; uid: number }
  | { ok: false; guard: "lstat_absent" | "lstat_type" | "hardlink" | "lstat_error" | "read_failed" };

/**
 * 링크를 따르지 않고(O_NOFOLLOW) **연 fd 하나**로 종류 확인·읽기를 한다 — lstat 뒤 경로로 다시 읽으면 그 사이 바꿔치기된
 * 링크를 따라간다. O_NONBLOCK은 FIFO를 열다 영구 블록되는 것을 막는다(정규 파일엔 영향 없음).
 */
function readRegularNoFollow(abs: string): OpenedRegular {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, guard: code === "ENOENT" ? "lstat_absent" : code === "ELOOP" ? "lstat_type" : "lstat_error" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, guard: "lstat_type" };
    // 하드링크면 rename 쓰기가 링크를 끊어 다른 사본(dotfiles)이 조용히 낡는다 — move의 config_hardlink와 같은 이유.
    if (st.nlink > 1) return { ok: false, guard: "hardlink" };
    return { ok: true, bytes: readFileSync(fd), uid: st.uid };
  } catch {
    return { ok: false, guard: "read_failed" };
  } finally {
    closeSync(fd);
  }
}

function readBytesOrNull(abs: string): Buffer | null {
  try {
    return readFileSync(abs);
  } catch {
    return null;
  }
}

/** 백업 런 디렉터리를 지운다 — 백업 루트의 **직계 자식**일 때만(경로 검증 없이 `rm -rf`하지 않는다). */
function removeOwnBackupRun(ctkHome: string, backupRoot: string): boolean {
  const rel = path.relative(path.join(ctkHome, ".ctk-backups"), backupRoot);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return false;
  try {
    removeBackupRun(backupRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * 쓰기 뒤 분류 — 쓰기가 던졌든 안 던졌든 **이 함수 하나**를 지난다(두 경로의 분류가 갈라지지 않게).
 * `currentBytes`: 쓰기 뒤 파일 바이트(읽을 수 없으면 null). 던진 경우에만 "S0 그대로 = 쓰기가 적용되지 않았다"가 성립한다.
 */
function classifyPostWrite(
  threw: boolean,
  currentBytes: Buffer | null,
  s0Sha: string,
  nextRaw: string,
  projectKey: string,
  after: readonly string[],
): "write_not_applied" | "applied" | "applied_concurrent" | "unmeasured" | "clobbered" {
  if (currentBytes === null) return "unmeasured";
  const sha = shaOf(currentBytes);
  if (threw && sha === s0Sha) return "write_not_applied";
  if (sha === shaOf(nextRaw)) return "applied";
  // 던졌는데 S0도 우리 바이트도 아니면 rename이 됐는지 알 수 없다 — 우리 변경이 남았는지 보지 않고 미측정으로 둔다.
  if (threw) return "unmeasured";
  let parsed: unknown;
  try {
    parsed = JSON.parse(currentBytes.toString("utf8"));
  } catch {
    return "unmeasured";
  }
  return ownedSubtreeEquals(parsed, projectKey, after) ? "applied_concurrent" : "clobbered";
}

export function applyMcpToggle(req: ApplyMcpToggleRequest): ApplyMcpToggleOutcome {
  return applyMcpToggleWithSeam(req, {});
}

export function applyMcpToggleWithSeam(req: ApplyMcpToggleRequest, seam: McpToggleTestSeam): ApplyMcpToggleOutcome {
  const { home, projectKey, name, op } = req;
  const abs = claudeJsonPath(home);

  // ①② 링크 비추종 open + fstat — 부재·링크·비정규 파일을 읽기 전에 거르고, 같은 fd에서 S0 바이트를 얻는다.
  const first = readRegularNoFollow(abs);
  if (!first.ok) return { outcome: "refused", failureClass: "mcp_toggle_refused", guard: first.guard };
  if (!isOwnedByCurrentUser(first)) return { outcome: "refused", failureClass: "mcp_toggle_refused", guard: "owner" };
  const s0Bytes = first.bytes;
  const s0Sha = shaOf(s0Bytes);
  const s0Raw = s0Bytes.toString("utf8");

  // ③ 바이트 수준 왕복 — 잘못된 UTF-8은 U+FFFD로 디코드돼 문자열 왕복을 통과한 채 조용히 바뀐다(게이트 A L5).
  if (!Buffer.from(s0Raw, "utf8").equals(s0Bytes)) {
    return { outcome: "refused", failureClass: "claude_json_format_unrecognized", guard: "round_trip", detail: "utf8" };
  }
  const plan = planMcpToggle(s0Raw, projectKey, name, op);
  if (plan.kind === "noop") return { outcome: "noop" };
  if (plan.kind === "format_unrecognized") {
    return { outcome: "refused", failureClass: "claude_json_format_unrecognized", guard: "round_trip", detail: `offset=${plan.offset}` };
  }
  if (plan.kind === "refused") return { outcome: "refused", failureClass: "mcp_toggle_refused", guard: "plan", detail: plan.reason };

  const { before, after } = plan;
  const replaced = seam.afterPlan?.(plan.nextRaw);
  const nextRaw = typeof replaced === "string" ? replaced : plan.nextRaw;

  // ④ 판정 — 백업·쓰기 **전에**. 계획이 정확히 그 키의 한 경로만 바꿨음을 판정기에게 다시 확인한다(E3).
  let nextValue: unknown;
  try {
    nextValue = JSON.parse(nextRaw);
  } catch {
    return { outcome: "refused", failureClass: "forbidden_path_write", guard: "verdict", detail: "next_not_json" };
  }
  const verdict = judgeClaudeJson(JSON.parse(s0Raw) as unknown, nextValue, null, [], { projectKey, name, op });
  if (!isExactMcpToggleVerdict(verdict, projectKey)) {
    return { outcome: "refused", failureClass: "forbidden_path_write", guard: "verdict" };
  }
  // 쓸 바이트는 정본 직렬화여야 한다 — 값이 같아도 서식이 다르면(판정기는 값만 본다) 하네스 서식을 바꿔 쓴다.
  if (nextRaw !== serializeClaudeJson(nextValue)) {
    return { outcome: "refused", failureClass: "forbidden_path_write", guard: "verdict", detail: "next_not_canonical" };
  }

  seam.beforeBackup?.();

  // ⑤ 백업 — 던지면 **이 런의** 디렉터리만 지운다(원본은 아직 안 바뀌었다).
  let backupRoot: string | null = null;
  let handle: ReturnType<typeof writeManifest>;
  let entry: ReturnType<typeof backupFile>;
  try {
    const runId = snapshotIdFsSafe();
    backupRoot = beginBackupRun(home.ctkHome, runId).backupRoot;
    entry = backupFile(backupRoot, CLAUDE_JSON_BACKUP_KEY, abs);
    handle = writeManifest(backupRoot, runId, { [CLAUDE_JSON_BACKUP_KEY]: entry });
  } catch {
    const removed = backupRoot === null ? false : removeOwnBackupRun(home.ctkHome, backupRoot);
    return { outcome: "aborted_unchanged", failureClass: "backup_failed", guard: "backup_threw", backupRoot: null, manifestSha256: null, backupRunRemoved: removed };
  }
  const { manifestSha256 } = handle;
  // 백업 사본의 sha는 복사 **시점의 원본**에서 나온다 — S0와 다르면 읽은 뒤 복사 전에 파일이 바뀐 것이다.
  // ABA(복사 뒤 S0 바이트로 되돌아와 cas_sha를 통과) 를 막는 유일한 가드다 — 나머지는 cas_sha가 덮는다.
  if (!entry.existed || entry.sha256 !== s0Sha) {
    return { outcome: "aborted_unchanged", failureClass: "config_clobbered", guard: "backup_sha", backupRoot, manifestSha256 };
  }

  seam.beforeCas?.();

  // ⑥ CAS — 다시 일반 파일이고 바이트가 S0 그대로여야 한다.
  const cas = readRegularNoFollow(abs);
  if (!cas.ok) {
    return { outcome: "aborted_unchanged", failureClass: "config_clobbered", guard: cas.guard === "read_failed" ? "cas_sha" : "cas_lstat", backupRoot, manifestSha256 };
  }
  if (shaOf(cas.bytes) !== s0Sha) {
    return { outcome: "aborted_unchanged", failureClass: "config_clobbered", guard: "cas_sha", backupRoot, manifestSha256 };
  }

  seam.beforeRename?.();

  // ⑦ 쓰기 — `reparse` 옵션만 쓴다(공용 함수에 옵션을 더하지 않는다). 이음매는 rename 직후, 호출 안에서 돈다.
  let threw = false;
  try {
    atomicWriteFile(abs, nextRaw, {
      reparse: (raw) => {
        seam.afterRename?.();
        return JSON.parse(raw) as unknown;
      },
    });
  } catch {
    threw = true;
  }

  seam.afterWrite?.();

  // ⑧ 분류 — 던진 경로와 안 던진 경로가 같은 함수를 지난다.
  const verdictAfter = classifyPostWrite(threw, readBytesOrNull(abs), s0Sha, nextRaw, projectKey, after);
  switch (verdictAfter) {
    case "write_not_applied":
      return { outcome: "aborted_unchanged", failureClass: "claude_json_write_failed", guard: "write_not_applied", backupRoot, manifestSha256 };
    case "applied":
      return { outcome: "applied", before, after, backupRoot, manifestSha256, concurrentWriteObserved: false };
    case "applied_concurrent":
      return { outcome: "applied", before, after, backupRoot, manifestSha256, concurrentWriteObserved: true };
    case "unmeasured":
      return { outcome: "post_write_unmeasured", failureClass: "claude_json_post_write_unmeasured", backupRoot, manifestSha256 };
    case "clobbered":
      return { outcome: "clobbered_after_write", failureClass: "config_clobbered", backupRoot, manifestSha256 };
  }
}

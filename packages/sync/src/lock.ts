import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * sync/src/lock.ts — §7.4 동시 실행 가드. 카탈로그를 쓰는 모든 명령(`scan`·`measure`·`gen`·`move`·
 * `rollback`·`init`)은 실행 시작 시 `<catalog>/.ctk.lock`을 배타적으로 획득한다. 생성은 `O_EXCL`
 * (원자적)이고, 획득 실패는 대기가 아니라 즉시 실패한다(`lock_contended`).
 *
 * ## stale 락 회수 (2026-08-24 추가)
 *
 * 원래 이 모듈은 "stale 락의 자동 강제 해제는 하지 않는다 — `ctk doctor`가 사용자 확인 하에
 * 제거한다"고 적고 그 복구 경로를 **다음 단계로 미뤘다. 그리고 만들어지지 않았다.** 그 사이
 * `gen` 배치가 SIGKILL로 죽자(아래 참조) 락이 남았고, 사용자는 `lock_contended`만 보고 **빠져나갈
 * 길이 전혀 없었다** — 안전 원칙 6이 경계한 상태 그대로다(락 파일 위치조차 알려주지 않았다).
 *
 * 지금은 **증명할 수 있을 때만** 회수한다: `machine_id`가 이 머신이고 그 pid가 살아 있지 않으면
 * 보유자는 확실히 사라진 것이다. 판정 방향이 안전한 쪽으로 치우쳐 있다 — pid가 재사용되면
 * "아직 살아 있다"로 읽혀 **회수하지 않는다**(fail-closed). 반대로 살아 있는 보유자가 죽은 것으로
 * 보이는 경우는 없다.
 *
 * 머신이 다르면 그 pid는 이 머신에서 의미가 없으므로 판정하지 않고, 대신 **에러 메시지가
 * 복구 방법을 알려준다**(`ctk doctor --unlock`). 진단만 있고 길이 없으면 사용자는 가드를 우회하는
 * 법부터 찾는다.
 *
 * ⚠️ `process.once("exit")` 안전망은 **SIGKILL·SIGTERM에는 걸리지 않는다.** 그래서 신호 핸들러도
 * 함께 건다 — 그래도 SIGKILL(-9)은 막을 수 없으므로 회수 경로가 여전히 필요하다.
 */

export interface LockInfo {
  pid: number;
  command: string;
  origin: "cli" | "web";
  started_at: string;
  machine_id: string;
}

export class LockContendedError extends Error {
  readonly failureClass = "lock_contended" as const;
  readonly holder: LockInfo | null;
  constructor(lockPath: string, holder: LockInfo | null) {
    super(
      `다른 ctk 실행이 락을 보유 중이다(${lockPath})` +
        (holder
          ? ` — 보유 명령: ${holder.command}, pid: ${holder.pid}, 시작: ${holder.started_at}`
          : " (락 내용 판독 불가)") +
        // 복구 경로를 **에러 자체에** 싣는다 — 진단만 있고 길이 없으면 사용자는 락 파일을
        // 손으로 지우는 법부터 찾고, 그 순간 이 가드는 사라진다(안전 원칙 6).
        `\n  → 그 프로세스가 실제로 돌고 있는지 확인하라. 죽었는데도 이 메시지가 나오면` +
        ` \`ctk doctor --unlock\`으로 락을 회수할 수 있다(보유자가 살아 있으면 거부한다).`,
    );
    this.name = "LockContendedError";
    this.holder = holder;
  }
}

/**
 * pid가 살아 있는지 본다. **판정 불가는 "살아 있다"로 답한다**(fail-closed) — 회수는 확실할 때만
 * 해야 하고, 틀리는 방향이 "회수하지 않음"이어야 안전하다.
 *
 * `ESRCH`만 죽음의 증거다. `EPERM`은 프로세스가 존재하는데 권한이 없다는 뜻이므로 살아 있다.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false; // 기록이 망가졌으면 보유자를 특정할 수 없다.
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * 이 락이 **확실히** 죽은 보유자의 것인지 판정한다. 다음 둘이 모두 참일 때만 true다:
 * ① 락을 잡은 머신이 이 머신이다(다른 머신의 pid는 여기서 의미가 없다), ② 그 pid가 죽었다.
 */
export function isStaleLock(holder: LockInfo | null, thisMachineId: string): boolean {
  if (holder === null) return false; // 판독 불가 — 지어내지 않는다. 수동 회수로 보낸다.
  if (holder.machine_id !== thisMachineId) return false;
  return !isProcessAlive(holder.pid);
}

export interface AcquiredLock {
  readonly path: string;
  release(): void;
}

function lockFilePath(catalogRoot: string): string {
  return path.join(catalogRoot, ".ctk.lock");
}

function readLockInfo(lockPath: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * `<catalog>/.ctk.lock`을 배타적으로 획득한다. 이미 보유 중이면 즉시 `LockContendedError`를
 * 던진다(대기하지 않는다). 성공하면 `release()`로 해제하는 핸들을 반환한다 — 호출자는 반드시
 * `try/finally`로 `release()`를 호출해야 한다(정상·비정상 종료 모두에서 해제 규약).
 */
export function acquireLock(catalogRoot: string, info: Omit<LockInfo, "pid">): AcquiredLock {
  mkdirSync(catalogRoot, { recursive: true });
  const lockPath = lockFilePath(catalogRoot);
  const content: LockInfo = { ...info, pid: process.pid };

  let fd: number;
  try {
    fd = openSync(lockPath, "wx"); // O_EXCL 상당 — 이미 존재하면 EEXIST로 실패한다.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const holder = readLockInfo(lockPath);
    if (!isStaleLock(holder, info.machine_id)) {
      throw new LockContendedError(lockPath, holder);
    }
    // 죽은 보유자의 락이다. **조용히 지우지 않는다** — 무엇을 회수했는지 알린다.
    console.warn(
      `⚠️  죽은 실행이 남긴 락을 회수한다 — 보유 명령: ${holder?.command}, pid: ${holder?.pid},` +
        ` 시작: ${holder?.started_at} (그 프로세스는 살아 있지 않다)`,
    );
    unlinkSync(lockPath);
    fd = openSync(lockPath, "wx"); // 재시도. 여기서 또 EEXIST면 진짜 경쟁이므로 그대로 던진다.
  }
  try {
    writeSync(fd, JSON.stringify(content));
  } finally {
    closeSync(fd);
  }

  let released = false;
  const onExit = (): void => {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  };
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener("exit", onExit); // 정상 해제 시 exit 훅을 걷어 리스너가 누적되지 않게 한다.
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  };
  // 프로세스 비정상 종료 시에도 락이 남지 않게 최선의 안전망을 건다(정상 종료는 위 release()가 처리).
  process.once("exit", onExit);
  // ⚠️ `exit`는 신호로 죽을 때 실행되지 않는다 — 실측(2026-08-24): 배치가 중단되자 락이 남아
  // 다음 실행이 `lock_contended`로 막혔다. 신호를 받으면 해제하고 기본 동작(종료)으로 넘긴다.
  // SIGKILL(-9)은 잡을 수 없으므로 위의 stale 회수 경로가 여전히 필요하다.
  const onSignal = (signal: NodeJS.Signals): void => {
    onExit();
    process.removeListener("exit", onExit);
    process.kill(process.pid, signal); // 기본 처리로 죽는다 — 종료 코드를 위조하지 않는다.
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      process.removeAllListeners(sig);
      onSignal(sig);
    });
  }

  return { path: lockPath, release };
}

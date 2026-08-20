import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * sync/src/lock.ts — §7.4 동시 실행 가드. 카탈로그를 쓰는 모든 명령(`scan`·`measure`·`gen`·`move`·
 * `rollback`·`init`)은 실행 시작 시 `<catalog>/.ctk.lock`을 배타적으로 획득한다. 생성은 `O_EXCL`
 * (원자적)이고, 획득 실패는 대기가 아니라 즉시 실패한다(`lock_contended`).
 *
 * `scan`이 첫 사용처이므로 산출물은 Step 2다(plan §4.1). stale 락의 자동 강제 해제는 하지 않는다
 * (살아 있는 쓰기를 죽일 수 있다) — `ctk doctor`가 보고하고 사용자 확인 하에만 제거한다는 규약은
 * 이후 단계(doctor)의 몫이며, 이 모듈은 원자적 획득/해제 primitive만 제공한다.
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
        (holder ? ` — 보유 명령: ${holder.command}, pid: ${holder.pid}, 시작: ${holder.started_at}` : " (락 내용 판독 불가)"),
    );
    this.name = "LockContendedError";
    this.holder = holder;
  }
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
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LockContendedError(lockPath, readLockInfo(lockPath));
    }
    throw err;
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

  return { path: lockPath, release };
}

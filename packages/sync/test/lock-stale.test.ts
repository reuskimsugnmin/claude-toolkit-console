import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, isProcessAlive, isStaleLock, LockContendedError, type LockInfo } from "../src/lock.js";

/**
 * sync/test/lock-stale.test.ts — **죽은 실행이 남긴 락의 회수.**
 *
 * 배경(2026-08-24 실측): `gen` 배치가 중단되자(SIGKILL) `process.once("exit")` 안전망이 돌지 않아
 * 락이 남았고, 다음 실행이 `lock_contended`로 막혔다. 그때 사용자에게 **빠져나갈 길이 전혀
 * 없었다** — 원래 설계는 복구를 `ctk doctor`로 미뤘고 그것이 만들어지지 않았다. 안전 원칙 6이
 * 경계하는 상태 그대로다.
 *
 * 이 파일이 지키는 경계: **회수는 증명될 때만** 일어나고, 틀리는 방향은 "회수하지 않음"이다.
 */

const MACHINE = "11111111-1111-1111-1111-111111111111";
const OTHER_MACHINE = "22222222-2222-2222-2222-222222222222";

function holder(over: Partial<LockInfo> = {}): LockInfo {
  return {
    pid: 999_999_999, // 존재할 수 없는 pid — 죽은 보유자를 흉내낸다
    command: "gen",
    origin: "cli",
    started_at: "2026-08-24T11:33:57.065Z",
    machine_id: MACHINE,
    ...over,
  };
}

describe("isProcessAlive — 판정 불가는 '살아 있다'로 답한다", () => {
  it("자기 자신은 살아 있다", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("존재하지 않는 pid는 죽었다", () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  /**
   * ⚠️ **EPERM은 "살아 있다"이지 "죽었다"가 아니다.** 다른 사용자 소유 프로세스에 신호를 보내면
   * 존재하는데도 권한이 없어 EPERM이 난다. 이것을 죽음으로 읽으면 **살아 있는 보유자의 락을
   * 회수**하게 되고, 두 실행이 동시에 카탈로그를 쓴다.
   *
   * 이 축은 파괴 실험에서 발견했다 — `code !== "ESRCH"`를 `false`로 바꿔도 표본에 EPERM 케이스가
   * 없어 전부 통과했다. pid 1(init/launchd)은 root 소유라 비-root에서 EPERM을 낸다(실측).
   */
  it("EPERM은 살아 있는 것이다 — 다른 사용자 소유 프로세스를 죽었다고 읽으면 안 된다", () => {
    // 이 테스트는 root로 돌면 의미가 없다(그때는 성공하고 살아 있음이 된다). 어느 쪽이든 true다.
    expect(isProcessAlive(1)).toBe(true);
  });

  it("망가진 pid 기록은 보유자를 특정할 수 없으므로 '죽음'으로 본다 — 회수는 상위 판정이 막는다", () => {
    for (const bad of [0, -1, Number.NaN, 1.5]) expect(isProcessAlive(bad), String(bad)).toBe(false);
  });
});

describe("isStaleLock — 이 머신 + 죽은 pid일 때만 참", () => {
  it("이 머신이고 pid가 죽었으면 stale이다", () => {
    expect(isStaleLock(holder(), MACHINE)).toBe(true);
  });

  it("⚠️ 살아 있는 pid는 stale이 아니다 — 살아 있는 쓰기를 죽이면 카탈로그가 깨진다", () => {
    expect(isStaleLock(holder({ pid: process.pid }), MACHINE)).toBe(false);
  });

  it("⚠️ 다른 머신의 락은 판정하지 않는다 — 그 pid는 여기서 의미가 없다", () => {
    // pid가 죽은 것처럼 보여도 그것은 **이 머신의** pid 공간에 대한 사실일 뿐이다.
    expect(isStaleLock(holder({ machine_id: OTHER_MACHINE }), MACHINE)).toBe(false);
  });

  it("⚠️ 판독 불가(null)는 stale이 아니다 — 모르는 것을 '죽었다'로 지어내지 않는다", () => {
    expect(isStaleLock(null, MACHINE)).toBe(false);
  });
});

describe("acquireLock — 죽은 보유자의 락만 회수한다", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const info = { command: "gen", origin: "cli" as const, started_at: "now", machine_id: MACHINE };

  it("죽은 보유자의 락은 회수하고 실행을 진행한다 (이 수정의 핵심)", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-lock-"));
    writeFileSync(path.join(root, ".ctk.lock"), JSON.stringify(holder()));
    const lock = acquireLock(root, info);
    // 락 파일이 **이번 실행의 것**으로 바뀌었는지 본다 — 지우기만 하고 못 잡으면 의미가 없다.
    const now = JSON.parse(readFileSync(lock.path, "utf8")) as LockInfo;
    expect(now.pid).toBe(process.pid);
    lock.release();
  });

  it("⚠️ 살아 있는 보유자의 락은 회수하지 않고 던진다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-lock-"));
    writeFileSync(path.join(root, ".ctk.lock"), JSON.stringify(holder({ pid: process.pid })));
    expect(() => acquireLock(root, info)).toThrow(LockContendedError);
  });

  it("⚠️ 다른 머신의 락은 회수하지 않는다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-lock-"));
    writeFileSync(path.join(root, ".ctk.lock"), JSON.stringify(holder({ machine_id: OTHER_MACHINE })));
    expect(() => acquireLock(root, info)).toThrow(LockContendedError);
  });

  it("에러 메시지가 복구 방법을 알려준다 — 진단만 있고 길이 없으면 가드를 우회하게 된다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-lock-"));
    writeFileSync(path.join(root, ".ctk.lock"), JSON.stringify(holder({ pid: process.pid })));
    try {
      acquireLock(root, info);
      expect.unreachable("던졌어야 한다");
    } catch (err) {
      expect((err as Error).message).toContain("ctk doctor --unlock");
    }
  });

  it("락이 없으면 평소대로 획득한다 — 회수 경로가 정상 경로를 바꾸지 않는다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-lock-"));
    const lock = acquireLock(root, info);
    expect(readFileSync(lock.path, "utf8")).toContain(String(process.pid));
    lock.release();
  });
});

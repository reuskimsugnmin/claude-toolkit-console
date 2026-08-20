import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, LockContendedError } from "../src/lock.js";

describe("sync/lock — §7.4 동시 실행 가드 (O_EXCL 원자적 획득)", () => {
  let catalogRoot: string;
  beforeEach(() => {
    catalogRoot = mkdtempSync(path.join(tmpdir(), "ctk-lock-test-"));
  });
  afterEach(() => {
    rmSync(catalogRoot, { recursive: true, force: true });
  });

  it("락을 획득하고 해제할 수 있다", () => {
    const lock = acquireLock(catalogRoot, {
      command: "scan",
      origin: "cli",
      started_at: new Date().toISOString(),
      machine_id: "m1",
    });
    expect(lock.path).toContain(".ctk.lock");
    lock.release();
  });

  it("이미 보유 중인 락을 다시 획득하면 즉시 LockContendedError — 대기하지 않는다", () => {
    const lock = acquireLock(catalogRoot, {
      command: "scan",
      origin: "cli",
      started_at: new Date().toISOString(),
      machine_id: "m1",
    });
    try {
      expect(() =>
        acquireLock(catalogRoot, {
          command: "scan",
          origin: "web",
          started_at: new Date().toISOString(),
          machine_id: "m1",
        }),
      ).toThrow(LockContendedError);
    } finally {
      lock.release();
    }
  });

  it("release() 이후에는 다시 획득할 수 있다", () => {
    const first = acquireLock(catalogRoot, {
      command: "scan",
      origin: "cli",
      started_at: new Date().toISOString(),
      machine_id: "m1",
    });
    first.release();
    const second = acquireLock(catalogRoot, {
      command: "scan",
      origin: "cli",
      started_at: new Date().toISOString(),
      machine_id: "m1",
    });
    second.release();
  });

  it("release()를 두 번 호출해도 안전하다(멱등)", () => {
    const lock = acquireLock(catalogRoot, {
      command: "scan",
      origin: "cli",
      started_at: new Date().toISOString(),
      machine_id: "m1",
    });
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it("LockContendedError는 보유자 정보를 담는다(진단용)", () => {
    const lock = acquireLock(catalogRoot, {
      command: "gen",
      origin: "web",
      started_at: "2026-08-20T00:00:00.000Z",
      machine_id: "m1",
    });
    try {
      let caught: unknown;
      try {
        acquireLock(catalogRoot, {
          command: "scan",
          origin: "cli",
          started_at: new Date().toISOString(),
          machine_id: "m1",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LockContendedError);
      expect((caught as LockContendedError).holder?.command).toBe("gen");
    } finally {
      lock.release();
    }
  });
});

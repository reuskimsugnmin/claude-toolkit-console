import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 임시 파일은 **내용을 쓰는 순간** 이미 0600 이하여야 한다(chmod 전 구간의 노출 차단, 보안 심사 M1). */
const seen = vi.hoisted(() => ({ modes: [] as number[] }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeSync: (...args: Parameters<typeof real.writeSync>) => {
      seen.modes.push(real.fstatSync(args[0]).mode & 0o777);
      return real.writeSync(...args);
    },
  };
});

const { atomicWriteFile } = await import("../src/guard/atomic-write.js");

describe("actuator/guard/atomic-write — 임시 파일 모드(M1)", () => {
  let dir: string;
  let oldUmask: number;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-aw-mode-"));
    oldUmask = process.umask(0o022); // 기본 "w"가 0644가 되는 조건을 고정한다
    seen.modes = [];
  });
  afterEach(() => {
    process.umask(oldUmask);
    rmSync(dir, { recursive: true, force: true });
  });

  it("쓰기 시점 모드가 0600 이하이고, 최종 모드는 기존 파일 모드를 승계한다", async () => {
    const target = path.join(dir, "x.json");
    atomicWriteFile(target, "{}", { mode: 0o640 });
    expect(seen.modes.length).toBeGreaterThan(0);
    for (const m of seen.modes) expect(m & 0o077).toBe(0);
    expect(statSync(target).mode & 0o777).toBe(0o640);
    atomicWriteFile(target, "{}"); // 기존 파일(0640) 승계
    expect(statSync(target).mode & 0o777).toBe(0o640);
  });
});

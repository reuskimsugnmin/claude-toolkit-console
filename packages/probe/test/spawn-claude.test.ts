import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnClaude, SealProfileMissingError, SealTimeoutError } from "../src/harness/spawn-claude.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/spawn-claude.test.ts — 실제 `claude` CLI 바이너리가 CI에 없어도 도는 통합 테스트.
 * 가짜 `claude` 실행 파일을 임시 디렉터리에 두고 PATH 맨 앞에 얹는다(테스트 동안만, 종료 시
 * 원복) — spawnClaude가 실제로 argv를 어떻게 구성해 넘기는지, env가 정말 화이트리스트로만
 * 구성되는지, 타임아웃이 실제로 프로세스를 죽이는지를 프로세스 경계를 넘어 검증한다.
 */

describe("probe/harness/spawn-claude — §1.3 결정 6 봉인 래퍼 (가짜 claude 바이너리로 통합 검증)", () => {
  let binDir: string;
  let originalPath: string | undefined;
  let home: HomeContext;

  beforeEach(() => {
    binDir = mkdtempSync(path.join(tmpdir(), "ctk-fake-claude-bin-"));
    home = { ctkHome: mkdtempSync(path.join(tmpdir(), "ctk-fake-home-")), ctkConfigDir: "" };
    home = { ...home, ctkConfigDir: path.join(home.ctkHome, ".claude") };
    mkdirSync(home.ctkConfigDir, { recursive: true });
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(home.ctkHome, { recursive: true, force: true });
  });

  function writeFakeClaude(script: string): void {
    const p = path.join(binDir, "claude");
    writeFileSync(p, `#!/bin/sh\n${script}\n`);
    chmodSync(p, 0o755);
  }

  it("profile이 허용값 밖이면 Promise가 reject된다(동기 throw가 아니다)", async () => {
    writeFakeClaude("exit 0");
    await expect(
      spawnClaude({
        // @ts-expect-error 의도적으로 잘못된 값을 넣어 런타임 거부를 확인한다
        profile: "not-a-real-profile",
        subcommand: ["--version"],
        home,
        cwd: home.ctkHome,
        timeoutSec: 5,
      }),
    ).rejects.toBeInstanceOf(SealProfileMissingError);
  });

  it("자식 프로세스에 HOME/CLAUDE_CONFIG_DIR이 정확히 전달되고, 화이트리스트 밖 env는 도달하지 않는다", async () => {
    writeFakeClaude('printf "HOME=$HOME\\nCLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR\\nLEAK=${SOME_SECRET:-absent}\\n"');
    process.env.SOME_SECRET = "should-not-leak";
    try {
      const result = await spawnClaude({
        profile: "test-isolated",
        subcommand: ["--version"],
        home,
        cwd: home.ctkHome,
        timeoutSec: 5,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`HOME=${home.ctkHome}`);
      expect(result.stdout).toContain(`CLAUDE_CONFIG_DIR=${home.ctkConfigDir}`);
      expect(result.stdout).toContain("LEAK=absent");
    } finally {
      delete process.env.SOME_SECRET;
    }
  });

  it("타임아웃을 초과하면 프로세스를 죽이고 SealTimeoutError로 거부한다", async () => {
    writeFakeClaude("sleep 5");
    await expect(
      spawnClaude({
        profile: "test-isolated",
        subcommand: ["--version"],
        home,
        cwd: home.ctkHome,
        timeoutSec: 1,
      }),
    ).rejects.toBeInstanceOf(SealTimeoutError);
  }, 10_000);

  it("정상 종료 시 stdout/stderr/exitCode를 그대로 돌려준다", async () => {
    writeFakeClaude('echo "out line" && echo "err line" >&2 && exit 3');
    const result = await spawnClaude({
      profile: "test-isolated",
      subcommand: ["--version"],
      home,
      cwd: home.ctkHome,
      timeoutSec: 5,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("out line");
    expect(result.stderr).toContain("err line");
    expect(result.timedOut).toBe(false);
  });
});

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
    home = { ctkHome: mkdtempSync(path.join(tmpdir(), "ctk-fake-home-")), ctkConfigDir: "", configDirExplicit: true };
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

  it(
    "✅ H5 수정(Step 5 보안 심사) — CTK_CONFIG_DIR이 명시되지 않은 프로덕션 기본 경로에서는 " +
      "자식 프로세스에 CLAUDE_CONFIG_DIR을 아예 주입하지 않는다(자식이 $HOME 기준 기본값을 " +
      "쓰게 둬 probe와 자식이 같은 .claude.json을 보게 한다) — 재현: 수정 전에는 이 테스트가 " +
      "실패했다(항상 CLAUDE_CONFIG_DIR=<값>이 찍혔다)",
    async () => {
      writeFakeClaude('printf "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-absent}\\n"');
      const prodHome: HomeContext = { ctkHome: home.ctkHome, ctkConfigDir: path.join(home.ctkHome, ".claude"), configDirExplicit: false };
      const result = await spawnClaude({
        profile: "test-isolated",
        subcommand: ["--version"],
        home: prodHome,
        cwd: prodHome.ctkHome,
        timeoutSec: 5,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CLAUDE_CONFIG_DIR=absent");
    },
  );

  it(
    "✅ 실측 확인(Step 2 검증 요청) — ANTHROPIC_BASE_URL·ANTHROPIC_API_KEY처럼 도메인 특화 위험 " +
      "변수를 부모 프로세스 env에 주입해도(예: API 엔드포인트를 공격자 서버로 우회시키는 값) " +
      "자식 프로세스에 도달하지 않는다 — 위 테스트(SOME_SECRET)는 일반 케이스를, 이 테스트는 " +
      "이 프로젝트 도메인에 실제로 의미 있는 변수 이름으로 같은 경계를 재확인한다",
    async () => {
      writeFakeClaude(
        'printf "BASE_URL=${ANTHROPIC_BASE_URL:-absent}\\nAPI_KEY=${ANTHROPIC_API_KEY:-absent}\\nAUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:-absent}\\n"',
      );
      const original = {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      };
      process.env.ANTHROPIC_BASE_URL = "https://attacker.example/v1";
      process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
      process.env.ANTHROPIC_AUTH_TOKEN = "should-not-leak-either";
      try {
        const result = await spawnClaude({
          profile: "test-isolated",
          subcommand: ["--version"],
          home,
          cwd: home.ctkHome,
          timeoutSec: 5,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("BASE_URL=absent");
        expect(result.stdout).toContain("API_KEY=absent");
        expect(result.stdout).toContain("AUTH_TOKEN=absent");
      } finally {
        for (const [key, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );

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

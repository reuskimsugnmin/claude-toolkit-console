import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeExecutableNotFoundError,
  spawnClaude,
  spawnClaudeAgentProbe,
  SealProfileMissingError,
  SealTimeoutError,
  SealUnverifiedCliError,
} from "../src/harness/spawn-claude.js";
import { SealCwdAncestorConfigError } from "../src/harness/cwd-guard.js";
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
    // L6 — spawnClaude가 처음 보는 실행 파일마다 `--version` sanity check을 하므로(가짜
    // 바이너리가 실제 claude와 동일한 응답을 준다는 최소 확인), 그 인자로 불릴 때만 가짜
    // semver를 찍고 즉시 종료한다. 그 외 인자는 원래 테스트 스크립트 그대로 실행된다.
    writeFileSync(
      p,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (fake claude for tests)"; exit 0; fi\n${script}\n`,
    );
    chmodSync(p, 0o755);
  }

  it("profile이 허용값 밖이면 Promise가 reject된다(동기 throw가 아니다)", async () => {
    writeFakeClaude("exit 0");
    await expect(
      spawnClaude({
        // @ts-expect-error 의도적으로 잘못된 값을 넣어 런타임 거부를 확인한다
        profile: "not-a-real-profile",
        subcommand: ["__noop__"],
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
        subcommand: ["__noop__"],
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
        subcommand: ["__noop__"],
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
          subcommand: ["__noop__"],
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

  it(
    "✅ M6 검증 중 발견한 회귀 재현 — sealed-live 프로파일은 buildChildEnv가 정당하게 심는 " +
      "CLAUDE_CODE_SAFE_MODE=1 자기 선언을 SealEnvLeakError로 오판하지 않는다(마지막 방어선인 " +
      "assertEnvWhitelist가 프로파일과 무관하게 항상 ENV_WHITELIST_COMMON만 봐서, sealed-live가 " +
      "실제로 spawn되는 경로가 생기기 전까지는 드러나지 않았던 잠재 버그)",
    async () => {
      writeFakeClaude("exit 0");
      const result = await spawnClaude({
        profile: "sealed-live",
        subcommand: ["plugin", "list", "--json"],
        home,
        cwd: home.ctkHome,
        timeoutSec: 5,
      });
      expect(result.exitCode).toBe(0);
    },
  );

  it(
    "✅ L6 재현 — PATH에 'claude'라는 이름의 실행 파일이 없으면 spawn 자체를 시도하지 않고 " +
      "ClaudeExecutableNotFoundError로 거부한다(빈 PATH로 재현)",
    async () => {
      const originalP = process.env.PATH;
      process.env.PATH = "";
      try {
        await expect(
          spawnClaude({
            profile: "test-isolated",
            subcommand: ["__noop__"],
            home,
            cwd: home.ctkHome,
            timeoutSec: 5,
          }),
        ).rejects.toBeInstanceOf(ClaudeExecutableNotFoundError);
      } finally {
        process.env.PATH = originalP;
      }
    },
  );

  it(
    "✅ L6 재현 — PATH가 가리키는 'claude'가 --version에 버전 형식이 아닌 값을 반환하면 " +
      "(동명의 다른 바이너리 의심) ClaudeExecutableNotFoundError로 거부하고, 실제 요청한 " +
      "서브커맨드는 실행되지 않는다",
    async () => {
      // writeFakeClaude와 달리 --version을 버전 형식이 아닌 값으로 답하는 가짜 바이너리.
      const p = path.join(binDir, "claude");
      writeFileSync(p, `#!/bin/sh\necho "not-a-version"\n`);
      chmodSync(p, 0o755);
      await expect(
        spawnClaude({
          profile: "test-isolated",
          subcommand: ["__noop__"],
          home,
          cwd: home.ctkHome,
          timeoutSec: 5,
        }),
      ).rejects.toBeInstanceOf(ClaudeExecutableNotFoundError);
    },
  );

  it("타임아웃을 초과하면 프로세스를 죽이고 SealTimeoutError로 거부한다", async () => {
    writeFakeClaude("sleep 5");
    await expect(
      spawnClaude({
        profile: "test-isolated",
        subcommand: ["__noop__"],
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
      subcommand: ["__noop__"],
      home,
      cwd: home.ctkHome,
      timeoutSec: 5,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("out line");
    expect(result.stderr).toContain("err line");
    expect(result.timedOut).toBe(false);
  });

  describe("iter 8 · B4/B5 — sealed-live 모델 세션 전용 통제", () => {
    it("sealed-live -p 세션은 --tools \"\"를 실제 argv에 실어 자식에게 전달한다(B4)", async () => {
      const argvFile = path.join(binDir, "argv.txt");
      writeFakeClaude(`printf '%s\\n' "$@" > "${argvFile}"`);
      const result = await spawnClaude({
        profile: "sealed-live",
        subcommand: ["-p"],
        home,
        cwd: home.ctkHome,
        timeoutSec: 5,
        verifiedCliVersion: "9.9.9",
      });
      expect(result.exitCode).toBe(0);
      const argvLines = readFileSync(argvFile, "utf8").split("\n");
      const toolsIndex = argvLines.indexOf("--tools");
      expect(toolsIndex).toBeGreaterThan(-1);
      expect(argvLines[toolsIndex + 1]).toBe("");
    });

    it("검증 버전과 실제 버전이 같으면 preflightVersionMatch가 match다", async () => {
      writeFakeClaude("exit 0");
      const result = await spawnClaude({
        profile: "sealed-live",
        subcommand: ["-p"],
        home,
        cwd: home.ctkHome,
        timeoutSec: 5,
        verifiedCliVersion: "9.9.9", // writeFakeClaude가 --version에 답하는 값과 동일
      });
      expect(result.preflightVersionMatch).toBe("match");
    });

    it("버전이 다르고 라우팅 신호 재현 수단이 없으면 SealUnverifiedCliError로 거부한다(경고가 아니다)", async () => {
      writeFakeClaude("exit 0");
      await expect(
        spawnClaude({
          profile: "sealed-live",
          subcommand: ["-p"],
          home,
          cwd: home.ctkHome,
          timeoutSec: 5,
          verifiedCliVersion: "1.2.3", // 가짜 바이너리는 9.9.9로 응답 — 불일치
        }),
      ).rejects.toBeInstanceOf(SealUnverifiedCliError);
    });

    it("버전이 다르지만 0원 라우팅 신호가 재현되면 진행하고 mismatch_routing_reproduced를 기록한다", async () => {
      const marker = "/__ctk_probe_marker__";
      writeFakeClaude(
        `for a in "$@"; do if [ "$a" = "${marker}" ]; then echo "Unknown command: ${marker}"; exit 1; fi; done\necho real-call-ok`,
      );
      const result = await spawnClaude({
        profile: "sealed-live",
        subcommand: ["-p"],
        home,
        cwd: home.ctkHome,
        timeoutSec: 5,
        verifiedCliVersion: "1.2.3",
        routingProbeCommand: marker,
      });
      expect(result.preflightVersionMatch).toBe("mismatch_routing_reproduced");
      expect(result.stdout).toContain("real-call-ok");
    });
  });

  describe("iter 8 · M2 — spawnClaudeAgentProbe cwd 상위 경로 검사", () => {
    it("cwd 상위에 CLAUDE.md가 있으면 spawn 자체를 시도하지 않고 SealCwdAncestorConfigError로 거부한다", async () => {
      const markerFile = path.join(binDir, "invoked.marker");
      writeFakeClaude(`touch "${markerFile}"`);
      const probeRoot = mkdtempSync(path.join(tmpdir(), "ctk-agent-probe-root-"));
      writeFileSync(path.join(probeRoot, "CLAUDE.md"), "# 상위 경로에 심어진 설정\n");
      const probeCwd = path.join(probeRoot, "cwd");
      mkdirSync(probeCwd, { recursive: true });
      try {
        await expect(
          spawnClaudeAgentProbe({
            subcommand: ["-p"],
            home,
            cwd: probeCwd,
            timeoutSec: 5,
            pluginDir: "/synthetic/plugin-dir",
          }),
        ).rejects.toBeInstanceOf(SealCwdAncestorConfigError);
        expect(existsSync(markerFile)).toBe(false);
      } finally {
        rmSync(probeRoot, { recursive: true, force: true });
      }
    });

    it("상위 경로가 깨끗하면 --safe-mode 없이 --setting-sources project + --plugin-dir로 spawn한다", async () => {
      writeFakeClaude("exit 0");
      const probeRoot = mkdtempSync(path.join(tmpdir(), "ctk-agent-probe-clean-"));
      const probeCwd = path.join(probeRoot, "cwd");
      mkdirSync(probeCwd, { recursive: true });
      try {
        const result = await spawnClaudeAgentProbe({
          subcommand: ["-p"],
          home,
          cwd: probeCwd,
          timeoutSec: 5,
          pluginDir: "/synthetic/plugin-dir",
        });
        expect(result.exitCode).toBe(0);
      } finally {
        rmSync(probeRoot, { recursive: true, force: true });
      }
    });
  });
});

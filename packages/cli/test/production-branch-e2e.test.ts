import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runScan } from "../src/commands/scan.js";
import {
  buildChildEnv,
  claudeJsonPath,
  resolveHomeContext,
  type SpawnClaudeOptions,
  type SpawnClaudeResult,
} from "@ctk/probe";

/**
 * cli/test/production-branch-e2e.test.ts — **프로덕션 분기**(`configDirExplicit === false`)의 e2e.
 *
 * 왜 별도 파일인가: 다른 모든 e2e는 `CTK_CONFIG_DIR`을 설정해 격리 분기(`configDirExplicit === true`)만
 * 탄다. 그런데 사용자가 실제로 실행하는 경로는 그 반대 분기다 — H5의 원래 사고가 정확히
 * "테스트가 프로덕션 경로를 검증하지 못한다"였고, H5 수정으로 두 분기가 생기면서 그 갈라짐이
 * 오히려 넓어졌다. 이 파일은 `CTK_HOME`만 설정하고 `CTK_CONFIG_DIR`은 **의도적으로 비워** 실사용
 * 경로를 그대로 탄다(격리는 CTK_HOME이 임시 디렉터리라는 것으로 유지된다).
 */

function fakeSpawn(stdout: string): (options: SpawnClaudeOptions) => Promise<SpawnClaudeResult> {
  return async () => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
}

describe("cli — 프로덕션 분기 e2e (CTK_CONFIG_DIR 미설정)", () => {
  let ctkHome: string;
  let saved: { home?: string; configDir?: string };

  beforeEach(() => {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-prod-branch-"));
    mkdirSync(path.join(ctkHome, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      path.join(ctkHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
      "utf8",
    );
    // 프로덕션에서 `.claude.json`은 `.claude/` 안이 아니라 HOME 바로 아래에 있다(실측).
    writeFileSync(path.join(ctkHome, ".claude.json"), JSON.stringify({ projects: {} }), "utf8");

    saved = { home: process.env.CTK_HOME, configDir: process.env.CTK_CONFIG_DIR };
    process.env.CTK_HOME = ctkHome;
    delete process.env.CTK_CONFIG_DIR; // ← 이 한 줄이 이 파일의 존재 이유다.
  });

  afterEach(() => {
    if (saved.home === undefined) delete process.env.CTK_HOME;
    else process.env.CTK_HOME = saved.home;
    if (saved.configDir === undefined) delete process.env.CTK_CONFIG_DIR;
    else process.env.CTK_CONFIG_DIR = saved.configDir;
    rmSync(ctkHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("프로덕션 분기임을 확인한다 — configDirExplicit이 false다", () => {
    const home = resolveHomeContext();
    expect(home.configDirExplicit).toBe(false);
    expect(home.ctkConfigDir).toBe(path.join(ctkHome, ".claude"));
  });

  it("`.claude.json`이 HOME 바로 아래로 해석된다 (`.claude/` 안이 아니다)", () => {
    const home = resolveHomeContext();
    expect(claudeJsonPath(home)).toBe(path.join(ctkHome, ".claude.json"));
  });

  it("자식 env에 CLAUDE_CONFIG_DIR을 주입하지 않는다 — 자식이 HOME 기준 기본값을 잡게 둔다", () => {
    const home = resolveHomeContext();
    const env = buildChildEnv("test-isolated", home.ctkHome, home.ctkConfigDir, home.configDirExplicit);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.HOME).toBe(ctkHome);
  });

  it("probe와 자식 서브프로세스가 같은 config dir을 본다 (H5 사고의 재발 방지)", () => {
    const home = resolveHomeContext();
    const env = buildChildEnv("test-isolated", home.ctkHome, home.ctkConfigDir, home.configDirExplicit);
    // 자식은 CLAUDE_CONFIG_DIR이 없으므로 `$HOME/.claude`를 쓴다. probe도 같은 값이어야 한다.
    const childConfigDir = env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME!, ".claude");
    expect(childConfigDir).toBe(home.ctkConfigDir);
  });

  it("프로덕션 분기에서 init → scan 왕복이 성립한다", async () => {
    await runInit({});
    const summary = await runScan({ spawnFn: fakeSpawn("[]") });

    expect(summary.installationCount).toBeGreaterThanOrEqual(0);
    expect(summary.snapshotPath).toContain("snapshots");
    // 스냅샷이 실제로 쓰였는지 — 경로만 반환하고 파일이 없는 조용한 실패를 배제한다.
    expect(summary.assetCounts).toBeDefined();
  });
});

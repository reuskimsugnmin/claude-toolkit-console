import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runScan } from "../src/commands/scan.js";
import { runMove } from "../src/commands/move.js";
import { runRollback } from "../src/commands/rollback.js";
import { McpMoveRejectedError } from "@ctk/actuator";
import { collectTree } from "@ctk/probe";

/**
 * cli/test/move-rollback.test.ts — Step 5 필수 산출물: **격리 홈에서의 이관 왕복 e2e**
 * (플러그인 1개 전역→프로젝트 이관 → 재스캔 실측 확인 → 롤백 → 원상복구 확인. 스킬도 동일 왕복).
 *
 * 플러그인 케이스는 **실제 `claude` 바이너리**를 격리된 `CTK_HOME`/`CTK_CONFIG_DIR`에 대해
 * 돌린다(spikes/fixtures/marketplace-source/synth-mp — Step 0 스파이크가 이미 검증한 합성
 * 마켓플레이스/플러그인, 네트워크 불요·오프라인 동작 확인됨). `claude`가 실제로 없는 CI 환경을
 * 위해 마켓플레이스 등록이 실패하면 스킵한다(그 자체가 회귀는 아니다 — 하네스 부재일 뿐).
 *
 * 실제 `~/.claude`는 전혀 건드리지 않는다 — `CTK_HOME`/`CTK_CONFIG_DIR` 둘 다 매 테스트 임시
 * 디렉터리로 격리한다(§6.0 규약과 동형).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const SYNTH_MARKETPLACE_SRC = path.join(REPO_ROOT, "spikes/fixtures/marketplace-source/synth-mp");

function runRealClaude(ctkHome: string, ctkConfigDir: string, cwd: string, args: string[]) {
  return spawnSync("claude", args, {
    cwd,
    env: {
      HOME: ctkHome,
      CLAUDE_CONFIG_DIR: ctkConfigDir,
      PATH: process.env.PATH ?? "",
      TERM: "xterm",
      SHELL: "/bin/bash",
      TMPDIR: "/tmp",
    },
    encoding: "utf8",
  });
}

function writeJson(absPath: string, value: unknown): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(value, null, 2), "utf8");
}

describe("cli — ctk move / ctk rollback 왕복 e2e (Step 5, AC-2.1/2.2/2.3/2.4/2.5/2.9)", () => {
  let ctkHome: string;
  let ctkConfigDir: string;
  let projectDir: string;
  let originalEnv: { CTK_HOME?: string; CTK_CONFIG_DIR?: string };
  let claudeAvailable = true;

  beforeEach(() => {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-move-e2e-home-"));
    ctkConfigDir = path.join(ctkHome, ".claude");
    projectDir = mkdtempSync(path.join(tmpdir(), "ctk-move-e2e-project-"));
    mkdirSync(ctkConfigDir, { recursive: true });

    // 알려진 프로젝트 레지스트리(~/.claude.json의 projects 키) — probe/known-projects.ts와
    // actuator move.ts의 --project-index가 이걸 읽는다. 실제 claude 바이너리는 이 파일을
    // HOME이 아니라 CLAUDE_CONFIG_DIR 안에 쓴다는 것을 별도로 실측했으므로(Step 5 실측 —
    // 하네스 실측 사실로 별도 보고), probe가 읽는 위치(HOME 루트)에 테스트가 직접 씨딩한다.
    writeJson(path.join(ctkHome, ".claude.json"), { projects: { [projectDir]: {} } });

    originalEnv = { CTK_HOME: process.env.CTK_HOME, CTK_CONFIG_DIR: process.env.CTK_CONFIG_DIR };
    process.env.CTK_HOME = ctkHome;
    process.env.CTK_CONFIG_DIR = ctkConfigDir;

    const marketplaceAdd = runRealClaude(ctkHome, ctkConfigDir, ctkHome, [
      "plugin",
      "marketplace",
      "add",
      SYNTH_MARKETPLACE_SRC,
    ]);
    claudeAvailable = marketplaceAdd.status === 0;
    if (claudeAvailable) {
      const install = runRealClaude(ctkHome, ctkConfigDir, ctkHome, ["plugin", "install", "synth@synth-mp", "-s", "user", "-y"]);
      claudeAvailable = install.status === 0;
    }
  });

  afterEach(() => {
    if (originalEnv.CTK_HOME === undefined) delete process.env.CTK_HOME;
    else process.env.CTK_HOME = originalEnv.CTK_HOME;
    if (originalEnv.CTK_CONFIG_DIR === undefined) delete process.env.CTK_CONFIG_DIR;
    else process.env.CTK_CONFIG_DIR = originalEnv.CTK_CONFIG_DIR;
    rmSync(ctkHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("플러그인: user → project 전이 → 재스캔 실측 확인 → 롤백 → 원상복구 확인(AC-2.1)", async () => {
    if (!claudeAvailable) return; // 실제 claude 바이너리/오프라인 마켓플레이스 등록 불가 환경 — 스킵

    await runInit({});

    const ipjAbsPath = path.join(ctkConfigDir, "plugins", "installed_plugins.json");
    const ipjBefore = readFileSync(ipjAbsPath, "utf8");

    const before = await runScan();
    expect(before.assetCounts.plugin).toBeGreaterThanOrEqual(1);

    const moveSummary = await runMove({ assetId: "synth@synth-mp", to: "project", toProjectIndex: 0 });
    expect(moveSummary.kind).toBe("plugin");
    expect(moveSummary.from).toBe("user");
    expect(moveSummary.to).toBe("project:project");

    // AC-2.1ⓒ — installed_plugins.json이 바이트 단위로 무변경(install_scope 무변경의 직접 증거).
    const ipjAfterMove = readFileSync(ipjAbsPath, "utf8");
    expect(ipjAfterMove).toBe(ipjBefore);

    // AC-2.1ⓐ — 재스캔 실측으로 enabled_at 전이 확인.
    const afterMove = await runScan();
    const projectSettings = JSON.parse(readFileSync(path.join(projectDir, ".claude", "settings.json"), "utf8")) as {
      enabledPlugins?: Record<string, boolean>;
    };
    expect(projectSettings.enabledPlugins?.["synth@synth-mp"]).toBe(true);
    const userSettings = JSON.parse(readFileSync(path.join(ctkConfigDir, "settings.json"), "utf8")) as {
      enabledPlugins?: Record<string, boolean>;
    };
    expect(userSettings.enabledPlugins?.["synth@synth-mp"]).toBe(false);
    void afterMove;

    // 롤백 — 원상복구.
    const rollbackSummary = await runRollback({ last: true });
    expect(rollbackSummary.assetId).toBe("synth@synth-mp");

    const ipjAfterRollback = readFileSync(ipjAbsPath, "utf8");
    expect(ipjAfterRollback).toBe(ipjBefore);

    const userSettingsRestored = JSON.parse(readFileSync(path.join(ctkConfigDir, "settings.json"), "utf8")) as {
      enabledPlugins?: Record<string, boolean>;
    };
    expect(userSettingsRestored.enabledPlugins?.["synth@synth-mp"]).toBe(true);

    const afterRollback = await runScan();
    expect(afterRollback.scopeDistribution).toEqual(before.scopeDistribution);
  }, 60_000);

  it("스킬: user → project 전이 → 재스캔 실측 확인 → 롤백 → 원상복구 확인(AC-2.2)", async () => {
    await runInit({});

    mkdirSync(path.join(ctkConfigDir, "skills", "demo-skill"), { recursive: true });
    writeFileSync(
      path.join(ctkConfigDir, "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: 왕복 e2e 픽스처\n---\n\n# demo-skill\n",
      "utf8",
    );

    const before = await runScan({ spawnFn: async () => ({ exitCode: 0, stdout: "[]", stderr: "", timedOut: false }) });
    expect(before.assetCounts.skill).toBeGreaterThanOrEqual(1);

    const configDirBefore = path.join(ctkConfigDir, "skills", "demo-skill");
    const projectDirAfter = path.join(projectDir, ".claude", "skills", "demo-skill");
    expect(existsSync(configDirBefore)).toBe(true);
    expect(existsSync(projectDirAfter)).toBe(false);

    const moveSummary = await runMove({ assetId: "demo-skill", to: "project", toProjectIndex: 0 });
    expect(moveSummary.kind).toBe("skill");

    // AC-2.2 — 원본 경로 부재 + 새 위치에 존재 + 내용 sha256 동일.
    expect(existsSync(configDirBefore)).toBe(false);
    expect(existsSync(projectDirAfter)).toBe(true);
    expect(readFileSync(path.join(projectDirAfter, "SKILL.md"), "utf8")).toBe(
      "---\nname: demo-skill\ndescription: 왕복 e2e 픽스처\n---\n\n# demo-skill\n",
    );

    await runRollback({ last: true });

    // 원상복구 — 원래 위치로 되돌아오고 새 위치는 사라진다.
    expect(existsSync(configDirBefore)).toBe(true);
    expect(existsSync(projectDirAfter)).toBe(false);
    expect(readFileSync(path.join(configDirBefore, "SKILL.md"), "utf8")).toBe(
      "---\nname: demo-skill\ndescription: 왕복 e2e 픽스처\n---\n\n# demo-skill\n",
    );
  });

  it("MCP 자산 이관은 거부되고 어떤 파일도 변경되지 않는다(AC-2.9)", async () => {
    await runInit({});
    writeJson(path.join(ctkConfigDir, "settings.json"), {});
    // root mcpServers — probe/sources/mcp.ts가 kind:"mcp" Asset으로 잡는 유일한 정의 위치.
    writeJson(path.join(ctkHome, ".claude.json"), {
      projects: { [projectDir]: {} },
      mcpServers: { "demo-mcp": { command: "true" } },
    });
    await runScan({ spawnFn: async () => ({ exitCode: 0, stdout: "[]", stderr: "", timedOut: false }) });

    const beforeTree = collectTree(ctkConfigDir).entries;

    await expect(runMove({ assetId: "demo-mcp", to: "project", toProjectIndex: 0 })).rejects.toBeInstanceOf(
      McpMoveRejectedError,
    );

    const afterTree = collectTree(ctkConfigDir).entries;
    expect(afterTree).toEqual(beforeTree); // 어떤 파일도 변경되지 않음
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCatalogIndex } from "@ctk/sync";
import type { SpawnClaudeOptions, SpawnClaudeResult } from "@ctk/probe";
import { runInit } from "../src/commands/init.js";
import { runScan } from "../src/commands/scan.js";

/**
 * cli/test/scan-bundled-assets.test.ts — B1 Step 5, AC-4 런타임.
 *
 * `ctk init` → `ctk scan` 왕복 전체를 실제로 돌려, 번들 하위 툴이 (a) 카탈로그 인덱스에
 * `parent_asset_id`와 함께 나타나고 (b) 그 자식 id에 대응하는 `Installation` 레코드가 스냅샷에
 * **0건**인지 확인한다(probe/test/sources-bundled.test.ts의 AC-4는 반환 타입만 본다 — 이
 * 테스트는 전체 `ctk scan` 파이프라인을 통과한 뒤에도 그 보장이 유지되는지를 본다).
 */

const PARENT_ID = "demo-plugin@demo-marketplace";

function fakeSpawn(stdout: string): (options: SpawnClaudeOptions) => Promise<SpawnClaudeResult> {
  return async () => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
}

describe("cli — ctk scan은 번들 하위 툴을 부모 참조 Asset으로 편입하되 Installation은 만들지 않는다(B1 Step 5)", () => {
  let ctkHome: string;
  let pluginInstallDir: string;
  let originalEnv: { CTK_HOME?: string; CTK_CONFIG_DIR?: string };

  beforeEach(() => {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-cli-bundled-"));
    pluginInstallDir = path.join(ctkHome, ".claude", "plugins", "cache", "demo-marketplace", "demo-plugin", "1.0.0");
    mkdirSync(pluginInstallDir, { recursive: true });

    // 번들 스킬 1건 + 커맨드 1건.
    mkdirSync(path.join(pluginInstallDir, "skills", "bundled-skill"), { recursive: true });
    writeFileSync(
      path.join(pluginInstallDir, "skills", "bundled-skill", "SKILL.md"),
      "---\nname: bundled-skill\ndescription: 합성 번들 스킬\n---\n\n본문\n",
      "utf8",
    );
    mkdirSync(path.join(pluginInstallDir, "commands"), { recursive: true });
    writeFileSync(
      path.join(pluginInstallDir, "commands", "bundled-command.md"),
      "---\nname: bundled-command\ndescription: 합성 번들 커맨드\n---\n\n본문\n",
      "utf8",
    );

    mkdirSync(path.join(ctkHome, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      path.join(ctkHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          [PARENT_ID]: [
            {
              scope: "user",
              installPath: pluginInstallDir,
              version: "1.0.0",
              installedAt: "2026-08-01T00:00:00.000Z",
              lastUpdated: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
      }),
    );
    writeFileSync(
      path.join(ctkHome, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { [PARENT_ID]: true } }),
    );

    originalEnv = { CTK_HOME: process.env.CTK_HOME, CTK_CONFIG_DIR: process.env.CTK_CONFIG_DIR };
    process.env.CTK_HOME = ctkHome;
    process.env.CTK_CONFIG_DIR = path.join(ctkHome, ".claude");
  });

  afterEach(() => {
    if (originalEnv.CTK_HOME === undefined) delete process.env.CTK_HOME;
    else process.env.CTK_HOME = originalEnv.CTK_HOME;
    if (originalEnv.CTK_CONFIG_DIR === undefined) delete process.env.CTK_CONFIG_DIR;
    else process.env.CTK_CONFIG_DIR = originalEnv.CTK_CONFIG_DIR;
    rmSync(ctkHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("스캔 후 카탈로그 인덱스에 자식 자산이 parent_asset_id와 함께 나타나고 경고가 없다", async () => {
    await runInit({});
    const pluginListStdout = JSON.stringify([
      {
        id: PARENT_ID,
        version: "1.0.0",
        scope: "user",
        enabled: true,
        installPath: pluginInstallDir,
        installedAt: "2026-08-01T00:00:00.000Z",
        lastUpdated: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const summary = await runScan({ spawnFn: fakeSpawn(pluginListStdout) });

    expect(summary.assetCounts.skill).toBe(1);
    expect(summary.assetCounts.command).toBe(1);
    expect(summary.warnings).toEqual([]);

    const index = readCatalogIndex(summary.catalogPath);
    const skillEntry = index.assets.find((a) => a.id === `${PARENT_ID}:bundled-skill`);
    const commandEntry = index.assets.find((a) => a.id === `${PARENT_ID}:bundled-command`);
    expect(skillEntry?.parent_asset_id).toBe(PARENT_ID);
    expect(commandEntry?.parent_asset_id).toBe(PARENT_ID);
  });

  it("자식 id에 대응하는 Installation 레코드가 스냅샷에 0건이다(AC-4 런타임)", async () => {
    await runInit({});
    const pluginListStdout = JSON.stringify([
      {
        id: PARENT_ID,
        version: "1.0.0",
        scope: "user",
        enabled: true,
        installPath: pluginInstallDir,
        installedAt: "2026-08-01T00:00:00.000Z",
        lastUpdated: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const summary = await runScan({ spawnFn: fakeSpawn(pluginListStdout) });

    const snapshotLines = readFileSync(summary.snapshotPath, "utf8").trim().split("\n").filter((l) => l.length > 0);
    const records = snapshotLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const childIds = [`${PARENT_ID}:bundled-skill`, `${PARENT_ID}:bundled-command`];
    const installationsForChildren = records.filter(
      (r) => r._scope === "machine_dependent" && "asset_id" in r && childIds.includes(r.asset_id as string),
    );
    expect(installationsForChildren).toHaveLength(0);

    // 반대 축 — 부모 플러그인 자체는 여전히 Installation을 갖는다(자식만 안 갖는다는 것을 대조한다).
    const parentInstallation = records.find((r) => r._scope === "machine_dependent" && r.asset_id === PARENT_ID);
    expect(parentInstallation).toBeDefined();
  });
});

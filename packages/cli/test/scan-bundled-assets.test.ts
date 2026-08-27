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
    const skillEntry = index.assets.find((a) => a.id === `${PARENT_ID}:skill:bundled-skill`);
    const commandEntry = index.assets.find((a) => a.id === `${PARENT_ID}:command:bundled-command`);
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
    const childIds = [`${PARENT_ID}:skill:bundled-skill`, `${PARENT_ID}:command:bundled-command`];
    const installationsForChildren = records.filter(
      (r) => r._scope === "machine_dependent" && "asset_id" in r && childIds.includes(r.asset_id as string),
    );
    expect(installationsForChildren).toHaveLength(0);

    // 반대 축 — 부모 플러그인 자체는 여전히 Installation을 갖는다(자식만 안 갖는다는 것을 대조한다).
    const parentInstallation = records.find((r) => r._scope === "machine_dependent" && r.asset_id === PARENT_ID);
    expect(parentInstallation).toBeDefined();
  });

  it("보안 심사 H-1 — 같은 부모 안에서 스킬과 커맨드가 같은 이름을 자칭해도 ctk scan이 죽지 않는다(id에 kind가 들어간다)", async () => {
    // beforeEach가 이미 skills/bundled-skill·commands/bundled-command.md를 만들어 둔다 — 여기에
    // 같은 이름("ask")을 자칭하는 스킬·커맨드를 더한다(H-1 실측 축, command+skill).
    mkdirSync(path.join(pluginInstallDir, "skills", "ask"), { recursive: true });
    writeFileSync(
      path.join(pluginInstallDir, "skills", "ask", "SKILL.md"),
      "---\nname: ask\ndescription: 합성 ask 스킬\n---\n\n본문\n",
      "utf8",
    );
    writeFileSync(
      path.join(pluginInstallDir, "commands", "ask.md"),
      "---\nname: ask\ndescription: 합성 ask 커맨드\n---\n\n본문\n",
      "utf8",
    );

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

    // 실행 하나 — 이전 id 형태(`${parentId}:${suffix}`)였다면 여기서 DuplicateAssetIdError로
    // ctk scan 전체가 죽었다(mergeAssets가 중복 id를 throw하도록 고쳐졌기 때문, Step 3).
    const summary = await runScan({ spawnFn: fakeSpawn(pluginListStdout) });

    const index = readCatalogIndex(summary.catalogPath);
    const skillAskId = `${PARENT_ID}:skill:ask`;
    const commandAskId = `${PARENT_ID}:command:ask`;
    expect(skillAskId).not.toBe(commandAskId);
    expect(index.assets.some((a) => a.id === skillAskId)).toBe(true);
    expect(index.assets.some((a) => a.id === commandAskId)).toBe(true);
  });

  it("보안 심사 M-2 — 번들 편입 거부 사유가 warnings에 실려도 원문 절대경로는 나가지 않는다", async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), "ctk-cli-bundled-outside-"));
    const evilId = "evil-plugin@demo-marketplace";
    // installed_plugins.json에 <config>/plugins 경계 밖을 가리키는 두 번째 플러그인을 추가한다.
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
          [evilId]: [
            {
              scope: "user",
              installPath: outsideDir,
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
      JSON.stringify({ enabledPlugins: { [PARENT_ID]: true, [evilId]: true } }),
    );

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
      {
        id: evilId,
        version: "1.0.0",
        scope: "user",
        enabled: true,
        installPath: outsideDir,
        installedAt: "2026-08-01T00:00:00.000Z",
        lastUpdated: "2026-08-01T00:00:00.000Z",
      },
    ]);

    const summary = await runScan({ spawnFn: fakeSpawn(pluginListStdout) });
    const warningsText = summary.warnings.join(" ");

    expect(warningsText).toContain(evilId); // 사유 자체(어느 부모가 거부됐는지)는 그대로 남는다.
    expect(warningsText).not.toContain(outsideDir); // 원문 절대경로는 나가지 않는다.
    expect(warningsText).not.toContain(ctkHome);
    rmSync(outsideDir, { recursive: true, force: true });
  });
});

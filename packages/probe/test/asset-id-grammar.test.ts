import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDisplayableAssetId } from "@ctk/core";
import { collectBundled } from "../src/sources/bundled.js";
import { collectMcp } from "../src/sources/mcp.js";
import { collectPlugins } from "../src/sources/plugins.js";
import { collectSkills } from "../src/sources/skills.js";
import { buildFixtureHome, type FixtureHome } from "./support/fixture-home.js";

/**
 * `isDisplayableAssetId`(core/mcp-toggle.ts, 위험 8)의 문법이 합성 probe 픽스처가 실제로 만드는 id를
 * 하나도 거부하지 않는지 — 거부되는 실물 형태가 나오면 근거와 함께 문법을 넓힌다(공백·제어문자·셸 메타문자 쪽은 금지).
 */
describe("isDisplayableAssetId — 합성 probe 픽스처의 모든 자산 id가 문법을 지난다", () => {
  let fixture: FixtureHome | undefined;
  let extra: string | undefined;
  afterEach(() => {
    fixture?.cleanup();
    if (extra !== undefined) rmSync(extra, { recursive: true, force: true });
  });

  it("mcp·plugin·skill 수집기와 번들(mcp·agent·command) 수집기 산출 id", async () => {
    fixture = buildFixtureHome();
    const { home } = fixture;
    const ids: string[] = [];
    ids.push(...collectMcp({ home, machineId: "m1", installedPluginNames: new Set(["demo-plugin"]) }).assets.map((a) => a.id));
    ids.push(...collectSkills({ home, machineId: "m1" }).assets.map((a) => a.id));
    const plugins = await collectPlugins({
      home,
      machineId: "m1",
      cwd: home.ctkHome,
      timeoutSec: 5,
      spawnFn: async () => ({
        exitCode: 0,
        stdout: JSON.stringify([{ id: "demo-plugin@demo-marketplace", version: "1.0.0", scope: "user", enabled: true, installPath: "/synthetic/cache/demo-plugin", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" }]),
        stderr: "",
        timedOut: false,
      }),
    });
    ids.push(...plugins.assets.map((a) => a.id));

    // 번들 축 — `<부모id>:mcp:<서버>` 형태
    extra = mkdtempSync(path.join(tmpdir(), "ctk-id-grammar-"));
    const bhome = { ctkHome: extra, ctkConfigDir: path.join(extra, ".claude"), configDirExplicit: false };
    const parent = "demo-plugin@synth-marketplace";
    const dir = path.join(bhome.ctkConfigDir, "plugins", "cache", "synth-marketplace", "demo-plugin", "1.0.0");
    mkdirSync(path.join(dir, "agents"), { recursive: true });
    writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "true" } } }), "utf8");
    writeFileSync(path.join(dir, "agents", "helper.md"), "---\nname: helper\ndescription: synthetic\n---\nbody\n", "utf8");
    writeFileSync(
      path.join(bhome.ctkConfigDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { [parent]: [{ scope: "user", installPath: dir, version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" }] } }),
      "utf8",
    );
    const bundled = collectBundled({ home: bhome, pluginIds: [parent] });
    ids.push(...bundled.assets.map((a) => a.id));

    expect(ids.length).toBeGreaterThan(6);
    expect(bundled.assets.some((a) => a.kind === "mcp")).toBe(true);
    for (const id of ids) expect(isDisplayableAssetId(id), id).toBe(true);
  });
});

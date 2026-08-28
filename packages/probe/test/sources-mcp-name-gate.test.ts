import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectMcp } from "../src/sources/mcp.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-mcp-name-gate.test.ts — 보안 재심 M-2 **배선** 검증.
 *
 * ⚠️ **관문을 만든 것과 배선한 것은 다르다.** `safeAssetNameSegment`가 옳게 판정해도
 * `collectMcp`가 그것을 태우지 않으면 독립 MCP 축은 여전히 최상위 JSON 키를 그대로 id로 쓴다.
 */

function buildHome(): { home: HomeContext; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-mcp-name-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  mkdirSync(ctkConfigDir, { recursive: true });
  return { home: { ctkHome, ctkConfigDir, configDirExplicit: false }, cleanup: () => rmSync(ctkHome, { recursive: true, force: true }) };
}

function writeUserMcp(home: HomeContext, servers: Record<string, unknown>): void {
  writeFileSync(path.join(home.ctkHome, ".claude.json"), JSON.stringify({ mcpServers: servers }), "utf8");
}

describe("collectMcp — 독립 MCP 이름도 같은 관문을 지난다(M-2)", () => {
  let fx: { home: HomeContext; cleanup: () => void };
  afterEach(() => fx?.cleanup());

  it("정상 이름은 자산이 된다(대조군 — 관문이 과잉 차단하지 않는다)", () => {
    fx = buildHome();
    writeUserMcp(fx.home, { context7: { command: "npx" } });
    const r = collectMcp({ home: fx.home, machineId: "m1", installedPluginNames: new Set() });
    expect(r.assets.map((a) => a.id)).toContain("context7");
    expect(r.unsafeNamesSkipped).toBe(0);
  });

  it("번들 자산 id를 참칭하는 이름은 그 서버만 건너뛴다 — scan 전체를 죽이지 않는다", () => {
    fx = buildHome();
    writeUserMcp(fx.home, { "demo-plugin@mkt:mcp:t": { command: "true" }, ok: { command: "npx" } });

    const r = collectMcp({ home: fx.home, machineId: "m1", installedPluginNames: new Set() });
    const ids = r.assets.map((a) => a.id);
    expect(ids, "참칭 id가 그대로 자산이 됐다 — M-2 결함이 살아 있다").not.toContain("demo-plugin@mkt:mcp:t");
    expect(ids, "정상 서버까지 함께 죽었다").toContain("ok");
    expect(r.unsafeNamesSkipped).toBe(1);
  });

  it("제어문자가 든 이름도 건너뛴다(L-10) — JSON 키는 임의 바이트를 담는다", () => {
    fx = buildHome();
    const evil = `a${String.fromCharCode(10)}b`;
    writeUserMcp(fx.home, { [evil]: { command: "x" } });
    const r = collectMcp({ home: fx.home, machineId: "m1", installedPluginNames: new Set() });
    expect(r.assets.map((a) => a.id)).not.toContain(evil);
    expect(r.unsafeNamesSkipped).toBe(1);
  });
});

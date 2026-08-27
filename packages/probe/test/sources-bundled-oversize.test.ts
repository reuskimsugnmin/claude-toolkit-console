import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBundled, findBundledToolPath, type BundledSourceResult } from "../src/sources/bundled.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-bundled-oversize.test.ts — 보안 심사 M-2 처방 검증.
 *
 * `findBundledToolPath`(그리고 `collectBundled`)가 매칭 전에 kind 디렉터리의 모든 형제 파일을
 * frontmatter 파싱용으로 통째 읽던 것이 상한 없는 RSS 증폭이었다(심사 실증: 27바이트 대상을
 * 찾는데 형제 60MB가 함께 읽혀 RSS +95MB). 이 테스트는 실제로 64KB(FRONTMATTER_SCAN_MAX_BYTES)를
 * 넘는 형제 파일을 주입해 ⓐ 그 초과 건수가 `reasons`에 조용히 삼켜지지 않고 남는지 ⓑ 그러면서도
 * 대형 파일 자신과 그 옆의 정상 크기 파일이 **둘 다 여전히 올바르게 매칭**되는지(앞부분만 잘라
 * 읽는 것이지 파일을 통째로 배제하는 게 아니다)를 함께 본다.
 */

function buildHome(): { home: HomeContext; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-probe-oversize-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  mkdirSync(ctkConfigDir, { recursive: true });
  return {
    home: { ctkHome, ctkConfigDir, configDirExplicit: false },
    cleanup: () => rmSync(ctkHome, { recursive: true, force: true }),
  };
}

function writeInstalledPlugins(home: HomeContext, entries: Record<string, string>): void {
  const plugins: Record<string, unknown[]> = {};
  for (const [id, installPath] of Object.entries(entries)) {
    plugins[id] = [
      {
        scope: "user",
        installPath,
        version: "1.0.0",
        installedAt: "2026-08-01T00:00:00.000Z",
        lastUpdated: "2026-08-01T00:00:00.000Z",
      },
    ];
  }
  const dir = path.join(home.ctkConfigDir, "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }), "utf8");
}

function makePluginDir(home: HomeContext, name: string): string {
  const dir = path.join(home.ctkConfigDir, "plugins", "cache", "synth-marketplace", name, "1.0.0");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("probe/sources/bundled — frontmatter 스캔 상한(보안 심사 M-2)", () => {
  let fixture: { home: HomeContext; cleanup: () => void };
  afterEach(() => fixture?.cleanup());

  it("64KB를 넘는 형제 에이전트 파일은 앞부분만 읽히고, 그 사실이 oversizeTruncated·reasons에 남는다 — 그러면서도 정상 매칭은 그대로 된다", () => {
    fixture = buildHome();
    const parentId = "demo-plugin@synth-marketplace";
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { [parentId]: pluginDir });

    const agentsDir = path.join(pluginDir, "agents");
    mkdirSync(agentsDir, { recursive: true });

    // 정상 크기 대상 — frontmatter가 상한 훨씬 안쪽에 있다.
    writeFileSync(path.join(agentsDir, "small.md"), "---\nname: small-one\ndescription: 작은 에이전트\n---\n\n정상 본문\n", "utf8");

    // 64KB(FRONTMATTER_SCAN_MAX_BYTES)를 넘는 형제 — frontmatter는 여전히 맨 앞이므로 앞부분만
    // 읽어도 파싱된다. 본문을 100KB로 부풀려 상한을 확실히 넘긴다.
    const bigBody = "y".repeat(100_000);
    writeFileSync(
      path.join(agentsDir, "big.md"),
      `---\nname: big-one\ndescription: 큰 에이전트\n---\n\n${bigBody}\n`,
      "utf8",
    );

    const result: BundledSourceResult = collectBundled({ home: fixture.home, pluginIds: [parentId] });
    const report = result.perParent.find((r) => r.parentId === parentId);

    // 둘 다 잡힌다 — 큰 파일도 배제되지 않는다(앞부분 읽기지 전체 skip이 아니다).
    expect(report?.agents).toBe(2);
    expect(result.assets.filter((a) => a.kind === "agent").map((a) => a.name).sort()).toEqual(["big-one", "small-one"]);

    // 초과분이 조용히 삼켜지지 않는다 — 건수와 사유 둘 다 남는다.
    expect(report?.oversizeTruncated).toBe(1);
    expect(report?.reasons.some((r) => r.includes("agents/") && r.includes("초과"))).toBe(true);

    // findBundledToolPath 경로(gen이 실제로 타는 매칭 경로)도 상한이 걸린 스캐너를 공유하므로
    // 대형 형제가 있어도 정상 크기 대상은 그대로 찾긴다.
    const located = findBundledToolPath(fixture.home, parentId, "agent", "small-one");
    expect(located).toHaveLength(1);
    expect(located[0]?.absPath).toBe(path.join(agentsDir, "small.md"));
  });
});

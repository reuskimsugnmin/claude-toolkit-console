import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBundled, findBundledToolPath, type BundledSourceResult } from "../src/sources/bundled.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-bundled-oversize.test.ts — 보안 심사 M-2 + 3차 심사 L-A 처방 검증.
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

  it("64KB를 넘어도 frontmatter가 상한 안에서 닫혔으면 판정은 정확하다 — 앞부분만 읽고 매칭도 그대로다(L-A: 잘림 ≠ 판정 불가)", () => {
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

    // ⚠️ **L-A로 세는 축이 바뀌었다.** 예전에는 "잘라 읽었다"를 그대로 세어 이 경우에도 1을
    // 보고했다(과잉 보고). 닫는 `---`를 읽은 범위 안에서 봤으므로 판정은 **정확하고**, 세어야
    // 하는 것은 "판정이 뒤집힐 수 있었던 건수"다 — 여기서는 0이다.
    expect(report?.frontmatterUnmeasured, "닫힌 frontmatter를 판정 불가로 세고 있다(과잉 보고)").toBe(0);
    expect(report?.reasons.some((r) => r.includes("판정 불가"))).toBe(false);

    // findBundledToolPath 경로(gen이 실제로 타는 매칭 경로)도 상한이 걸린 스캐너를 공유하므로
    // 대형 형제가 있어도 정상 크기 대상은 그대로 찾긴다.
    const located = findBundledToolPath(fixture.home, parentId, "agent", "small-one");
    if (!located.ok) throw new Error("경로 검증이 실패했다 — 픽스처를 의심한다");
    expect(located.locations).toHaveLength(1);
    expect(located.locations[0]?.absPath).toBe(path.join(agentsDir, "small.md"));
  });

  /**
   * ⚠️ **3차 심사 L-A의 진짜 사례.** `parseSimpleFrontmatter`는 닫는 `---`가 없으면 파일 끝까지
   * 소비하며 **last-write-wins**를 적용한다. 그래서 상한(64KB) 밖에 두 번째 `name:`이 있으면
   * 잘린 쪽과 안 잘린 쪽의 판정이 **달라진다** — 예전 주석은 "빈 결과로 자연히 처리한다"고
   * 주장했으나 거짓이었다.
   *
   * 처방은 **fail-closed**다: 판정할 수 없으면 자칭 값을 아예 쓰지 않고 OS 값(파일 이름)으로
   * 떨어뜨린다. 자칭 name을 반쯤 믿고 쓰면 상한 위치에 따라 자산 정체가 흔들린다.
   */
  it("L-A — frontmatter가 상한 안에서 닫히지 않으면 자칭 name을 쓰지 않고 파일 이름으로 떨어진다(fail-closed)", () => {
    fixture = buildHome();
    const parentId = "demo-plugin@synth-marketplace";
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { [parentId]: pluginDir });

    const agentsDir = path.join(pluginDir, "agents");
    mkdirSync(agentsDir, { recursive: true });

    // 닫는 `---`를 64KB 밖으로 밀어낸다. 채움 줄에는 `---`가 없어야 한다(있으면 거기서 닫힌다).
    const filler = Array.from({ length: 4000 }, (_, i) => `filler_${i}: ${"z".repeat(20)}`).join("\n");
    writeFileSync(
      path.join(agentsDir, "unterminated.md"),
      `---\nname: seen-first\n${filler}\nname: hidden-past-the-limit\n---\n\n본문\n`,
      "utf8",
    );

    const result: BundledSourceResult = collectBundled({ home: fixture.home, pluginIds: [parentId] });
    const report = result.perParent.find((r) => r.parentId === parentId);
    const agentNames = result.assets.filter((a) => a.kind === "agent").map((a) => a.name);

    // 자산은 여전히 편입된다(파일을 통째로 버리지 않는다) — 다만 **정체는 OS 값**이다.
    expect(agentNames).toEqual(["unterminated"]);
    // 두 자칭 name 중 어느 쪽도 쓰이지 않았다. 상한 안쪽 값(`seen-first`)을 쓰는 것이 예전 결함이다.
    expect(agentNames, "상한 안쪽의 자칭 name이 그대로 쓰였다 — L-A 결함이 살아 있다").not.toContain("seen-first");
    expect(agentNames).not.toContain("hidden-past-the-limit");
    // description도 쓰지 않는다 — 같은 블록에서 온 값이므로 신뢰도가 같다.
    expect(result.assets.find((a) => a.kind === "agent")?.description).toBeUndefined();

    // 건수와 사유가 조용히 삼켜지지 않는다.
    expect(report?.frontmatterUnmeasured).toBe(1);
    expect(report?.reasons.some((r) => r.includes("agents/") && r.includes("판정 불가"))).toBe(true);
  });
});

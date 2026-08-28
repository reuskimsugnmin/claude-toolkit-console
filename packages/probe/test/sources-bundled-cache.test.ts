import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundledToolLocationCache, findBundledToolPath, type BundledToolLocation } from "../src/sources/bundled.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-bundled-cache.test.ts — 보안 심사 M-3 처방 검증.
 *
 * `findBundledToolPath`가 호출마다 `installed_plugins.json`을 다시 읽고 kind 디렉터리를
 * 다시 순회·재읽기하던 O(N²) 낭비를, 호출자가 만든 `BundledToolLocationCache` 하나를 여러
 * 호출에 걸쳐 재사용하는 것으로 없앤다(부모 단위 결과를 한 번만 만들어 재사용).
 *
 * 실제 syscall 횟수를 세는 대신(이 저장소의 vitest ESM 설정에서는 `node:fs`의 named export를
 * `vi.spyOn`으로 가로챌 수 없다 — "Module namespace is not configurable in ESM"), **행동으로
 * 캐시가 실제로 쓰이는지** 증명한다: 첫 호출 뒤 디스크 상태를 바꾸고, 같은 캐시로 다시 부르면
 * (재읽기했다면 보였을) 그 변화가 **보이지 않아야** 캐시가 진짜로 재사용된 것이다. 대조군으로
 * 캐시를 새로 만들어 같은 변경 뒤에 부르면 변화가 그대로 보여야 한다 — 그래야 "캐시가 있어서
 * 안 보인다"와 "애초에 아무것도 안 읽는다"가 구분된다.
 */

function buildHome(): { home: HomeContext; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-probe-cache-"));
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

function writeFlatMd(pluginDirAbs: string, fileName: string, body = "본문"): void {
  const dir = path.join(pluginDirAbs, "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), `---\ndescription: 합성 에이전트\n---\n\n${body}\n`, "utf8");
}

/** L-1로 반환이 유니온이 됐다 — 이 파일의 테스트는 전부 정상 경로라 `ok`를 단언하고 꺼낸다. */
function locationsOf(lookup: ReturnType<typeof findBundledToolPath>): BundledToolLocation[] {
  if (!lookup.ok) throw new Error(`경로 검증이 실패했다(${lookup.state}) — 픽스처를 의심한다`);
  return lookup.locations;
}

describe("probe/sources/bundled — BundledToolLocationCache (보안 심사 M-3)", () => {
  let fixture: { home: HomeContext; cleanup: () => void };
  afterEach(() => fixture?.cleanup());

  it("같은 캐시를 재사용하면 두 번째 호출은 디스크를 다시 읽지 않는다 — 신규 에이전트가 추가돼도 안 보인다", () => {
    fixture = buildHome();
    const parentId = "demo-plugin@synth-marketplace";
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { [parentId]: pluginDir });
    writeFlatMd(pluginDir, "one.md", "첫 번째 에이전트");

    const cache = createBundledToolLocationCache();
    const first = locationsOf(findBundledToolPath(fixture.home, parentId, "agent", "one", cache));
    expect(first).toHaveLength(1);

    // 캐시가 이미 만들어진 뒤 디스크에 두 번째 에이전트를 추가한다 — 재스캔했다면 보였을 변화.
    writeFlatMd(pluginDir, "two.md", "두 번째 에이전트");

    // 같은 캐시로 "two"를 찾는다 — 부모 단위 스캔 결과가 캐시에 이미 있으므로 재읽기하지 않고
    // 그 스캔 시점(파일이 없었던 시점) 기준으로 판정한다 — 못 찾는다.
    const secondWithSharedCache = locationsOf(findBundledToolPath(fixture.home, parentId, "agent", "two", cache));
    expect(secondWithSharedCache).toHaveLength(0);

    // 대조군 — 캐시를 새로 만들어 같은 것을 찾으면(디스크를 실제로 다시 읽으면) 보인다.
    // "캐시가 있어서 못 봤다"이지 "애초에 아무것도 안 읽는 결함"이 아님을 이걸로 가른다.
    const freshCache = createBundledToolLocationCache();
    const withFreshCache = locationsOf(findBundledToolPath(fixture.home, parentId, "agent", "two", freshCache));
    expect(withFreshCache).toHaveLength(1);
  });

  it("캐시를 생략하면(기본 인자) 매 호출이 새로 읽는다 — 캐시 없음과 동형(회귀 없음)", () => {
    fixture = buildHome();
    const parentId = "demo-plugin@synth-marketplace";
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { [parentId]: pluginDir });
    writeFlatMd(pluginDir, "one.md", "첫 번째 에이전트");

    expect(locationsOf(findBundledToolPath(fixture.home, parentId, "agent", "one"))).toHaveLength(1);

    writeFlatMd(pluginDir, "two.md", "두 번째 에이전트");
    // 캐시를 넘기지 않은 두 번째 호출은 디스크를 다시 읽으므로 새로 추가된 파일도 바로 보인다.
    expect(locationsOf(findBundledToolPath(fixture.home, parentId, "agent", "two"))).toHaveLength(1);
  });

  it("한 캐시로 같은 부모의 서로 다른 자식(agent·command·skill)을 순서대로 찾아도 결과가 서로 섞이지 않는다", () => {
    fixture = buildHome();
    const parentId = "demo-plugin@synth-marketplace";
    const pluginDir = makePluginDir(fixture.home, "demo-plugin");
    writeInstalledPlugins(fixture.home, { [parentId]: pluginDir });
    writeFlatMd(pluginDir, "the-agent.md", "에이전트 본문");
    mkdirSync(path.join(pluginDir, "commands"), { recursive: true });
    writeFileSync(path.join(pluginDir, "commands", "the-command.md"), "---\ndescription: 합성 커맨드\n---\n\n커맨드 본문\n", "utf8");
    mkdirSync(path.join(pluginDir, "skills", "the-skill"), { recursive: true });
    writeFileSync(path.join(pluginDir, "skills", "the-skill", "SKILL.md"), "---\ndescription: 합성 스킬\n---\n\n스킬 본문\n", "utf8");

    const cache = createBundledToolLocationCache();
    const agent = locationsOf(findBundledToolPath(fixture.home, parentId, "agent", "the-agent", cache));
    const command = locationsOf(findBundledToolPath(fixture.home, parentId, "command", "the-command", cache));
    const skill = locationsOf(findBundledToolPath(fixture.home, parentId, "skill", "the-skill", cache));

    expect(agent).toHaveLength(1);
    expect(agent[0]?.absPath).toBe(path.join(pluginDir, "agents", "the-agent.md"));
    expect(command).toHaveLength(1);
    expect(command[0]?.absPath).toBe(path.join(pluginDir, "commands", "the-command.md"));
    expect(skill).toHaveLength(1);
    expect(skill[0]?.absPath).toBe(path.join(pluginDir, "skills", "the-skill"));
  });
});

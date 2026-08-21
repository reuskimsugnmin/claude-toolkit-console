import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPlugins } from "../src/sources/plugins.js";
import { CommandFailedError } from "../src/sources/errors.js";
import type { SpawnClaudeOptions, SpawnClaudeResult } from "../src/harness/spawn-claude.js";
import { buildFixtureHome, type FixtureHome } from "./support/fixture-home.js";

const PLUGIN_LIST_STDOUT = JSON.stringify([
  {
    id: "demo-plugin@demo-marketplace",
    version: "1.0.0",
    scope: "user",
    enabled: true,
    installPath: "/synthetic/cache/demo-plugin",
    installedAt: "2026-08-01T00:00:00.000Z",
    lastUpdated: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "demo-local@demo-marketplace",
    version: "2.0.0",
    scope: "local",
    enabled: true,
    installPath: "/synthetic/cache/demo-local",
    installedAt: "2026-08-02T00:00:00.000Z",
    lastUpdated: "2026-08-02T00:00:00.000Z",
    projectPath: "/synthetic/projects/alpha",
  },
  {
    id: "demo-local@demo-marketplace",
    version: "2.0.0",
    scope: "local",
    enabled: true,
    installPath: "/synthetic/cache/demo-local",
    installedAt: "2026-08-02T00:00:00.000Z",
    lastUpdated: "2026-08-02T00:00:00.000Z",
    projectPath: "/synthetic/projects/beta",
  },
]);

function fakeSpawn(stdout: string): (options: SpawnClaudeOptions) => Promise<SpawnClaudeResult> {
  return async () => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
}

describe("probe/sources/plugins — id 기준 고유 집계 + install_scope/enabled_at 분리 (P0-3, AC-1.1)", () => {
  let fixture: FixtureHome;
  afterEach(() => fixture?.cleanup());

  it("plugin-list 출력 기준으로 자산이 id 하나당 1건씩 집계된다(P1-13 — local 중복은 자산이 아니라 설치)", async () => {
    fixture = buildFixtureHome();
    const result = await collectPlugins({
      home: fixture.home,
      machineId: "m1",
      cwd: fixture.home.ctkHome,
      timeoutSec: 5,
      spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT),
    });
    expect(result.assets.map((a) => a.id).sort()).toEqual([
      "demo-local@demo-marketplace",
      "demo-plugin@demo-marketplace",
    ]);
    expect(result.assets.every((a) => a.kind === "plugin")).toBe(true);
  });

  it("설치 차원(install_scope + project_path_hash)은 installed_plugins.json 직독에서 온다 — user 1건 + local 2건", async () => {
    fixture = buildFixtureHome();
    const result = await collectPlugins({
      home: fixture.home,
      machineId: "m1",
      cwd: fixture.home.ctkHome,
      timeoutSec: 5,
      spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT),
    });
    const userInstalls = result.installations.filter((i) => i.install_scope === "user");
    const localInstalls = result.installations.filter((i) => i.install_scope === "local");
    expect(userInstalls).toHaveLength(1);
    expect(localInstalls).toHaveLength(2);
    expect(new Set(localInstalls.map((i) => i.project_path_hash)).size).toBe(2); // 서로 다른 프로젝트
  });

  it("enabled_at은 settings.json류 직독에서 따로 채워진다 — user는 전역 settings.json, local은 프로젝트 settings.json", async () => {
    fixture = buildFixtureHome();
    const result = await collectPlugins({
      home: fixture.home,
      machineId: "m1",
      cwd: fixture.home.ctkHome,
      timeoutSec: 5,
      spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT),
    });
    const user = result.installations.find((i) => i.install_scope === "user");
    expect(user?.enabled_at).toBe("user"); // fixture: settings.json.enabledPlugins["demo-plugin@demo-marketplace"]=true

    // fixture: alpha 프로젝트는 enabledPlugins["demo-local@demo-marketplace"]=true, beta는 false —
    // 두 local 설치의 enabled_at이 그 값을 반영해 하나는 "local", 하나는 null로 갈려야 한다.
    const enabledAtValues = result.installations
      .filter((i) => i.install_scope === "local")
      .map((i) => i.enabled_at)
      .sort();
    expect(enabledAtValues).toEqual(["local", null]);
  });

  it("경로 원문이 source_ref에 남지 않는다(AC-1.7) — 홈 상대화 또는 path_hash", async () => {
    fixture = buildFixtureHome();
    const stdout = JSON.stringify([
      {
        id: "demo-plugin@demo-marketplace",
        version: "1.0.0",
        scope: "user",
        enabled: true,
        installPath: `${fixture.home.ctkHome}/.claude/plugins/cache/demo-plugin/1.0.0`,
        installedAt: "t",
        lastUpdated: "t",
      },
    ]);
    const result = await collectPlugins({
      home: fixture.home,
      machineId: "m1",
      cwd: fixture.home.ctkHome,
      timeoutSec: 5,
      spawnFn: fakeSpawn(stdout),
    });
    const asset = result.assets[0];
    expect(asset?.source_ref).not.toContain(fixture.home.ctkHome);
    expect(asset?.source_ref?.startsWith("~/")).toBe(true);
  });

  it("claude plugin list --json이 zod strict 스키마와 맞지 않으면 ParseSchemaMismatchError를 던진다(R13)", async () => {
    fixture = buildFixtureHome();
    await expect(
      collectPlugins({
        home: fixture.home,
        machineId: "m1",
        cwd: fixture.home.ctkHome,
        timeoutSec: 5,
        spawnFn: fakeSpawn(JSON.stringify([{ id: "no-at-sign" }])),
      }),
    ).rejects.toMatchObject({ failureClass: "parse_schema_mismatch" });
  });

  it("AC-1.2ⓑ — 이름은 같고 marketplace가 다른 두 엔트리는 자산 2건으로 남는다(병합 금지)", async () => {
    fixture = buildFixtureHome();
    const stdout = JSON.stringify([
      {
        id: "shared-name@marketplace-one",
        version: "1.0.0",
        scope: "user",
        enabled: true,
        installPath: "/synthetic/cache/one",
        installedAt: "t",
        lastUpdated: "t",
      },
      {
        id: "shared-name@marketplace-two",
        version: "1.0.0",
        scope: "user",
        enabled: true,
        installPath: "/synthetic/cache/two",
        installedAt: "t",
        lastUpdated: "t",
      },
    ]);
    const result = await collectPlugins({
      home: fixture.home,
      machineId: "m1",
      cwd: fixture.home.ctkHome,
      timeoutSec: 5,
      spawnFn: fakeSpawn(stdout),
    });
    expect(result.assets).toHaveLength(2);
    expect(result.assets.map((a) => a.name)).toEqual(["shared-name", "shared-name"]);
    expect(new Set(result.assets.map((a) => a.marketplace))).toEqual(new Set(["marketplace-one", "marketplace-two"]));
  });

  it(
    "✅ 회귀 방지(Step 5, 실측 발견) — user 스코프로 설치된 플러그인이 `-s project`로 특정 " +
      "프로젝트에서만 켜지면(installed_plugins.json은 무변경) 재스캔이 install_scope=user · " +
      "enabled_at=project · project_path_hash=해당 프로젝트인 별도 Installation 레코드를 만든다 " +
      "(actuator move의 user→project 전이를 재스캔으로 검증할 수 있어야 AC-2.1이 성립한다)",
    async () => {
      fixture = buildFixtureHome();
      // demo-plugin@demo-marketplace는 fixture상 user 스코프로만 설치돼 있다. alpha 프로젝트의
      // settings.json에도 같은 id를 켠 상태로 만든다 — `claude plugin enable ... -s project`가
      // 실제로 만드는 파일 모양과 동일(installed_plugins.json 엔트리는 추가되지 않는다, AC-0.8 실측).
      writeFileSync(
        path.join(fixture.projectAlpha, ".claude", "settings.json"),
        JSON.stringify({
          enabledPlugins: { "demo-local@demo-marketplace": true, "demo-plugin@demo-marketplace": true },
        }),
      );
      const result = await collectPlugins({
        home: fixture.home,
        machineId: "m1",
        cwd: fixture.home.ctkHome,
        timeoutSec: 5,
        spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT),
      });
      const projectEnablement = result.installations.find(
        (i) => i.asset_id === "demo-plugin@demo-marketplace" && i.enabled_at === "project",
      );
      expect(projectEnablement).toBeDefined();
      expect(projectEnablement?.install_scope).toBe("user");
      expect(projectEnablement?.project_path_hash).not.toBeNull();
      // 원래의 user 스코프 레코드(전역 settings.json 기준 enabled_at="user")는 그대로 남아있다 —
      // 이 새 레코드는 대체가 아니라 추가다(같은 자산이 여러 스코프에서 동시에 켜질 수 있다).
      const globalEnablement = result.installations.find(
        (i) => i.asset_id === "demo-plugin@demo-marketplace" && i.enabled_at === "user",
      );
      expect(globalEnablement).toBeDefined();
    },
  );

  it(
    "claude plugin list --json이 0이 아닌 종료 코드로 실패하면 빈 stdout을 '플러그인 0개'로 " +
      "조용히 해석하지 않고 CommandFailedError를 던진다(실측으로 발견된 회귀 방지)",
    async () => {
      fixture = buildFixtureHome();
      const failingSpawn = async (): Promise<SpawnClaudeResult> => ({
        exitCode: 1,
        stdout: "",
        stderr: "error: unknown option '--json'",
        timedOut: false,
      });
      await expect(
        collectPlugins({
          home: fixture.home,
          machineId: "m1",
          cwd: fixture.home.ctkHome,
          timeoutSec: 5,
          spawnFn: failingSpawn,
        }),
      ).rejects.toBeInstanceOf(CommandFailedError);
    },
  );
});

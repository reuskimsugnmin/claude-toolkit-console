import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit, RemoteCatalogUnsupportedError } from "../src/commands/init.js";
import { runScan, CatalogNotInitializedError } from "../src/commands/scan.js";
import { runDoctorDrift, NoSnapshotsError } from "../src/commands/doctor.js";
import { runVerifyAc1, NotYetScannedError } from "../src/commands/verify-ac1.js";
import { LockContendedError, acquireLock } from "@ctk/sync";
import { resolveHomeContext, type SpawnClaudeOptions, type SpawnClaudeResult } from "@ctk/probe";
import { readLocalConfig } from "../src/local-config.js";

/**
 * cli/test/init-scan.test.ts — `ctk init` → `ctk scan` 왕복 통합 테스트. `CTK_HOME`/
 * `CTK_CONFIG_DIR`을 임시 디렉터리로 격리하고(§6.0 규약과 동형), `claude plugin list --json`
 * spawn은 주입한 가짜 함수로 대체한다(실제 `claude` 바이너리가 CI에 없어도 돈다).
 */

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
]);

function fakeSpawn(stdout: string): (options: SpawnClaudeOptions) => Promise<SpawnClaudeResult> {
  return async () => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
}

describe("cli — ctk init / ctk scan 왕복 (Step 2)", () => {
  let ctkHome: string;
  let originalEnv: { CTK_HOME?: string; CTK_CONFIG_DIR?: string };

  beforeEach(() => {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-cli-test-home-"));
    mkdirSync(path.join(ctkHome, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      path.join(ctkHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "demo-plugin@demo-marketplace": [
            {
              scope: "user",
              installPath: "/synthetic/cache/demo-plugin",
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
      JSON.stringify({ enabledPlugins: { "demo-plugin@demo-marketplace": true } }),
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
    rmSync(ctkHome, { recursive: true, force: true });
  });

  it("원격 URL은 remote_catalog_unsupported로 거부되고 아무 것도 만들지 않는다(OQ-1 안 C)", async () => {
    await expect(runInit({ catalog: "https://github.com/example/ctk-catalog.git" })).rejects.toBeInstanceOf(
      RemoteCatalogUnsupportedError,
    );
    expect(existsSync(path.join(ctkHome, ".local", "share", "ctk", "catalog"))).toBe(false);
  });

  it("init은 로컬 전용으로 성공하고, catalog_path가 ~/.config/ctk/config.json에 기록된다", async () => {
    const result = await runInit({});
    expect(result.catalogPath).toBe(path.join(ctkHome, ".local", "share", "ctk", "catalog"));
    expect(existsSync(path.join(result.catalogPath, ".git"))).toBe(true);
    const localConfig = JSON.parse(readFileSync(path.join(ctkHome, ".config", "ctk", "config.json"), "utf8")) as {
      catalog_path: string;
    };
    expect(localConfig.catalog_path).toBe(result.catalogPath);
    // <catalog>/ctk.config.json에는 catalog_path가 없다(§1.3 결정 2 — 자기참조 경로 금지).
    const catalogConfig = JSON.parse(readFileSync(path.join(result.catalogPath, "ctk.config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect("catalog_path" in catalogConfig).toBe(false);
  });

  it("scan은 init 없이 실행하면 CatalogNotInitializedError를 던진다", async () => {
    await expect(runScan({ spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT) })).rejects.toBeInstanceOf(
      CatalogNotInitializedError,
    );
  });

  it("init → scan 왕복 — 스냅샷·자산·인덱스·실행로그가 만들어지고 잡힌 자산 수가 픽스처와 일치한다", async () => {
    await runInit({});
    const summary = await runScan({ spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT) });

    expect(existsSync(summary.snapshotPath)).toBe(true);
    expect(existsSync(summary.runLogPath)).toBe(true);
    expect(summary.assetCounts.plugin).toBe(1); // installed_plugins.json + plugin-list 양쪽 다 demo-plugin 1건

    const index = JSON.parse(readFileSync(path.join(summary.catalogPath, "catalog", "index.json"), "utf8")) as {
      assets: { id: string; kind: string }[];
    };
    // cli-path 소스는 이 테스트를 실행하는 실제 머신의 PATH도 함께 본다(collectCliTools가
    // process.env.PATH를 기본값으로 쓴다) — 그래서 plugin kind만 필터링해 픽스처와 대조한다.
    expect(index.assets.filter((a) => a.kind === "plugin").map((a) => a.id)).toEqual([
      "demo-plugin@demo-marketplace",
    ]);

    // git 커밋이 실제로 생겼는지(로그 안 남기고 커밋 여부만 파일시스템으로 확인).
    expect(existsSync(path.join(summary.catalogPath, ".git"))).toBe(true);
  });

  it("두 번째 scan은 새 스냅샷 파일을 append하고(덮어쓰지 않고) doctor --drift가 diff를 계산한다", async () => {
    await runInit({});
    await runScan({ spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT) });

    // installed_plugins.json에 새 플러그인을 추가하고, plugin-list 출력에도 반영해 두 번째
    // 스캔에서 유입되게 한다(두 소스가 항상 같이 갱신돼야 한다는 실제 하네스 동작을 흉내낸다).
    const newPluginInstallEntry = {
      scope: "user",
      installPath: "/synthetic/cache/new-plugin",
      version: "1.0.0",
      installedAt: "2026-08-03T00:00:00.000Z",
      lastUpdated: "2026-08-03T00:00:00.000Z",
    };
    writeFileSync(
      path.join(ctkHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "demo-plugin@demo-marketplace": [JSON.parse(PLUGIN_LIST_STDOUT)[0]],
          "new-plugin@demo-marketplace": [newPluginInstallEntry],
        },
      }),
    );
    const secondListStdout = JSON.stringify([
      JSON.parse(PLUGIN_LIST_STDOUT)[0],
      { id: "new-plugin@demo-marketplace", enabled: true, ...newPluginInstallEntry },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5)); // 파일명 타임스탬프가 겹치지 않게
    await runScan({ spawnFn: fakeSpawn(secondListStdout) });

    const drift = runDoctorDrift();
    expect(drift.added).toContain("new-plugin@demo-marketplace");
  });

  it(
    "✅ 회귀 방지(Step 2 실환경 이례) — 프론트매터 name이 충돌하는 두 스킬 디렉터리가 있어도 " +
      "환경이 그 사이 안 바뀌면 doctor --drift는 예외 없이 끝나고 무변경 건수가 두 번째 scan의 " +
      "installationCount와 정확히 일치한다(191 vs 189 같은 미스매치가 재발하지 않는다)",
    async () => {
      const skillsRoot = path.join(ctkHome, ".claude", "skills");
      mkdirSync(path.join(skillsRoot, "router-alias"), { recursive: true });
      writeFileSync(path.join(skillsRoot, "router-alias", "SKILL.md"), "---\nname: shared-name\n---\n");
      mkdirSync(path.join(skillsRoot, "shared-name"), { recursive: true });
      writeFileSync(path.join(skillsRoot, "shared-name", "SKILL.md"), "---\nname: shared-name\n---\n");

      await runInit({});
      await runScan({ spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT) });
      await new Promise((resolve) => setTimeout(resolve, 5)); // 파일명 타임스탬프가 겹치지 않게
      const secondSummary = await runScan({ spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT) });

      expect(() => runDoctorDrift()).not.toThrow();
      const drift = runDoctorDrift();
      expect(drift.added).toEqual([]);
      expect(drift.removed).toEqual([]);
      expect(drift.unchangedCount).toBe(secondSummary.installationCount);
    },
  );

  it("doctor --drift는 스냅샷이 1개뿐이면 NoSnapshotsError를 던진다", async () => {
    await runInit({});
    await runScan({ spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT) });
    expect(() => runDoctorDrift()).toThrow(NoSnapshotsError);
  });

  it(
    "✅ 회귀 방지 — ~/.claude.json이 깨져 있으면 scan은 unclassified가 아니라 " +
      "parse_schema_mismatch로 run-log에 남긴다(이전엔 실제 오류의 failure_class를 무시하고 " +
      "항상 unclassified로 로그를 남겼다)",
    async () => {
      await runInit({});
      // 이 테스트 스위트는 CTK_CONFIG_DIR을 명시 설정한다(위 beforeEach) — H5 수정 이후
      // configDirExplicit=true일 때 claudeJsonPath()는 CTK_CONFIG_DIR 안을 본다(probe/home.ts).
      writeFileSync(path.join(ctkHome, ".claude", ".claude.json"), "{not valid json", "utf8");

      await expect(runScan({ spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT) })).rejects.toThrow();

      const localConfig = readLocalConfig(resolveHomeContext());
      const runsDir = path.join(localConfig!.catalog_path, "machines");
      const machineDirName = readdirSync(runsDir)[0]!;
      const runFiles = readdirSync(path.join(runsDir, machineDirName, "runs")).sort();
      const lastRun = JSON.parse(
        readFileSync(path.join(runsDir, machineDirName, "runs", runFiles[runFiles.length - 1]!), "utf8"),
      ) as { failure_class: string };
      expect(lastRun.failure_class).toBe("parse_schema_mismatch");
    },
  );

  it("scan 도중 카탈로그 락이 이미 걸려 있으면 lock_contended로 즉시 실패한다(대기 없음)", async () => {
    await runInit({});
    const localConfig = readLocalConfig(resolveHomeContext());
    const externalLock = acquireLock(localConfig!.catalog_path, {
      command: "gen",
      origin: "web",
      started_at: new Date().toISOString(),
      machine_id: "other",
    });
    try {
      await expect(runScan({ spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT) })).rejects.toBeInstanceOf(LockContendedError);
    } finally {
      externalLock.release();
    }
  });

  it(
    "✅ 회귀 방지 — ctk scan을 한 번도 안 돌린 채(index.json 없음) verify ac1을 호출하면 " +
      "\"0 vs 0, 일치\"라는 거짓 양성을 보고하지 않고 에러로 거부한다(두 대조 경로가 각자 " +
      "readFileSync catch로 빈 Set/빈 배열을 반환하면 우연히 둘 다 비어 있을 때 아무 검증도 안 " +
      "됐는데 '일치'로 보일 수 있었다)",
    async () => {
      // beforeEach가 심어둔 installed_plugins.json도 지워, 재구성 쪽마저 "우연히" 빈 Set이 되는
      // 실제 시나리오(플러그인 0개 신규 머신에서 scan 전에 verify부터 돌리는 경우)를 재현한다.
      unlinkSync(path.join(ctkHome, ".claude", "plugins", "installed_plugins.json"));
      await runInit({}); // scan은 하지 않는다 — index.json이 아직 없다.
      await expect(runVerifyAc1()).rejects.toBeInstanceOf(NotYetScannedError);
    },
  );

  it("verify ac1 — plugin-list 기반 자산 집합과 installed_plugins.json 직독 재구성이 일치한다(AC-1.1)", async () => {
    await runInit({});
    await runScan({ spawnFn: fakeSpawn(PLUGIN_LIST_STDOUT) });
    const report = await runVerifyAc1();
    expect(report.independentPluginIdsMatch).toBe(true);
    expect(report.snapshotPluginCount).toBe(1);
    expect(report.reconstructedPluginCount).toBe(1);
  });
});

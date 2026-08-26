import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertAsset, listAllOccupancy } from "@ctk/sync";
import { resolveHomeContext } from "@ctk/probe";
import type { OccupancyValue } from "@ctk/core";
import { runInit } from "../src/commands/init.js";
import { runScan } from "../src/commands/scan.js";
import { runMeasure } from "../src/commands/measure.js";
import { readLocalConfig } from "../src/local-config.js";

async function emptyPluginList() {
  return { exitCode: 0, stdout: "[]", stderr: "", timedOut: false };
}

async function noCredentials(): Promise<OccupancyValue> {
  return { state: "unmeasured", value_tokens: null, reason: "credential_missing" };
}

/**
 * cli/test/measure-bundled-kind.test.ts — B1 Step 2(결정 2 #12, 안전 원칙 7)의 회귀 방지.
 *
 * `computeOccupancy`(measure.ts)는 이전에 kind별 if/if 사슬의 마지막이 skill 처리로 "떨어졌다"
 * — kind가 늘어나면 새 값도 조용히 skill 분기로 떨어져 SKILL.md를 못 찾고 `measurement_failed`
 * ("실패")를 냈다. 실제로는 "아직 정의가 없다"("없음")여야 한다. exhaustive switch로 바꿔
 * kind마다 명시적으로 답하게 했으므로, 여기서는 **없음과 실패가 실제로 다른 값으로 나오는지**
 * `agent`/`command` 자산을 직접 카탈로그에 심어 확인한다(probe/sources/bundled.ts가 아직 없는
 * B1 Step 2 시점이라 `ctk scan`으로는 이 kind의 자산을 만들 수 없다 — 그래서 `upsertAsset`으로
 * 직접 심는다).
 */
describe("cli/measure — agent/command는 definition_pending이지 measurement_failed가 아니다(B1 Step 2)", () => {
  let ctkHome: string;
  let originalEnv: { CTK_HOME?: string; CTK_CONFIG_DIR?: string; ANTHROPIC_API_KEY?: string; PATH?: string };

  beforeEach(async () => {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-measure-bundled-kind-"));
    originalEnv = {
      CTK_HOME: process.env.CTK_HOME,
      CTK_CONFIG_DIR: process.env.CTK_CONFIG_DIR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      PATH: process.env.PATH,
    };
    process.env.CTK_HOME = ctkHome;
    process.env.CTK_CONFIG_DIR = path.join(ctkHome, ".claude");
    delete process.env.ANTHROPIC_API_KEY;
    const gitDir = path.dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
    process.env.PATH = gitDir;

    await runInit({});
    await runScan({ spawnFn: emptyPluginList });
  });

  afterEach(() => {
    if (originalEnv.CTK_HOME === undefined) delete process.env.CTK_HOME;
    else process.env.CTK_HOME = originalEnv.CTK_HOME;
    if (originalEnv.CTK_CONFIG_DIR === undefined) delete process.env.CTK_CONFIG_DIR;
    else process.env.CTK_CONFIG_DIR = originalEnv.CTK_CONFIG_DIR;
    if (originalEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
    if (originalEnv.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = originalEnv.PATH;
    rmSync(ctkHome, { recursive: true, force: true });
  });

  it.each(["agent", "command"] as const)("kind=%s는 loaded.reason === definition_pending을 낸다", async (kind) => {
    const home = resolveHomeContext();
    const localConfig = readLocalConfig(home);
    expect(localConfig).not.toBeNull();
    const catalogPath = localConfig!.catalog_path;

    upsertAsset(catalogPath, {
      schema_version: 1,
      _scope: "machine_independent",
      id: `demo-plugin@demo-mkt:demo-${kind}`,
      kind,
      name: `demo-${kind}`,
      description: `합성 테스트용 ${kind}`,
    });

    await runMeasure({ noCredentialsOk: true, countTokensFn: noCredentials });

    const occupancy = listAllOccupancy(catalogPath).find((o) => o.asset_id === `demo-plugin@demo-mkt:demo-${kind}`);
    expect(occupancy, `${kind} 자산의 occupancy가 기록되지 않았다`).toBeDefined();
    expect(occupancy!.loaded.state).toBe("unmeasured");
    expect(occupancy!.loaded.value_tokens).toBeNull();
    // 핵심 단언 — "아직 정의가 없다"(definition_pending)이지 "측정 실패"(measurement_failed)가
    // 아니다. skill 분기로 떨어지면 SKILL.md를 못 찾아 measurement_failed가 났다(옛 결함).
    expect(occupancy!.loaded.state === "unmeasured" ? occupancy!.loaded.reason : null).toBe("definition_pending");
  });
});

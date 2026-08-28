import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertAsset } from "@ctk/sync";
import { resolveHomeContext, type SpawnClaudeResult } from "@ctk/probe";
import type { OccupancyValue } from "@ctk/core";
import { runInit } from "../src/commands/init.js";
import { runScan } from "../src/commands/scan.js";
import { runMeasure } from "../src/commands/measure.js";
import { readLocalConfig } from "../src/local-config.js";

/**
 * cli/test/measure-subagent-attribution.test.ts — B4-b 배선 검증.
 *
 * ⚠️ **단위 테스트만으로는 미배선을 못 잡는다.** `resolveSubagentRef`가 옳게 판정해도 `measure`가
 * 그것을 태우지 않으면 `subagent_attribution`은 영원히 `"unresolved"`다 — 실제로 `"resolved"`는
 * B1 이전까지 **한 번도 생산된 적이 없었다**(트랜스크립트의 `subagent_type`과 카탈로그의 번들
 * 에이전트 id는 형태가 달라 절대 일치하지 않았다). 여기서는 `ctk measure`를 끝까지 돌려
 * 스냅샷에 실제로 무엇이 적혔는지 본다.
 */

async function emptyPluginList(): Promise<SpawnClaudeResult> {
  return { exitCode: 0, stdout: "[]", stderr: "", timedOut: false };
}

async function noCredentials(): Promise<OccupancyValue> {
  return { state: "unmeasured", value_tokens: null, reason: "credential_missing" };
}

const PARENT_ID = "demo-plugin@demo-mkt";

describe("cli/measure — 서브에이전트 귀속 해석(B4-b)", () => {
  let ctkHome: string;
  let projectPath: string;
  let catalogPath: string;
  /** 직전 `runMeasure`가 쓴 스냅샷 경로 — 행 조회는 이 파일을 직독한다(measure-usage.test.ts와 동일 관용구). */
  let snapshotPath: string;
  let originalEnv: { CTK_HOME?: string; CTK_CONFIG_DIR?: string; ANTHROPIC_API_KEY?: string; PATH?: string };

  /** `subagent_type` 하나를 담은 합성 트랜스크립트를 쓴다. */
  function writeTranscript(...subagentTypes: string[]): void {
    const sessionFile = path.join(ctkHome, ".claude", "projects", "proj1", "session-a.jsonl");
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    const lines = subagentTypes.map((st, i) =>
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        sessionId: "sess-1",
        timestamp: `2026-08-01T00:00:0${i}.000Z`,
        cwd: projectPath,
        message: {
          content: [{ type: "tool_use", id: `toolu_${i}`, name: "Agent", input: { subagent_type: st } }],
        },
      }),
    );
    writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");
  }

  /** 번들 에이전트 자산을 카탈로그에 심는다 — B1의 id 구조(`<부모id>:agent:<이름>`)를 그대로 쓴다. */
  function seedBundledAgent(parentId: string, name: string): void {
    upsertAsset(catalogPath, {
      schema_version: 1,
      _scope: "machine_independent",
      id: `${parentId}:agent:${name}`,
      kind: "agent",
      name,
      parent_asset_id: parentId,
      description: "합성 테스트용 번들 에이전트",
    });
  }

  /** 스냅샷을 직독해 사용량 행을 찾는다. **`runMeasure` 이후에만 부른다**(그 전엔 파일이 없다). */
  function allRows(): Record<string, unknown>[] {
    return readFileSync(snapshotPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function usageFor(assetId: string): Record<string, unknown> | undefined {
    return allRows().find((r) => r.asset_id === assetId && r.call_count !== undefined);
  }

  async function measure(): Promise<void> {
    const summary = await runMeasure({ noCredentialsOk: true, countTokensFn: noCredentials });
    snapshotPath = summary.snapshotPath;
  }

  beforeEach(async () => {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-measure-subagent-"));
    projectPath = path.join(ctkHome, "projects", "demo-project");
    mkdirSync(projectPath, { recursive: true });
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
    const localConfig = readLocalConfig(resolveHomeContext());
    expect(localConfig).not.toBeNull();
    catalogPath = localConfig!.catalog_path;
  });

  afterEach(() => {
    for (const k of ["CTK_HOME", "CTK_CONFIG_DIR", "ANTHROPIC_API_KEY", "PATH"] as const) {
      const v = originalEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(ctkHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("plugin_qualified 형태가 번들 에이전트 자산 id로 이어지고 resolved로 기록된다", async () => {
    seedBundledAgent(PARENT_ID, "executor");
    writeTranscript("demo-plugin:executor");

    await measure();

    const row = usageFor(`${PARENT_ID}:agent:executor`);
    expect(row, "해석된 자산 id로 사용량 행이 남지 않았다 — 리졸버가 measure에 배선되지 않았다").toBeDefined();
    expect(row).toMatchObject({
      call_count: 1,
      attribution_rule: "prefix_rule:agent_subagent_type",
      subagent_attribution: "resolved",
    });
    // 맨 `subagent_type` 문자열로는 더 이상 행이 남지 않는다 — 두 네임스페이스가 이어졌다.
    expect(usageFor("demo-plugin:executor"), "옛 맨 문자열 행이 함께 남아 중복 집계됐다").toBeUndefined();
  });

  it("bare_name 형태도 후보가 하나면 같은 자산으로 이어진다", async () => {
    seedBundledAgent(PARENT_ID, "executor");
    writeTranscript("executor");

    await measure();

    expect(usageFor(`${PARENT_ID}:agent:executor`)).toMatchObject({ subagent_attribution: "resolved" });
  });

  it("두 형태가 섞여 있으면 **한 행으로 모인다** — 같은 에이전트의 사용량이 둘로 갈리지 않는다", async () => {
    // ⚠️ 이것이 해석을 **집계 전에** 하는 이유다. 집계 뒤에 해석하면 두 형태가 서로 다른 행으로
    // 남은 채 같은 asset_id를 달아, 한 자산의 call_count가 둘로 쪼개진다.
    seedBundledAgent(PARENT_ID, "executor");
    writeTranscript("demo-plugin:executor", "executor", "demo-plugin:executor");

    await measure();

    const rows = allRows().filter((r) => r.asset_id === `${PARENT_ID}:agent:executor` && r.call_count !== undefined);
    expect(rows, "같은 에이전트가 여러 행으로 갈렸다").toHaveLength(1);
    expect(rows[0]?.call_count).toBe(3);
  });

  it("카탈로그에 없는 에이전트는 unresolved로 남고 맨 문자열을 그대로 쓴다 — 결함이 아니다", async () => {
    // 실측상 `bare_name`이 64.7%이고 대부분 하네스 내장 에이전트다. 이들을 억지로 잇지 않는다.
    writeTranscript("general-purpose");

    await measure();

    expect(usageFor("general-purpose")).toMatchObject({ call_count: 1, subagent_attribution: "unresolved" });
  });

  it("후보가 둘이면 unresolved로 남는다 — 어느 쪽인지 추측하지 않는다", async () => {
    seedBundledAgent("plugin-a@demo-mkt", "review");
    seedBundledAgent("plugin-b@demo-mkt", "review");
    writeTranscript("review");

    await measure();

    expect(usageFor("review"), "동명 충돌인데 한쪽을 골랐다").toMatchObject({ subagent_attribution: "unresolved" });
    expect(usageFor("plugin-a@demo-mkt:agent:review")).toBeUndefined();
    expect(usageFor("plugin-b@demo-mkt:agent:review")).toBeUndefined();
  });

  it("대조군 — agent가 아닌 귀속은 not_applicable 그대로다(축이 번지지 않았다)", async () => {
    const sessionFile = path.join(ctkHome, ".claude", "projects", "proj1", "session-b.jsonl");
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "assistant",
        isSidechain: false,
        sessionId: "sess-2",
        timestamp: "2026-08-01T00:00:00.000Z",
        cwd: projectPath,
        message: { content: [{ type: "tool_use", id: "toolu_x", name: "mcp__demo-server__lookup", input: {} }] },
      })}\n`,
      "utf8",
    );

    await measure();

    expect(usageFor("demo-server")).toMatchObject({ subagent_attribution: "not_applicable" });
  });
});

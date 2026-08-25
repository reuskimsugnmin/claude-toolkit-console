import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runScan } from "../src/commands/scan.js";
import { measurementFailureHint, runMeasure } from "../src/commands/measure.js";
import { assessRankingQuality, type OccupancyValue } from "@ctk/core";
import { runUsage } from "../src/commands/usage.js";
import { runDoctorSubagentAttribution } from "../src/commands/doctor.js";
import { readLocalConfig } from "../src/local-config.js";
import { resolveHomeContext, type SpawnClaudeResult } from "@ctk/probe";

/**
 * cli/test/measure-usage.test.ts — Step 3 통합 왕복: `ctk init` → `ctk scan`(skill 자산 등록) →
 * `ctk measure`(합성 트랜스크립트 파싱) → `ctk usage`. `CTK_HOME`/`CTK_CONFIG_DIR` 격리 +
 * `claude plugin list --json`은 빈 배열로 가짜 응답(이 테스트는 plugin 자산을 다루지 않는다 —
 * fetchPluginDetails까지 exercising하면 실제 claude 바이너리를 spawn하게 되므로 범위 밖으로 뺀다).
 *
 * **이 환경(테스트)에는 ANTHROPIC_API_KEY가 없다** — 실행 환경과 동일한 조건이므로
 * `--no-credentials-ok`로 실행해 AC-4.5의 3상태 열화 경로를 그대로 검증한다.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function emptyPluginList(): Promise<SpawnClaudeResult> {
  return { exitCode: 0, stdout: "[]", stderr: "", timedOut: false };
}

/**
 * 크레덴셜 부재 시드.
 *
 * ⚠️ **`delete process.env.ANTHROPIC_API_KEY`만으로는 더 이상 크레덴셜 부재가 재현되지 않는다.**
 * 게이트가 SDK의 전체 해석 체인(env → `ant auth login` 프로파일 → WIF)에 위임하도록 고쳐졌으므로,
 * `ant` 프로파일이 있는 머신에서는 env를 지워도 크레덴셜이 **있다**. env 조작에 기대면 이 테스트는
 * 실행 머신마다 다른 결과를 내는 비결정 테스트가 된다 — 부재를 단언하려면 부재를 주입해야 한다.
 */
async function noCredentials(): Promise<OccupancyValue> {
  return { state: "unmeasured", value_tokens: null, reason: "credential_missing" };
}

describe("cli — ctk measure / ctk usage 왕복 (Step 3)", () => {
  let ctkHome: string;
  let originalEnv: { CTK_HOME?: string; CTK_CONFIG_DIR?: string; ANTHROPIC_API_KEY?: string; PATH?: string };
  let projectPath: string;

  beforeEach(async () => {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-measure-test-home-"));
    const ctkConfigDir = path.join(ctkHome, ".claude");
    projectPath = path.join(ctkHome, "projects", "demo-project");
    mkdirSync(projectPath, { recursive: true });

    // 전역 스킬 1건 — call_count 귀속 대상.
    mkdirSync(path.join(ctkConfigDir, "skills", "demo-skill"), { recursive: true });
    writeFileSync(
      path.join(ctkConfigDir, "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: 합성 테스트용 스킬\n---\n\n# demo-skill\n본문 텍스트.\n",
      "utf8",
    );

    originalEnv = {
      CTK_HOME: process.env.CTK_HOME,
      CTK_CONFIG_DIR: process.env.CTK_CONFIG_DIR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      PATH: process.env.PATH,
    };
    process.env.CTK_HOME = ctkHome;
    process.env.CTK_CONFIG_DIR = ctkConfigDir;
    delete process.env.ANTHROPIC_API_KEY; // 이 환경과 동일한 조건 — 크레덴셜 부재를 명시적으로 재현
    // probe/sources/cli-path.ts는 CTK_HOME 격리와 무관하게 실제 process.env.PATH를 본다 — 이
    // 테스트를 host machine에 설치된 claude/codex/gemini 바이너리 유무에 좌우되지 않게 하려면
    // PATH도 함께 격리해야 한다(그러지 않으면 실행 머신마다 결과가 달라지는 비결정 테스트가 된다).
    // `git`(local-git-repo.ts가 spawn)만은 계속 찾을 수 있어야 하므로 그 디렉터리만 남긴다.
    const gitDir = path.dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
    process.env.PATH = gitDir;

    await runInit({});
    await runScan({ spawnFn: emptyPluginList });

    // 합성 트랜스크립트 — <config>/projects/<project>/<session>.jsonl (실측 구조와 동일).
    const sessionFile = path.join(ctkConfigDir, "projects", "proj1", "session-a.jsonl");
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    const lines = [
      // ① 명시적 attributionSkill 필드가 있는 Skill 호출 (harness_field, AC-4.1 ①)
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        sessionId: "sess-1",
        timestamp: "2026-08-01T00:00:00.000Z",
        cwd: projectPath,
        attributionSkill: "demo-skill",
        message: {
          content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "demo-skill" } }],
          usage: { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
        },
      }),
      JSON.stringify({
        type: "user",
        isSidechain: false,
        sessionId: "sess-1",
        timestamp: "2026-08-01T00:00:01.000Z",
        cwd: projectPath,
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "스킬 실행 결과" }] },
      }),
      // ② 접두 규칙 MCP 호출 (attribution* 필드 없음 → prefix_rule, AC-4.1 ②)
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        sessionId: "sess-1",
        timestamp: "2026-08-01T00:00:02.000Z",
        cwd: projectPath,
        message: {
          content: [{ type: "tool_use", id: "toolu_2", name: "mcp__demo-server__lookup", input: {} }],
          usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
        },
      }),
      JSON.stringify({
        type: "user",
        isSidechain: false,
        sessionId: "sess-1",
        timestamp: "2026-08-01T00:00:03.000Z",
        cwd: projectPath,
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "mcp 결과" }] },
      }),
      // ③ Agent 스폰 — 대응하는 subagents/*.jsonl 파일이 없다(R17 괴리를 의도적으로 재현).
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        sessionId: "sess-1",
        timestamp: "2026-08-01T00:00:04.000Z",
        cwd: projectPath,
        message: {
          content: [{ type: "tool_use", id: "toolu_3", name: "Agent", input: { subagent_type: "general-purpose" } }],
        },
      }),
    ];
    writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");
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
    rmSync(ctkHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("크레덴셜 없이 --no-credentials-ok로 실행하면 exit 0으로 끝나고 3상태가 unmeasured로 정직하게 남는다(AC-4.5)", async () => {
    const summary = await runMeasure({ noCredentialsOk: true, countTokensFn: noCredentials });

    expect(summary.credentialsAvailable).toBe(false);
    expect(summary.transcriptFilesParsed).toBe(1);
    expect(summary.parseFailureCount).toBe(0);
    expect(summary.usageMetricCount).toBe(3); // demo-skill · demo-server(mcp) · general-purpose(agent)
    expect(summary.sessionUsageCount).toBe(1);
    expect(summary.unattributedCallCount).toBe(0);
    expect(summary.agentToolUseCountThisRun).toBe(1);
    expect(summary.newSubagentFilesThisRun).toBe(0);
    expect(summary.subagentAttributionGap).toBe(true); // R17 — Agent 1건인데 subagent 파일 0건

    const home = resolveHomeContext();
    const localConfig = readLocalConfig(home);
    expect(localConfig).not.toBeNull();

    // 스냅샷을 직접 읽어 AC-4.1/4.2/4.3 값을 정확히 대조한다.
    const snapshotContent = readFileSync(summary.snapshotPath, "utf8");
    const rows = snapshotContent
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const skillMetric = rows.find((r) => r.asset_id === "demo-skill");
    expect(skillMetric).toMatchObject({
      call_count: 1,
      last_used_at: "2026-08-01T00:00:00.000Z",
      attribution_source: "harness_field",
      attribution_rule: "harness_field:attributionSkill",
      subagent_attribution: "not_applicable",
    });
    // 크레덴셜이 없어 count_tokens가 전혀 성공하지 못했으므로 token_sum은 0(측정 실패가 누적 0으로
    // 반영된 것 — "0을 사실로 기록"이 아니라 "측정된 것이 없어 합계가 0"이라는 점을 여기 명시).
    expect(skillMetric?.token_sum).toBe(0);

    const mcpMetric = rows.find((r) => r.asset_id === "demo-server");
    expect(mcpMetric).toMatchObject({ call_count: 1, attribution_source: "prefix_rule", attribution_rule: "prefix_rule:mcp_tool" });

    const agentMetric = rows.find((r) => r.asset_id === "general-purpose");
    expect(agentMetric).toMatchObject({
      call_count: 1,
      attribution_source: "prefix_rule",
      attribution_rule: "prefix_rule:agent_subagent_type",
      subagent_attribution: "unresolved", // R17 괴리가 있었으므로
    });

    const sessionUsage = rows.find((r) => r.__kind === "session_usage");
    expect(sessionUsage).toMatchObject({
      session_id: "sess-1",
      input_tokens: 4, // 2(스킬 호출)+2(mcp 호출) — Agent 스폰 행은 message.usage가 없다(합성 데이터)
      output_tokens: 8, // 5+3
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 50,
    });

    // occupancy — demo-skill만 카탈로그 자산이다. 크레덴셜이 없으므로 idle이 unmeasured다.
    expect(summary.occupancyCount).toBe(1);
  });

  it("ctk usage — 크레덴셜 없는 환경에서는 순위가 비고 미측정 자산으로 노출된다(추정치로 채우지 않음)", async () => {
    await runMeasure({ noCredentialsOk: true, countTokensFn: noCredentials });
    const report = runUsage({ unusedExpensive: 5 });

    expect(report.rows).toHaveLength(0);
    expect(report.excludedUnmeasuredAssetIds).toContain("demo-skill");
  });

  it("ctk usage — 순위 자격 판정을 함께 싣는다 (안전 원칙 5·8)", async () => {
    /**
     * `ctk web --export-view-model`은 이 판정을 싣는데 **CLI 경로만 빠져 있었다.**
     * 크레덴셜이 없으면 대부분의 자산이 unmeasured로 빠지고 **비용이 정말로 0인 것만 순위에
     * 남는다** — 개별 숫자는 다 맞는데 "안 쓰는데 비싼 툴"이라는 질문에는 거짓이 된다.
     * 실측(2026-08-23): 상위 3건이 전부 0토큰이고 미측정이 177건이었다.
     */
    await runMeasure({ noCredentialsOk: true, countTokensFn: noCredentials });
    const report = runUsage({ unusedExpensive: 5 });

    expect(report.rankingQuality.is_meaningful, "측정된 자산이 없으면 순위는 결론이 아니다").toBe(false);
    expect(report.rankingQuality.reason).toBe("no_measured_assets");
    // 미측정 건수가 판정에 실려야 사용자가 모집단 크기를 안다.
    expect(report.rankingQuality.unmeasured_count).toBe(report.excludedUnmeasuredAssetIds.length);
  });

  it("판정기는 `core`의 것을 그대로 쓴다 — 두 경로가 각자 판정하면 어긋난다", async () => {
    await runMeasure({ noCredentialsOk: true, countTokensFn: noCredentials });
    const report = runUsage({ unusedExpensive: 5 });
    // web 경로(`buildConsoleViewModel`)와 같은 함수를 통과한 값이어야 한다.
    expect(report.rankingQuality).toEqual(
      assessRankingQuality(
        report.rows.map((r) => r.idle_tokens),
        report.excludedUnmeasuredAssetIds.length,
      ),
    );
  });

  it("credential_missing 사유 없이 크레덴셜 부재 상태로 실행하면(--no-credentials-ok 없이) 거부된다(AC-4.5)", async () => {
    await expect(runMeasure({ countTokensFn: noCredentials })).rejects.toThrow(/credential/i);
  });


  it("env에 API 키가 없어도 SDK 체인이 크레덴셜을 해석하면 게이트를 통과한다(회귀: ant 프로파일 사용자 거부)", async () => {
    // 결함 재현: 옛 게이트는 process.env.ANTHROPIC_API_KEY만 봤다. beforeEach가 그 env를
    // 지워 두었으므로, 체인이 해석에 성공한(=measured를 돌려주는) 시드로도 옛 게이트는 거부한다.
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    const chainResolved = async (): Promise<OccupancyValue> => ({
      state: "measured",
      value_tokens: 7,
      tokenizer_model: "claude-sonnet-5",
      measured_at: new Date().toISOString(),
    });

    const summary = await runMeasure({ countTokensFn: chainResolved });

    expect(summary.credentialsAvailable).toBe(true);
    expect(summary.credentialProbeFailureKind).toBeNull();
  });

  it("크레덴셜은 있는데 측정이 실패하면 거부하지 않고 원인 분류를 실어 통과시킨다(안전 원칙 7 — 없음 vs 실패)", async () => {
    const tlsFailure = async (): Promise<OccupancyValue> => ({
      state: "unmeasured",
      value_tokens: null,
      reason: "measurement_failed",
      failure_kind: "tls_chain_untrusted",
    });

    // --no-credentials-ok 없이도 거부되지 않아야 한다 — 크레덴셜 부재가 아니기 때문이다.
    const summary = await runMeasure({ countTokensFn: tlsFailure });

    expect(summary.credentialsAvailable).toBe(true);
    expect(summary.credentialProbeFailureKind).toBe("tls_chain_untrusted");
  });

  it("진단 안내는 모든 분류에 대해 비어 있지 않다(복구 경로 없는 fail-closed 방지)", () => {
    const kinds = ["tls_chain_untrusted", "network_unreachable", "rate_limited", "api_error", "unclassified"] as const;
    for (const kind of kinds) {
      expect(measurementFailureHint(kind).length).toBeGreaterThan(10);
    }
  });


  it("measure의 count_tokens 호출은 전부 주입 시드를 탄다(배선 누락 회귀 — 소스 단위 게이트)", () => {
    // 항목이 아니라 **범위**로 닫는다(안전 원칙 5). 이 게이트가 없으면 새 측정 경로가 추가될 때
    // 또 한 자리가 빠지고, 그 테스트는 크레덴셜을 주입해 놓고도 조용히 실제 네트워크를 탄다.
    // 실제로 그렇게 새어 있었다: token_sum(AC-4.3) 경로가 배선에서 빠져 같은 테스트가 회선
    // 상태에 따라 0 또는 17을 냈다.
    const src = readFileSync(
      path.join(repoRoot, "packages", "cli", "src", "commands", "measure.ts"),
      "utf8",
    );
    // `countTokensMeasured`가 등장해도 되는 곳은 import·타입 위치·기본값 지정뿐이다.
    const allowed = [
      'import {',
      "countTokensFn?: typeof countTokensMeasured;",
      "countTokensFn: typeof countTokensMeasured,",
      "options.countTokensFn ?? countTokensMeasured;",
      "기본값은 실제 `countTokensMeasured`다",
    ];
    const offending = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => line.includes("countTokensMeasured"))
      .filter(({ line }) => !allowed.some((a) => line.includes(a)))
      // import 블록의 나열 줄(`  countTokensMeasured,`)은 허용한다.
      .filter(({ line }) => line !== "countTokensMeasured,");

    expect(offending).toEqual([]);
  });

  it("ctk doctor — R17 괴리가 있으면 run-log를 읽어 노출한다(수용 기준: subagent_attribution:unresolved + doctor 노출)", async () => {
    await runMeasure({ noCredentialsOk: true, countTokensFn: noCredentials });
    const report = runDoctorSubagentAttribution();
    expect(report).not.toBeNull();
    expect(report?.agentToolUseCount).toBe(1);
    expect(report?.newSubagentFiles).toBe(0);
  });
});

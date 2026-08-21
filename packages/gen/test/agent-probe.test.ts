import { describe, expect, it } from "vitest";
import type { HomeContext } from "@ctk/probe";
import { AGENT_PROBE_WEAKER_SEAL_NOTICE, runAgentProbe } from "../src/agent-probe.js";

const HOME: HomeContext = { ctkHome: "/synthetic/home", ctkConfigDir: "/synthetic/home/.claude", configDirExplicit: true };

describe("gen/agent-probe — AC-3.3 진단 전용 (카탈로그에 쓰지 않는다)", () => {
  it("stdout 머리말에 약한 봉인 고지를 항상 붙인다", async () => {
    const spawnFn = async () => ({ exitCode: 0, stdout: "정답 자산의 usage.md 경로: ...", stderr: "", timedOut: false });
    const result = await runAgentProbe({
      home: HOME,
      cwd: "/synthetic/probe-cwd",
      timeoutSec: 30,
      maxBudgetUsd: 0.5,
      pluginDir: "/synthetic/plugin-dir",
      query: "문서 변환 관련 툴을 찾아 사용법을 알려줘",
      spawnFn: spawnFn as never,
    });
    expect(result.stdout.startsWith(AGENT_PROBE_WEAKER_SEAL_NOTICE)).toBe(true);
    expect(result.stdout).toContain("정답 자산의 usage.md 경로");
    expect(result.exitCode).toBe(0);
  });

  it("query는 argv가 아니라 stdin으로 전달된다(공통 강제 사항 3번)", async () => {
    let captured: { stdinPrompt?: string; pluginDir?: string; subcommand?: string[] } | undefined;
    const spawnFn = async (opts: never) => {
      captured = opts as never;
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    };
    await runAgentProbe({
      home: HOME,
      cwd: "/synthetic/probe-cwd",
      timeoutSec: 30,
      maxBudgetUsd: 0.5,
      pluginDir: "/synthetic/plugin-dir",
      query: "질의문",
      spawnFn: spawnFn as never,
    });
    expect(captured?.stdinPrompt).toBe("질의문");
    expect(captured?.pluginDir).toBe("/synthetic/plugin-dir");
    expect(captured?.subcommand).toContain("--max-budget-usd");
  });
});

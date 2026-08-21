import { describe, expect, it } from "vitest";
import { movePluginEnablement, PluginEnablementCommandFailedError } from "../src/apply/plugin-enablement.js";
import type { SpawnClaudeOptions, SpawnClaudeResult } from "@ctk/probe";

const HOME = { ctkHome: "/synthetic/home", ctkConfigDir: "/synthetic/home/.claude", configDirExplicit: false };

function fakeSpawn(
  script: (options: SpawnClaudeOptions) => SpawnClaudeResult,
): (options: SpawnClaudeOptions) => Promise<SpawnClaudeResult> {
  return async (options) => script(options);
}

describe("actuator/apply/plugin-enablement — 결정 6C: disable(from) -> enable(to)", () => {
  it("disable -s <fromScope> 후 enable -s <toScope> 순서로 정확히 2회 spawn한다", async () => {
    const calls: SpawnClaudeOptions[] = [];
    const spawnFn = fakeSpawn((options) => {
      calls.push(options);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    await movePluginEnablement({
      assetId: "demo@demo-mp",
      fromScope: "user",
      toScope: "project",
      home: HOME,
      fromCwd: "/tmp/from",
      toCwd: "/synthetic/project",
      timeoutSec: 10,
      spawnFn,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.subcommand).toEqual(["plugin", "disable", "demo@demo-mp", "-s", "user"]);
    expect(calls[0]?.cwd).toBe("/tmp/from");
    expect(calls[1]?.subcommand).toEqual(["plugin", "enable", "demo@demo-mp", "-s", "project"]);
    expect(calls[1]?.cwd).toBe("/synthetic/project");
    // 두 호출 모두 test-isolated 프로파일을 쓴다(구조적 서브커맨드 — 모델 세션이 아니다).
    expect(calls.every((c) => c.profile === "test-isolated")).toBe(true);
  });

  it("disable 종료 코드가 0이 아니면 즉시 던지고 enable을 호출하지 않는다(회귀 방지 — 실패를 삼키지 않는다)", async () => {
    const calls: string[] = [];
    const spawnFn = fakeSpawn((options) => {
      calls.push(options.subcommand[1]!);
      if (options.subcommand[1] === "disable") {
        return { exitCode: 1, stdout: "", stderr: "already disabled", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    await expect(
      movePluginEnablement({
        assetId: "demo@demo-mp",
        fromScope: "user",
        toScope: "project",
        home: HOME,
        fromCwd: "/tmp/from",
        toCwd: "/synthetic/project",
        timeoutSec: 10,
        spawnFn,
      }),
    ).rejects.toBeInstanceOf(PluginEnablementCommandFailedError);
    expect(calls).toEqual(["disable"]); // enable은 호출되지 않았다
  });

  it("enable 종료 코드가 0이 아니면 던진다(disable은 이미 성공했더라도)", async () => {
    const spawnFn = fakeSpawn((options) => ({
      exitCode: options.subcommand[1] === "enable" ? 1 : 0,
      stdout: "",
      stderr: options.subcommand[1] === "enable" ? "boom" : "",
      timedOut: false,
    }));

    await expect(
      movePluginEnablement({
        assetId: "demo@demo-mp",
        fromScope: "user",
        toScope: "project",
        home: HOME,
        fromCwd: "/tmp/from",
        toCwd: "/synthetic/project",
        timeoutSec: 10,
        spawnFn,
      }),
    ).rejects.toMatchObject({ step: "enable" });
  });
});

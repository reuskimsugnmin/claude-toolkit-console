import { describe, expect, it } from "vitest";
import { runAgentProbe, PROBE_MODEL, readEnvelopeResultText } from "../src/agent-probe.js";
import { SEAL_TEST_MODEL } from "../src/seal-live-test.js";
import { GEN_MODEL } from "../src/run-claude-p.js";

/**
 * gen/test/spawn-model-pinning.test.ts — **`claude -p`를 띄우는 모든 자리가 모델을 고정하는가.**
 *
 * ⚠️ 이 파일이 생긴 이유: `--model`이 **세 spawn 지점 중 한 곳에만** 있었다. #23이 `gen`을
 * sonnet으로 고정할 때 진단(`agent-probe`)과 봉인 시험(`seal-live-test`)은 그대로였고, 그
 * 자식들은 **사용자의 기본 모델**을 썼다 — 실측 2026-08-26에 진단 1회가 $0.863이었다(17배).
 * **한 자리를 고쳤으면 같은 형태의 다른 자리를 센다**(안전 원칙 5). 그 "셈"을 여기서 한다.
 */

const home = { ctkHome: "/tmp/x", ctkConfigDir: "/tmp/x/.claude" } as never;

/** spawn 인자를 가로채는 스텁. 실제 프로세스를 띄우지 않는다. */
function captureSpawn(): { calls: string[][]; fn: (o: { subcommand: string[] }) => Promise<unknown> } {
  const calls: string[][] = [];
  return {
    calls,
    fn: async (o) => {
      calls.push(o.subcommand);
      return { stdout: "{}", stderr: "", exitCode: 0, timedOut: false };
    },
  };
}

describe("모델 고정 — 모든 유료 spawn 지점", () => {
  it("agent-probe가 `--model`을 명시한다", async () => {
    const spy = captureSpawn();
    await runAgentProbe({
      home,
      cwd: "/tmp/x",
      timeoutSec: 30,
      maxBudgetUsd: 0.1,
      pluginDir: "/tmp/x/plugins",
      query: "q",
      spawnFn: spy.fn as never,
    });
    expect(spy.calls).toHaveLength(1);
    // 값이 아니라 **명시 여부**를 먼저 본다 — 없으면 사용자 기본 모델이 붙는다.
    expect(spy.calls[0], "--model이 없으면 자식이 사용자 기본 모델을 쓴다").toContain("--model");
    expect(spy.calls[0]?.[spy.calls[0].indexOf("--model") + 1]).toBe(PROBE_MODEL);
  });

  it("agent-probe의 모델은 오버라이드할 수 있다 — 다른 모델로 재보는 길을 막지 않는다", async () => {
    const spy = captureSpawn();
    await runAgentProbe({
      home,
      cwd: "/tmp/x",
      timeoutSec: 30,
      maxBudgetUsd: 0.1,
      pluginDir: "/tmp/x/plugins",
      query: "q",
      model: "opus",
      spawnFn: spy.fn as never,
    });
    expect(spy.calls[0]?.[spy.calls[0].indexOf("--model") + 1]).toBe("opus");
  });

  // ⚠️ **상수를 하나로 합치지 않는다.** 값이 같아도 뜻이 다르다 — 한쪽 사정으로 바꿀 때
  // 다른 쪽 판정 기준이 조용히 따라 움직이면 안 된다. 여기서는 **셋 다 존재하는지**만 본다.
  it("세 경로가 각자의 모델 상수를 가진다", () => {
    for (const [name, value] of [
      ["GEN_MODEL", GEN_MODEL],
      ["PROBE_MODEL", PROBE_MODEL],
      ["SEAL_TEST_MODEL", SEAL_TEST_MODEL],
    ] as const) {
      expect(typeof value, `${name}이 없으면 그 경로는 모델을 고정하지 못한다`).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe("readEnvelopeResultText — 못 읽으면 원문을 준다", () => {
  it("봉투에서 사람이 읽을 답변을 꺼낸다", () => {
    expect(readEnvelopeResultText(JSON.stringify({ result: "답변" }))).toBe("답변");
  });

  // **관측이 사라지는 것이 가장 나쁘다**(안전 원칙 7). 파싱 실패를 빈 문자열로 삼키면
  // 사용자는 진단이 무엇을 말했는지 볼 수 없고, 무엇이 잘못됐는지도 알 수 없다.
  it("JSON이 아니면 원문을 그대로 준다 — 빈 문자열로 삼키지 않는다", () => {
    expect(readEnvelopeResultText("깨진 출력")).toBe("깨진 출력");
  });

  it("result 필드가 없으면 원문을 그대로 준다", () => {
    const raw = JSON.stringify({ other: 1 });
    expect(readEnvelopeResultText(raw)).toBe(raw);
  });
});

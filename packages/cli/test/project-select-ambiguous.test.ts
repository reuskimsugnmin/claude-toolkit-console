import { describe, expect, it, vi } from "vitest";
import type { HomeContext } from "@ctk/probe";

/**
 * 8자 이상 해시 접두가 실제 경로 둘과 겹치는 입력은 만들 수 없다(2^32 탐색) — 접두 일치 판정(`matchHashPrefix`, core)이 `ambiguous`를
 * 내는 경우를 이음매로 주입해 **CLI가 그것을 어떻게 다루는지**(첫 일치를 고르지 않고 더 긴 접두를 알려 주며 거부)만 본다.
 */
vi.mock("@ctk/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ctk/core")>()),
  matchHashPrefix: () => ({ kind: "ambiguous", prefixes: ["aaaaaaaa11", "aaaaaaaa22"] }),
}));
vi.mock("@ctk/probe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ctk/probe")>()),
  listKnownProjectPaths: () => ["/synthetic/one", "/synthetic/two"],
}));

const { selectProject, McpToggleRefusedError } = await import("../src/project-select.js");

describe("project-select — 모호한 해시 접두", () => {
  it("첫 일치를 고르지 않고 더 긴 접두를 보여 주며 거부한다", () => {
    const home: HomeContext = { ctkHome: "/synthetic/home", ctkConfigDir: "/synthetic/home/.claude", configDirExplicit: false };
    let thrown: unknown;
    try {
      selectProject(home, { projectHash: "aaaaaaaa" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(McpToggleRefusedError);
    expect((thrown as InstanceType<typeof McpToggleRefusedError>).guard).toBe("hash_ambiguous");
    expect((thrown as Error).message).toContain("aaaaaaaa11, aaaaaaaa22");
  });
});

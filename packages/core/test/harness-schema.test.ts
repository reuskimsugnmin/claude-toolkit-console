import { describe, expect, it } from "vitest";
import { parsePluginList, PluginListEntrySchema, parseTranscriptRow } from "../src/index.js";
import { readFixtureJson, readFixtureJsonl } from "./support/fixtures.js";

describe("plugin-list.schema — 착수 조건 C1 (AC-0.3 정정 스키마)", () => {
  it("합성 픽스처(68/66 중복 패턴 재현)가 전부 parse를 통과한다", () => {
    const raw = readFixtureJson("harness/plugin-list.sample.json");
    const parsed = parsePluginList(raw);
    expect(parsed).toHaveLength(4);
    // id 기준 "중복" 2건은 실제로는 프로젝트별 local-scope 설치다 (P1-13, AC-0.3 실측과 동일한 형)
    const localDupes = parsed.filter((e) => e.id === "demo-local@demo-marketplace");
    expect(localDupes).toHaveLength(2);
    expect(new Set(localDupes.map((e) => e.projectPath))).toEqual(
      new Set(["/synthetic/projects/alpha", "/synthetic/projects/beta"]),
    );
  });

  it("mcpServers 없는 엔트리도 통과한다 (선택 필드)", () => {
    const raw = readFixtureJson("harness/plugin-list.sample.json") as unknown[];
    const bare = raw.find((e) => (e as { id: string }).id === "demo-bare@demo-marketplace");
    expect(() => PluginListEntrySchema.parse(bare)).not.toThrow();
  });

  it(
    "mcpServers는 서버 이름을 키로 하는 객체다 (Step 2 실제 환경 검증 — R13 재정정, " +
      "AC-0.3 스파이크는 빈 배열만 관측해 array로 잘못 고정했었다)",
    () => {
      const raw = readFixtureJson("harness/plugin-list.sample.json") as unknown[];
      const withMcp = raw.find((e) => (e as { id: string }).id === "demo-plugin@demo-marketplace");
      const parsed = PluginListEntrySchema.parse(withMcp);
      expect(parsed.mcpServers).toEqual({
        "demo-server": { type: "http", url: "https://mcp.example.com/mcp" },
      });
    },
  );

  it("mcpServers에 빈 배열을 주면 이제는(재정정 후) 거부된다 — 객체여야 한다", () => {
    const raw = readFixtureJson("harness/plugin-list.sample.json") as Record<string, unknown>[];
    const invalid = { ...raw[0], mcpServers: [] };
    expect(PluginListEntrySchema.safeParse(invalid).success).toBe(false);
  });

  it("C1 — scope:'local'인데 projectPath가 없으면 superRefine이 실패한다", () => {
    const invalid = {
      id: "demo-local@demo-marketplace",
      version: "2.0.0",
      scope: "local",
      enabled: true,
      installPath: "/synthetic/plugins/cache/demo-marketplace/demo-local/2.0.0",
      installedAt: "2026-08-02T00:00:00.000Z",
      lastUpdated: "2026-08-02T00:00:00.000Z",
      // projectPath 누락 — 단순 optional이면 조용히 통과한다. superRefine이 이를 막아야 한다.
    };
    const result = PluginListEntrySchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("C1 — scope:'user'/'project'는 projectPath 없이도 통과한다 (조건부 필수일 뿐)", () => {
    const valid = {
      id: "demo-plugin@demo-marketplace",
      version: "1.0.0",
      scope: "user",
      enabled: true,
      installPath: "/synthetic/plugins/cache/demo-marketplace/demo-plugin/1.0.0",
      installedAt: "2026-08-01T00:00:00.000Z",
      lastUpdated: "2026-08-01T00:00:00.000Z",
    };
    expect(PluginListEntrySchema.safeParse(valid).success).toBe(true);
  });

  it("id가 name@marketplace 형식이 아니면 실패한다", () => {
    const invalid = {
      id: "no-at-sign",
      version: "1.0.0",
      scope: "user",
      enabled: true,
      installPath: "/synthetic/x",
      installedAt: "2026-08-01T00:00:00.000Z",
      lastUpdated: "2026-08-01T00:00:00.000Z",
    };
    expect(PluginListEntrySchema.safeParse(invalid).success).toBe(false);
  });

  it("미지의 키가 있으면 strict 스키마가 실패한다 (R13)", () => {
    const raw = readFixtureJson("harness/plugin-list.sample.json") as Record<string, unknown>[];
    const withDrift = { ...raw[0], future_unexpected_field: true };
    expect(PluginListEntrySchema.safeParse(withDrift).success).toBe(false);
  });
});

describe("transcript-row.schema — AC-0.6b 실측 형에 대한 합성 픽스처 정합성 (F2)", () => {
  it("attribution-present.jsonl 행이 전부 parse된다", () => {
    const rows = readFixtureJsonl("transcripts/attribution-present.jsonl");
    for (const row of rows) {
      expect(() => parseTranscriptRow(row)).not.toThrow();
    }
  });

  it("message.content가 배열이 아니라 평문 문자열이어도 parse된다 (Step 3 실측 정정 — 사람이 직접 입력한 프롬프트의 표준 단축형)", () => {
    const row = { type: "user", isSidechain: false, message: { content: "그냥 텍스트" } };
    expect(() => parseTranscriptRow(row)).not.toThrow();
    expect(parseTranscriptRow(row).message?.content).toBe("그냥 텍스트");
  });

  it("type:'agent-name' 행이 parse된다 (Step 3 실측 추가 — 17번째 관측 타입, 세션 표시 이름 메타데이터)", () => {
    const row = { type: "agent-name", agentName: "some-session-name", sessionId: "sess-1" };
    expect(() => parseTranscriptRow(row)).not.toThrow();
  });

  it("tool_result는 type:'user' 행에서 관측된다 (AC-0.6b ⓐ)", () => {
    const rows = readFixtureJsonl("transcripts/attribution-present.jsonl") as {
      type: string;
      message?: { content?: { type: string }[] };
    }[];
    const toolResultRow = rows.find((r) =>
      r.message?.content?.some((c) => c.type === "tool_result"),
    );
    expect(toolResultRow?.type).toBe("user");
  });

  it("Skill tool_use의 input.skill 형태 — plugin:skill과 bare-name 양쪽을 파싱할 수 있다 (AC-0.6b ⓓ)", () => {
    const rows = readFixtureJsonl("transcripts/attribution-present.jsonl") as {
      message?: { content?: { type: string; name?: string; input?: { skill?: string } }[] };
    }[];
    const skillUse = rows
      .flatMap((r) => r.message?.content ?? [])
      .find((c) => c.type === "tool_use" && c.name === "Skill");
    expect(skillUse?.input?.skill).toBe("demo-plugin:demo-skill");
  });

  it("스폰 도구명 Agent가 파싱된다 (AC-0.6b ⓒ — Task는 이 버전엔 없다)", () => {
    const rows = readFixtureJsonl("transcripts/attribution-present.jsonl") as {
      message?: { content?: { type: string; name?: string }[] };
    }[];
    const agentUse = rows.flatMap((r) => r.message?.content ?? []).find((c) => c.name === "Agent");
    expect(agentUse).toBeDefined();
  });
});

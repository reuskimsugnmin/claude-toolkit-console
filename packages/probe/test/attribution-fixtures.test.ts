import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attribute, parseTranscriptRow } from "@ctk/core";
import { extractRow } from "../src/transcripts/extract.js";

/**
 * probe/test/attribution-fixtures.test.ts — Step 3 수용 기준: "attribution* 유/무 트랜스크립트
 * 양쪽 픽스처에서 귀속 기대값 일치." Step 0/1이 만든 4개 합성 픽스처(fixtures/transcripts/)를
 * extractRow() → attribute() 파이프라인 전체에 통과시켜 기대 귀속 결과를 단언한다 — 스키마
 * parse만 확인한 harness-schema.test.ts와 달리 여기는 **귀속 판정 결과값**까지 검증한다.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.resolve(here, "../../../fixtures");

function readFixtureJsonl(relPath: string): unknown[] {
  return readFileSync(path.join(FIXTURES_ROOT, relPath), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("probe — attribution* 유/무 픽스처 전체 파이프라인 (extractRow → attribute)", () => {
  it("attribution-present.jsonl — attributionSkill+attributionPlugin이 있으므로 harness_field/plugin으로 귀속된다", () => {
    const rows = readFixtureJsonl("transcripts/attribution-present.jsonl").map(parseTranscriptRow);
    const decisions = rows
      .flatMap((r) => extractRow(r).toolUses)
      .map((tu) => attribute({ toolName: tu.toolName, toolInput: tu.toolInput, explicit: tu.explicit }));

    // ① Skill tool_use — attributionSkill+attributionPlugin이 동시에 실려 있다(실측형) → plugin 우선.
    expect(decisions[0]).toEqual({
      attribution_source: "harness_field",
      attribution_rule: "harness_field:attributionPlugin",
      kind: "plugin",
      ref: "demo-plugin",
    });
    // ② Agent tool_use — input에 subagent_type이 없고 explicit 필드도 없다 → 귀속 불가(정직하게 null).
    expect(decisions[1]).toEqual({ attribution_source: "unattributed", attribution_rule: "none", kind: null, ref: null });
  });

  it("attribution-absent-harness_version.jsonl — attribution* 필드가 없으므로 prefix_rule(bare skill)로 귀속된다", () => {
    const rows = readFixtureJsonl("transcripts/attribution-absent-harness_version.jsonl").map(parseTranscriptRow);
    const decisions = rows
      .flatMap((r) => extractRow(r).toolUses)
      .map((tu) => attribute({ toolName: tu.toolName, toolInput: tu.toolInput, explicit: tu.explicit }));

    expect(decisions).toEqual([
      { attribution_source: "prefix_rule", attribution_rule: "prefix_rule:skill_tool_input_bare", kind: "skill", ref: "demo-skill" },
    ]);
  });

  it("attribution-absent-session_option_bare.jsonl — tool_use 자체가 없으므로(--bare 무력화) 귀속 대상이 0건이다", () => {
    const rows = readFixtureJsonl("transcripts/attribution-absent-session_option_bare.jsonl").map(parseTranscriptRow);
    const toolUses = rows.flatMap((r) => extractRow(r).toolUses);
    expect(toolUses).toHaveLength(0);
  });

  it("attribution-absent-unverified.jsonl — Bash 호출은 OQ-3 미결에 따라 unattributed로 정직하게 남는다", () => {
    const rows = readFixtureJsonl("transcripts/attribution-absent-unverified.jsonl").map(parseTranscriptRow);
    const decisions = rows
      .flatMap((r) => extractRow(r).toolUses)
      .map((tu) => attribute({ toolName: tu.toolName, toolInput: tu.toolInput, explicit: tu.explicit }));

    expect(decisions).toEqual([{ attribution_source: "unattributed", attribution_rule: "none", kind: null, ref: null }]);
  });
});

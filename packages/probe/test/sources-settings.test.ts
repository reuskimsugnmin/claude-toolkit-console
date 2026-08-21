import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectHarnessUsage } from "../src/sources/settings.js";
import { buildFixtureHome, type FixtureHome } from "./support/fixture-home.js";

describe("probe/sources/settings — ~/.claude.json skillUsage/pluginUsage 직독 (AC-4.9 교차검증 소스)", () => {
  let fixture: FixtureHome;
  afterEach(() => fixture?.cleanup());

  it("skillUsage/pluginUsage를 읽고 lastUsedAt(epoch ms)을 ISO 8601로 변환한다", () => {
    fixture = buildFixtureHome();
    const claudeJsonPath = path.join(fixture.home.ctkHome, ".claude.json");
    const existing = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({
        ...existing,
        skillUsage: { "demo-skill": { usageCount: 5, lastUsedAt: 1735689600000 } },
        pluginUsage: { "demo-plugin@demo-marketplace": { usageCount: 12, lastUsedAt: 1735689600000, lastUsedNumStartups: 3 } },
      }),
      "utf8",
    );

    const result = collectHarnessUsage(fixture.home);
    expect(result.skillUsage["demo-skill"]).toEqual({ usageCount: 5, lastUsedAt: new Date(1735689600000).toISOString() });
    expect(result.pluginUsage["demo-plugin@demo-marketplace"]?.usageCount).toBe(12);
  });

  it("skillUsage/pluginUsage가 없으면 빈 객체를 반환한다(0으로 조용히 채우지 않고 명시적으로 빈 값)", () => {
    fixture = buildFixtureHome();
    const result = collectHarnessUsage(fixture.home);
    expect(result.skillUsage).toEqual({});
    expect(result.pluginUsage).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import { AssetSchema, bundledParentId, parseAsset } from "../src/schema/asset.js";
import { readFixtureJson } from "./support/fixtures.js";

/**
 * core/test/asset-schema-parent.test.ts — B1 Step 3.
 * `Asset.parent_asset_id`(결정 1) — kind별 marketplace/parent_asset_id 양방향 강제와 id 구조
 * 불변식(`${parent_asset_id}:${suffix}`, D2를 스키마로 승격)을 검증한다.
 *
 * ⚠️ `as T` 캐스팅 금지 — 항상 `parseAsset`/`AssetSchema.parse`로 실제 파서를 통과시킨다.
 */

function baseAsset(overrides: Record<string, unknown>): Record<string, unknown> {
  return { schema_version: 1, _scope: "machine_independent", ...overrides };
}

describe("core/schema/asset — parent_asset_id 양방향 강제(B1 결정 1)", () => {
  it("AC-7-b — 옛(B1 이전) plugin asset.json이 parseAsset을 그대로 통과한다(parent_asset_id 필드 없음)", () => {
    const raw = readFixtureJson("catalog-legacy/catalog/assets/plugin/demo-plugin__a325448b/asset.json");
    const parsed = parseAsset(raw);
    expect(parsed.kind).toBe("plugin");
    expect(parsed.parent_asset_id).toBeUndefined();
  });

  it("AC-7-b — 옛 skill asset.json이 parseAsset을 그대로 통과한다", () => {
    const raw = readFixtureJson("catalog-legacy/catalog/assets/skill/demo-skill-standalone__11112222/asset.json");
    const parsed = parseAsset(raw);
    expect(parsed.kind).toBe("skill");
    expect(parsed.parent_asset_id).toBeUndefined();
  });

  it("AC-7-b — 옛 mcp asset.json이 parseAsset을 그대로 통과한다", () => {
    const raw = readFixtureJson("catalog-legacy/catalog/assets/mcp/demo-mcp-server__33334444/asset.json");
    const parsed = parseAsset(raw);
    expect(parsed.kind).toBe("mcp");
    expect(parsed.parent_asset_id).toBeUndefined();
  });

  it("부재 주입 — kind=agent인데 parent_asset_id가 없으면 파싱 실패(번들로만 존재)", () => {
    const raw = baseAsset({ id: "demo-plugin@demo-marketplace:demo-agent", kind: "agent", name: "demo-agent" });
    expect(() => parseAsset(raw)).toThrow();
  });

  it("부재 주입 — kind=command인데 parent_asset_id가 없으면 파싱 실패", () => {
    const raw = baseAsset({ id: "demo-plugin@demo-marketplace:demo-command", kind: "command", name: "demo-command" });
    expect(() => parseAsset(raw)).toThrow();
  });

  it("모순 주입 — kind=plugin인데 parent_asset_id가 있으면 파싱 실패(plugin은 부모를 가질 수 없다)", () => {
    const raw = baseAsset({
      id: "demo-plugin@demo-marketplace",
      kind: "plugin",
      name: "demo-plugin",
      marketplace: "demo-marketplace",
      parent_asset_id: "someone-else@some-marketplace",
    });
    expect(() => parseAsset(raw)).toThrow();
  });

  it("모순 주입 — kind=mcp/cli에 marketplace가 있으면 파싱 실패(양방향 강제, plugin 전용)", () => {
    const raw = baseAsset({ id: "demo-mcp-server", kind: "mcp", name: "demo-mcp-server", marketplace: "demo-marketplace" });
    expect(() => parseAsset(raw)).toThrow();
  });

  it('구조 불변식 — parent_asset_id: "p"인데 id가 "다른것:x"이면 파싱 실패', () => {
    const raw = baseAsset({
      id: "다른것:demo-agent",
      kind: "agent",
      name: "demo-agent",
      parent_asset_id: "demo-plugin@demo-marketplace",
    });
    expect(() => parseAsset(raw)).toThrow();
  });

  it("구조 불변식 — id 접미사가 경로 순회 문자열이면 파싱 실패(assertCatalogSegment 관문)", () => {
    const raw = baseAsset({
      id: "demo-plugin@demo-marketplace:../../evil",
      kind: "agent",
      name: "evil",
      parent_asset_id: "demo-plugin@demo-marketplace",
    });
    expect(() => parseAsset(raw)).toThrow();
  });

  it("유효한 번들 agent — parent_asset_id와 id 접미사가 규약을 지키면 통과한다", () => {
    const raw = baseAsset({
      id: "demo-plugin@demo-marketplace:demo-agent",
      kind: "agent",
      name: "demo-agent",
      parent_asset_id: "demo-plugin@demo-marketplace",
    });
    const parsed = parseAsset(raw);
    expect(parsed.parent_asset_id).toBe("demo-plugin@demo-marketplace");
  });

  it("유효한 독립 skill — parent_asset_id 없이 통과한다(선택 필드, 독립 쪽)", () => {
    const raw = baseAsset({ id: "standalone-skill", kind: "skill", name: "standalone-skill" });
    const parsed = parseAsset(raw);
    expect(parsed.parent_asset_id).toBeUndefined();
  });

  it("유효한 번들 skill — parent_asset_id를 가지고 통과한다(선택 필드, 번들 쪽)", () => {
    const raw = baseAsset({
      id: "demo-plugin@demo-marketplace:bundled-skill",
      kind: "skill",
      name: "bundled-skill",
      parent_asset_id: "demo-plugin@demo-marketplace",
    });
    const parsed = parseAsset(raw);
    expect(parsed.parent_asset_id).toBe("demo-plugin@demo-marketplace");
  });
});

describe("core/schema/asset — bundledParentId 좁힘 헬퍼", () => {
  it("parent_asset_id가 없으면 null을 반환한다", () => {
    expect(bundledParentId({ parent_asset_id: undefined })).toBeNull();
  });

  it("parent_asset_id가 있으면 그 값을 반환한다", () => {
    expect(bundledParentId({ parent_asset_id: "demo-plugin@demo-marketplace" })).toBe(
      "demo-plugin@demo-marketplace",
    );
  });
});

describe("core/schema/asset — AssetSchema.strict()는 여전히 미지의 키를 거부한다(회귀 방지)", () => {
  it("unexpected_future_field가 섞이면 실패한다", () => {
    const raw = baseAsset({
      id: "demo-mcp-server",
      kind: "mcp",
      name: "demo-mcp-server",
      unexpected_future_field: "drift",
    });
    expect(() => AssetSchema.parse(raw)).toThrow();
  });
});

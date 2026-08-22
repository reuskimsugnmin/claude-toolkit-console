import { describe, expect, it } from "vitest";
import { renderAnnotationMarkdown, renderDocPageMarkdown, type Annotation, type Asset, type DocPage } from "@ctk/core";
import { determineSourceTrust, GEN_SOURCE_TRUST_HEADER } from "../src/source-trust.js";

function pluginAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    schema_version: 1,
    _scope: "machine_independent",
    id: "demo@demo-marketplace",
    kind: "plugin",
    name: "demo",
    marketplace: "demo-marketplace",
    ...overrides,
  };
}

function skillAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    schema_version: 1,
    _scope: "machine_independent",
    id: "demo-skill",
    kind: "skill",
    name: "demo-skill",
    ...overrides,
  };
}

describe("gen/source-trust — iter 8 · B1-4", () => {
  it("kind:plugin은 항상 marketplace다", () => {
    expect(determineSourceTrust(pluginAsset())).toBe("marketplace");
  });

  it("source_ref가 있으면 local이다", () => {
    expect(determineSourceTrust(skillAsset({ source_ref: "skills/demo-skill" }))).toBe("local");
  });

  it("source_ref가 없으면 unknown이다", () => {
    expect(determineSourceTrust(skillAsset())).toBe("unknown");
  });

  it("고정 문구는 정확히 '출처: 서드파티 원문 기반 · 자동 생성'이다(AC-3.9 ⓓ가 이 문자열을 그대로 단언)", () => {
    expect(GEN_SOURCE_TRUST_HEADER).toBe("출처: 서드파티 원문 기반 · 자동 생성");
  });

  it("render-markdown이 렌더링하는 두 문서 모두 고정 문구를 담는다(렌더러·검사기가 같은 상수를 쓴다)", () => {
    const annotation: Annotation = {
      schema_version: 1,
      _scope: "machine_independent",
      asset_id: "demo-skill",
      role: "r",
      purpose: "p",
      when_to_use: "w",
      gen_mode: "rule_extract",
      gen_source_trust: "local",
      generated_at: "2026-08-21T00:00:00.000Z",
    };
    const docPage: DocPage = {
      schema_version: 1,
      _scope: "machine_independent",
      asset_id: "demo-skill",
      catalog_relative_path: "assets/skill/demo-skill/usage.md",
      title: "t",
      body: "b",
      citations: [],
      gen_mode: "rule_extract",
      gen_source_trust: "unknown",
      generated_at: "2026-08-21T00:00:00.000Z",
    };
    expect(renderAnnotationMarkdown(annotation)).toContain(`${GEN_SOURCE_TRUST_HEADER} (local)`);
    expect(renderDocPageMarkdown(docPage)).toContain(`${GEN_SOURCE_TRUST_HEADER} (unknown)`);
  });
});

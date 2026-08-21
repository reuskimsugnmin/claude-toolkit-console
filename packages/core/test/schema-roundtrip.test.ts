import { describe, expect, it } from "vitest";
import {
  AssetSchema,
  InstallationSchema,
  MachineSchema,
  ProjectSchema,
  UsageMetricSchema,
  ToggleSchema,
  JournalEntrySchema,
  RunLogEntrySchema,
  AnnotationSchema,
  DocPageSchema,
  SessionUsageSchema,
} from "../src/index.js";
import { readFixtureJson, readFixtureJsonl } from "./support/fixtures.js";

describe("스키마 라운드트립 — 합성 카탈로그 픽스처 (fixtures/catalog)", () => {
  it("Asset — parse가 통과하고 재직렬화가 동일하다", () => {
    const raw = readFixtureJson("catalog/catalog/assets/plugin/demo-plugin/asset.json");
    const parsed = AssetSchema.parse(raw);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(raw);
  });

  it("machine.json — Machine 스키마를 통과한다", () => {
    const raw = readFixtureJson("catalog/machines/machine-alpha/machine.json");
    expect(() => MachineSchema.parse(raw)).not.toThrow();
  });

  it("snapshots/*.jsonl — 레코드별로 올바른 스키마에 매칭된다 (Installation·Project·UsageMetric·Toggle·SessionUsage)", () => {
    const rows = readFixtureJsonl("catalog/machines/machine-alpha/snapshots/2026-08-01T00-00-00Z.jsonl");
    expect(rows).toHaveLength(5);

    const [installationRaw, projectRaw, usageRaw, toggleRaw, sessionUsageRaw] = rows;
    expect(() => InstallationSchema.parse(installationRaw)).not.toThrow();
    expect(() => ProjectSchema.parse(projectRaw)).not.toThrow();
    expect(() => UsageMetricSchema.parse(usageRaw)).not.toThrow();
    expect(() => ToggleSchema.parse(toggleRaw)).not.toThrow();
    expect(() => SessionUsageSchema.parse(sessionUsageRaw)).not.toThrow();
  });

  it("journal/*.jsonl — JournalEntry 스키마를 통과한다", () => {
    const rows = readFixtureJsonl("catalog/journal/2026-08-01T00-00-00Z.jsonl");
    expect(rows).toHaveLength(1);
    expect(() => JournalEntrySchema.parse(rows[0])).not.toThrow();
  });

  it("runs/*.jsonl — RunLogEntry 스키마를 통과한다", () => {
    const rows = readFixtureJsonl("catalog/machines/machine-alpha/runs/2026-08-01T00-00-00Z.jsonl");
    expect(rows).toHaveLength(1);
    expect(() => RunLogEntrySchema.parse(rows[0])).not.toThrow();
  });

  it("모든 append-only 레코드는 schema_version을 필수로 갖는다 (OQ-6ⓑ)", () => {
    const snapshotRows = readFixtureJsonl(
      "catalog/machines/machine-alpha/snapshots/2026-08-01T00-00-00Z.jsonl",
    );
    const journalRows = readFixtureJsonl("catalog/journal/2026-08-01T00-00-00Z.jsonl");
    const runRows = readFixtureJsonl("catalog/machines/machine-alpha/runs/2026-08-01T00-00-00Z.jsonl");
    for (const row of [...snapshotRows, ...journalRows, ...runRows]) {
      expect(row).toHaveProperty("schema_version");
      expect(typeof (row as { schema_version: unknown }).schema_version).toBe("number");
    }
  });

  it("schema_version 누락 시 parse가 실패한다", () => {
    const raw = readFixtureJson("catalog/catalog/assets/plugin/demo-plugin/asset.json") as Record<
      string,
      unknown
    >;
    const { schema_version: _drop, ...withoutVersion } = raw;
    expect(() => AssetSchema.parse(withoutVersion)).toThrow();
  });

  it("Annotation/DocPage — 유효한 합성 레코드가 통과한다", () => {
    const annotation = {
      schema_version: 1,
      _scope: "machine_independent",
      asset_id: "demo-plugin@demo-marketplace",
      role: "합성 데모",
      purpose: "테스트",
      when_to_use: "테스트할 때",
      gen_mode: "rule_extract",
      generated_at: "2026-08-01T00:00:00.000Z",
    };
    expect(() => AnnotationSchema.parse(annotation)).not.toThrow();

    const docPage = {
      schema_version: 1,
      _scope: "machine_independent",
      asset_id: "demo-plugin@demo-marketplace",
      catalog_relative_path: "assets/plugin/demo-plugin/usage.md",
      title: "demo-plugin 사용법",
      body: "합성 본문",
      citations: [],
      gen_mode: "rule_extract",
      generated_at: "2026-08-01T00:00:00.000Z",
    };
    expect(() => DocPageSchema.parse(docPage)).not.toThrow();
  });

  it("미지의 키가 섞이면 strict 스키마가 실패한다 (R13)", () => {
    const raw = readFixtureJson("catalog/catalog/assets/plugin/demo-plugin/asset.json") as Record<
      string,
      unknown
    >;
    const withExtraKey = { ...raw, unexpected_future_field: "drift" };
    expect(() => AssetSchema.parse(withExtraKey)).toThrow();
  });
});

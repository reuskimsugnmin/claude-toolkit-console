import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Asset, Installation, Machine, RunLogEntry } from "@ctk/core";
import { ensureGitRepo, commitAll } from "../src/local-git-repo.js";
import { writeSnapshot } from "../src/snapshot-store.js";
import { writeRunLog } from "../src/run-log-store.js";
import { upsertAsset, rebuildCatalogIndex } from "../src/asset-store.js";
import { ensureMachine } from "../src/machine-store.js";
import { writeCatalogConfig, readCatalogConfig } from "../src/catalog-config-store.js";

const sampleAsset: Asset = {
  schema_version: 1,
  _scope: "machine_independent",
  id: "demo@mp",
  kind: "plugin",
  name: "demo",
  marketplace: "mp",
};

const sampleInstallation: Installation = {
  schema_version: 1,
  _scope: "machine_dependent",
  asset_id: "demo@mp",
  machine_id: "m1",
  install_scope: "user",
  enabled_at: "user",
  project_path_hash: null,
  mcp_enabled_state: null,
  mcp_state_source: null,
};

const sampleMachine: Machine = {
  schema_version: 1,
  _scope: "machine_dependent",
  id: "m1",
  alias: "test-machine",
  first_seen_at: "2026-08-20T00:00:00.000Z",
};

describe("sync stores — 카탈로그 저장소 쓰기 (Step 2)", () => {
  let catalogRoot: string;
  beforeEach(() => {
    catalogRoot = mkdtempSync(path.join(tmpdir(), "ctk-sync-store-test-"));
  });
  afterEach(() => {
    rmSync(catalogRoot, { recursive: true, force: true });
  });

  it("local-git-repo — ensureGitRepo는 원격을 구성하지 않고 .git만 만든다(OQ-1 안 C)", () => {
    ensureGitRepo(catalogRoot);
    expect(existsSync(path.join(catalogRoot, ".git"))).toBe(true);
    // 재호출해도 에러 없이 그대로 둔다(idempotent).
    expect(() => ensureGitRepo(catalogRoot)).not.toThrow();
  });

  it("snapshot-store — Installation을 append하고 콜론 없는 파일명으로 저장한다", () => {
    ensureGitRepo(catalogRoot);
    const { path: snapshotAbsPath } = writeSnapshot(catalogRoot, "m1", "2026-08-20T05:00:00.000Z", [
      sampleInstallation,
    ]);
    expect(path.basename(snapshotAbsPath)).toBe("2026-08-20T05-00-00.000Z.jsonl");
    const content = readFileSync(snapshotAbsPath, "utf8").trim();
    expect(JSON.parse(content)).toMatchObject({ asset_id: "demo@mp" });
  });

  it("run-log-store — RunLogEntry를 1파일 1레코드로 저장한다", () => {
    ensureGitRepo(catalogRoot);
    const entry: RunLogEntry = {
      schema_version: 1,
      _scope: "machine_dependent",
      command: "scan",
      args: {},
      machine_id: "m1",
      started_at: "2026-08-20T05:00:00.000Z",
      finished_at: "2026-08-20T05:00:05.000Z",
      exit_code: 0,
      failure_class: null,
    };
    const { path: runLogAbsPath } = writeRunLog(catalogRoot, entry);
    expect(existsSync(runLogAbsPath)).toBe(true);
    expect(JSON.parse(readFileSync(runLogAbsPath, "utf8").trim())).toMatchObject({ command: "scan", exit_code: 0 });
  });

  it("asset-store — upsertAsset 후 rebuildCatalogIndex가 index.json을 재계산한다", () => {
    ensureGitRepo(catalogRoot);
    upsertAsset(catalogRoot, sampleAsset);
    const { index } = rebuildCatalogIndex(catalogRoot);
    expect(index.assets).toEqual([{ id: "demo@mp", kind: "plugin", name: "demo" }]);
    // 덮어쓰기 — 같은 자산을 다시 upsert해도 index는 중복 없이 1건.
    upsertAsset(catalogRoot, sampleAsset);
    expect(rebuildCatalogIndex(catalogRoot).index.assets).toHaveLength(1);
  });

  it("machine-store — ensureMachine은 최초 1회만 쓰고 이후엔 덮어쓰지 않는다", () => {
    ensureGitRepo(catalogRoot);
    const first = ensureMachine(catalogRoot, sampleMachine);
    expect(first.created).toBe(true);
    const second = ensureMachine(catalogRoot, { ...sampleMachine, alias: "renamed" });
    expect(second.created).toBe(false);
    const content = JSON.parse(readFileSync(first.path, "utf8")) as Machine;
    expect(content.alias).toBe("test-machine"); // 덮어쓰이지 않음
  });

  it("catalog-config-store — write 후 read로 왕복되고 catalog_path 필드가 없다", () => {
    ensureGitRepo(catalogRoot);
    writeCatalogConfig(catalogRoot, {
      schema_version: 1,
      verified_cli_version: "2.1.237 (Claude Code)",
      offset_cache_location: "catalog",
    });
    const readBack = readCatalogConfig(catalogRoot);
    expect(readBack?.verified_cli_version).toBe("2.1.237 (Claude Code)");
    expect("catalog_path" in (readBack ?? {})).toBe(false);
  });

  it("local-git-repo — commitAll은 변경사항이 있을 때만 커밋한다(빈 커밋 없음)", () => {
    ensureGitRepo(catalogRoot);
    upsertAsset(catalogRoot, sampleAsset);
    const first = commitAll(catalogRoot, "first commit");
    expect(first.committed).toBe(true);
    const second = commitAll(catalogRoot, "nothing changed");
    expect(second.committed).toBe(false);
  });

  it("경로 원문이 섞인 레코드는 위생 검사에서 거부된다(AC-1.7, 마지막 방어선)", () => {
    ensureGitRepo(catalogRoot);
    const leaking: Installation = { ...sampleInstallation, project_path_hash: "/Users/someone/leaked-path" };
    expect(() => writeSnapshot(catalogRoot, "m1", "2026-08-20T05:00:00.000Z", [leaking])).toThrow();
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CatalogIndexSchema,
  parseCatalogIndex,
  readCatalogIndex,
  readCatalogIndexOrNull,
  rebuildCatalogIndex,
  type CatalogIndexEntry,
} from "../src/asset-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const LEGACY_INDEX_PATH = path.join(REPO_ROOT, "fixtures", "catalog-legacy", "catalog", "index.json");

/**
 * sync/test/catalog-index-schema.test.ts — B1 Step 3.
 *
 * AC-7이 요구하는 "실제 파서"를 검증한다 — `CatalogIndexEntry`는 이전에 zod가 아닌 평범한
 * 인터페이스였고 읽는 두 곳(`readExistingIndexOrNull`, `cli/commands/move.ts`)이 전부 `as`
 * 캐스팅이었다. 여기서는 `as T` 없이 `parseCatalogIndex`를 직접 통과시킨다.
 *
 * 픽스처는 `fixtures/catalog-legacy/catalog/index.json` — 현행 `fixtures/catalog`의 1행짜리
 * 인덱스로는 판정이 낼 수 있는 값 전체(6 kind × 부모 유무 × gen_state 4값)를 못 담는다.
 */
describe("sync/asset-store — CatalogIndexSchema/parseCatalogIndex(B1 Step 3, AC-7)", () => {
  it("AC-7-a — 옛(부모 유무가 섞인) index.json이 parseCatalogIndex를 그대로 통과한다", () => {
    const raw: unknown = JSON.parse(readFileSync(LEGACY_INDEX_PATH, "utf8"));
    const index = parseCatalogIndex(raw);
    expect(index.assets.length).toBeGreaterThan(0);
  });

  it("AC-7-a — parent_asset_id가 없던 행은 parseCatalogIndex 후에도 undefined다(조용한 기본값 없음)", () => {
    const raw: unknown = JSON.parse(readFileSync(LEGACY_INDEX_PATH, "utf8"));
    const index = parseCatalogIndex(raw);
    const cliEntry = index.assets.find((e) => e.id === "demo-cli-tool");
    expect(cliEntry).toBeDefined();
    expect(cliEntry?.parent_asset_id).toBeUndefined();
    // gen_state조차 없던 완전히 옛 행 — undefined로 남아야 한다(빈 문자열·null로 뭉개지지 않음).
    expect(cliEntry?.gen_state).toBeUndefined();
  });

  it("AC-7-c(부재 주입) — parent_asset_id 부재 행이 다른 값으로 조용히 삼켜지지 않는다", () => {
    const raw: unknown = JSON.parse(readFileSync(LEGACY_INDEX_PATH, "utf8"));
    const index = parseCatalogIndex(raw);
    const mcpEntry = index.assets.find((e) => e.id === "demo-mcp-server");
    expect(mcpEntry).toBeDefined();
    // undefined는 "" 도 null도 아니다 — in 연산자로 필드 부재 자체를 확인한다.
    expect("parent_asset_id" in (mcpEntry as CatalogIndexEntry)).toBe(false);
  });

  it("픽스처가 6 kind 전체를 담는다(판정이 낼 수 있는 값 전체)", () => {
    const raw: unknown = JSON.parse(readFileSync(LEGACY_INDEX_PATH, "utf8"));
    const index = parseCatalogIndex(raw);
    const kinds = new Set(index.assets.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["plugin", "skill", "mcp", "cli", "agent", "command"]));
  });

  it("픽스처가 gen_state 4값 전체 + 부재를 담는다", () => {
    const raw: unknown = JSON.parse(readFileSync(LEGACY_INDEX_PATH, "utf8"));
    const index = parseCatalogIndex(raw);
    const states = new Set(index.assets.map((e) => e.gen_state ?? "(absent)"));
    expect(states).toEqual(new Set(["fresh", "pending", "stale", "policy_blocked", "(absent)"]));
  });

  it("픽스처가 parent_asset_id 유무를 둘 다 담는다", () => {
    const raw: unknown = JSON.parse(readFileSync(LEGACY_INDEX_PATH, "utf8"));
    const index = parseCatalogIndex(raw);
    const withParent = index.assets.filter((e) => e.parent_asset_id !== undefined);
    const withoutParent = index.assets.filter((e) => e.parent_asset_id === undefined);
    expect(withParent.length).toBeGreaterThan(0);
    expect(withoutParent.length).toBeGreaterThan(0);
  });

  it("미지의 키가 섞이면 strict 스키마가 실패한다(R13과 같은 형태)", () => {
    const raw: unknown = JSON.parse(readFileSync(LEGACY_INDEX_PATH, "utf8"));
    const parsed = parseCatalogIndex(raw);
    const withExtraKey = { ...parsed, assets: [{ ...parsed.assets[0], unexpected_future_field: "drift" }] };
    expect(() => CatalogIndexSchema.parse(withExtraKey)).toThrow();
  });
});

describe("sync/asset-store — 열화 구분: '없음' vs '실패'(안전 원칙 7)", () => {
  let catalogRoot: string;
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "ctk-catalog-index-degrade-"));
    catalogRoot = path.join(workDir, "catalog-root");
    mkdirSync(path.join(catalogRoot, "catalog"), { recursive: true });
  });

  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  it("인덱스 파일이 아예 없으면 '없음' — corrupted: false", () => {
    const result = readCatalogIndexOrNull(catalogRoot);
    expect(result).toEqual({ index: null, corrupted: false });
  });

  it("인덱스가 JSON조차 아니면 '실패'로 열화하되 반환값에 corrupted: true를 싣는다(조용한 null 아님)", () => {
    writeFileSync(path.join(catalogRoot, "catalog", "index.json"), "{ this is not json", "utf8");
    const result = readCatalogIndexOrNull(catalogRoot);
    expect(result.index).toBeNull();
    expect(result.corrupted).toBe(true);
  });

  it("인덱스가 유효한 JSON이지만 스키마를 어기면(필수 id 없음) '실패'로 열화하고 corrupted: true를 싣는다", () => {
    writeFileSync(
      path.join(catalogRoot, "catalog", "index.json"),
      JSON.stringify({ schema_version: 1, assets: [{ kind: "skill", name: "x" }] }),
      "utf8",
    );
    const result = readCatalogIndexOrNull(catalogRoot);
    expect(result.index).toBeNull();
    expect(result.corrupted).toBe(true);
  });

  it("손상된 인덱스가 있어도 rebuildCatalogIndex는 죽지 않는다(안전 원칙 6 — 탈출구 없는 fail-closed 금지)", () => {
    writeFileSync(path.join(catalogRoot, "catalog", "index.json"), "{ broken", "utf8");
    mkdirSync(path.join(catalogRoot, "catalog", "assets", "skill", "ok__deadbeef"), { recursive: true });
    writeFileSync(
      path.join(catalogRoot, "catalog", "assets", "skill", "ok__deadbeef", "asset.json"),
      JSON.stringify({ schema_version: 1, _scope: "machine_independent", id: "ok", kind: "skill", name: "ok" }),
      "utf8",
    );
    expect(() => rebuildCatalogIndex(catalogRoot)).not.toThrow();
    const rebuilt = readCatalogIndex(catalogRoot);
    expect(rebuilt.assets).toHaveLength(1);
    expect(rebuilt.assets[0]?.id).toBe("ok");
  });

  // ⚠️ 배선 테스트 — `corrupted`를 만들어 두고 아무도 읽지 않으면 방어가 아니다(안전 원칙 5).
  // 열화 사실이 `rebuildCatalogIndex`의 반환값까지 **실제로 실려 나오는지**를 태운다.
  it("손상된 인덱스는 rebuildCatalogIndex 반환값에 priorIndexCorrupted: true로 실려 나온다", () => {
    writeFileSync(path.join(catalogRoot, "catalog", "index.json"), "{ broken", "utf8");
    mkdirSync(path.join(catalogRoot, "catalog", "assets", "skill", "ok__deadbeef"), { recursive: true });
    writeFileSync(
      path.join(catalogRoot, "catalog", "assets", "skill", "ok__deadbeef", "asset.json"),
      JSON.stringify({ schema_version: 1, _scope: "machine_independent", id: "ok", kind: "skill", name: "ok" }),
      "utf8",
    );
    expect(rebuildCatalogIndex(catalogRoot).priorIndexCorrupted).toBe(true);
  });

  // 반대 축 — 이 arm이 없으면 "항상 true를 돌려주는" 구현도 위 테스트를 통과한다.
  it("정상 인덱스에서는 priorIndexCorrupted가 false이고 건너뛴 자산 파일도 없다", () => {
    mkdirSync(path.join(catalogRoot, "catalog", "assets", "skill", "ok__deadbeef"), { recursive: true });
    writeFileSync(
      path.join(catalogRoot, "catalog", "assets", "skill", "ok__deadbeef", "asset.json"),
      JSON.stringify({ schema_version: 1, _scope: "machine_independent", id: "ok", kind: "skill", name: "ok" }),
      "utf8",
    );
    rebuildCatalogIndex(catalogRoot); // 인덱스를 정상 생성
    const again = rebuildCatalogIndex(catalogRoot);
    expect(again.priorIndexCorrupted).toBe(false);
    expect(again.unparseableAssetFiles).toEqual([]);
  });

  it("파싱 못 하는 asset.json은 인덱스에서 빠지되 조용히 사라지지 않고 목록으로 보고된다", () => {
    const bad = path.join(catalogRoot, "catalog", "assets", "skill", "bad__deadbeef");
    const good = path.join(catalogRoot, "catalog", "assets", "skill", "ok__cafebabe");
    mkdirSync(bad, { recursive: true });
    mkdirSync(good, { recursive: true });
    // `kind`가 유니온에 없는 값 — JSON으로는 멀쩡하지만 실제 파서는 거부해야 한다.
    writeFileSync(
      path.join(bad, "asset.json"),
      JSON.stringify({ schema_version: 1, _scope: "machine_independent", id: "bad", kind: "nope", name: "bad" }),
      "utf8",
    );
    writeFileSync(
      path.join(good, "asset.json"),
      JSON.stringify({ schema_version: 1, _scope: "machine_independent", id: "ok", kind: "skill", name: "ok" }),
      "utf8",
    );

    const result = rebuildCatalogIndex(catalogRoot);
    expect(result.index.assets.map((e) => e.id)).toEqual(["ok"]); // 깨진 것은 인덱스에서 빠진다
    expect(result.unparseableAssetFiles).toHaveLength(1); // 그러나 "없음"이 아니라 "실패"로 보고된다
    expect(result.unparseableAssetFiles[0]).toContain("bad__deadbeef");
  });

  it("rebuildCatalogIndex는 asset.json의 parent_asset_id를 인덱스 행에 반영한다", () => {
    mkdirSync(path.join(catalogRoot, "catalog", "assets", "agent", "child__aaaa1111"), { recursive: true });
    writeFileSync(
      path.join(catalogRoot, "catalog", "assets", "agent", "child__aaaa1111", "asset.json"),
      JSON.stringify({
        schema_version: 1,
        _scope: "machine_independent",
        id: "parent@mp:child",
        kind: "agent",
        name: "child",
        parent_asset_id: "parent@mp",
      }),
      "utf8",
    );
    const { index } = rebuildCatalogIndex(catalogRoot);
    const entry = index.assets.find((e) => e.id === "parent@mp:child");
    expect(entry?.parent_asset_id).toBe("parent@mp");
  });
});

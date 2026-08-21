import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Asset } from "@ctk/core";
import { PathTraversalDetectedError, upsertAsset } from "../src/asset-store.js";

/**
 * sync/test/asset-store-path-traversal.test.ts — H2 회귀 방지(Step 5 e2e에서 발견).
 * `asset.name`/`asset.kind`는 서드파티 자산 저자가 쓰는 값(예: SKILL.md frontmatter `name`)이고
 * probe는 이를 검증 없이 그대로 넘긴다 — `assetJsonPath(kind, name)`이 문자열 보간으로
 * 경로를 만들므로, 검증 없이 쓰면 `../../evil` 같은 값이 카탈로그 루트 밖에 파일을 쓸 수 있었다.
 */
describe("sync/asset-store — upsertAsset 경로 순회 방어(H2)", () => {
  let catalogRoot: string;
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "ctk-asset-traversal-"));
    catalogRoot = path.join(workDir, "catalog-root");
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  function assetWith(overrides: Partial<Asset>): Asset {
    return {
      schema_version: 1,
      _scope: "machine_independent",
      id: "evil",
      kind: "skill",
      name: "evil",
      ...overrides,
    };
  }

  it("name에 경로 순회 문자열이 있으면 PathTraversalDetectedError를 던지고 아무 것도 쓰지 않는다", () => {
    const malicious = assetWith({ id: "../../evil", name: "../../evil" });
    expect(() => upsertAsset(catalogRoot, malicious)).toThrow(PathTraversalDetectedError);
    // 카탈로그 루트 밖(workDir 바로 아래)에 "evil"이라는 흔적이 전혀 생기지 않았다.
    expect(existsSync(path.join(workDir, "evil"))).toBe(false);
  });

  it("name에 단일 '/'만 있어도(비-'..' 순회 없이) 거부한다 — 세그먼트 구조를 벗어날 수 없다", () => {
    const malicious = assetWith({ id: "a/b", name: "a/b" });
    expect(() => upsertAsset(catalogRoot, malicious)).toThrow(PathTraversalDetectedError);
  });

  it("정상적인 name은 그대로 통과한다(오탐 없음)", () => {
    const normal = assetWith({ id: "demo-skill", name: "demo-skill" });
    const result = upsertAsset(catalogRoot, normal);
    expect(existsSync(result.path)).toBe(true);
  });
});

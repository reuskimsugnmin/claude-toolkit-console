import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { annotationMdPath, assetPathSegment, occupancyJsonPath, usageMdPath } from "@ctk/core";
import { DirtyCatalogRepoError, migrateCatalogPaths } from "../src/migrate-catalog-paths.js";

/**
 * sync/test/migrate-catalog-paths.test.ts — B1 Step 1 이전기.
 *
 * 함정: 플러그인 축에서는 오늘 이름 충돌이 0건이라, 이전기가 아무 일도 안 해도 이 머신에서는
 * 조용히 통과한다. 그래서 **구 레이아웃을 합성으로 주입**하고, 이전기를 끈 채로 새 경로
 * 빌더가 실제로 못 찾는다는 것부터 실증한다(회귀 부재 주입 — 이 arm이 없으면 이전기가 무동작
 * 이어도 나머지 테스트가 통과한다).
 */

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 실패: ${result.stderr}`);
  }
}

function initCommittedGitRepo(catalogRoot: string): void {
  runGit(catalogRoot, ["init"]);
  runGit(catalogRoot, ["add", "-A"]);
  runGit(catalogRoot, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
}

interface OldLayoutContents {
  annotation?: string;
  usage?: string;
  occupancy?: Record<string, unknown>;
}

/** 구 레이아웃(`catalog/assets/<kind>/<name>/`, 해시 접미사 없음)으로 자산 디렉터리를 만든다. */
function writeOldLayoutAsset(
  catalogRoot: string,
  kind: string,
  name: string,
  id: string,
  contents: OldLayoutContents = {},
): string {
  const dir = path.join(catalogRoot, "catalog", "assets", kind, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "asset.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        _scope: "machine_independent",
        id,
        kind,
        name,
        ...(kind === "plugin" ? { marketplace: "mp" } : {}),
      },
      null,
      2,
    )}\n`,
  );
  if (contents.annotation !== undefined) writeFileSync(path.join(dir, "annotation.md"), contents.annotation);
  if (contents.usage !== undefined) writeFileSync(path.join(dir, "usage.md"), contents.usage);
  if (contents.occupancy !== undefined) {
    writeFileSync(path.join(dir, "occupancy.json"), `${JSON.stringify(contents.occupancy, null, 2)}\n`);
  }
  return dir;
}

/** 이미 새 레이아웃(`<name>__<hash8>`)으로 자산 디렉터리를 만든다 — "이미 이전됨" 픽스처용. */
function writeNewLayoutAsset(catalogRoot: string, kind: string, name: string, id: string): string {
  const segment = assetPathSegment(name, id);
  const dir = path.join(catalogRoot, "catalog", "assets", kind, segment);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "asset.json"),
    `${JSON.stringify({ schema_version: 1, _scope: "machine_independent", id, kind, name }, null, 2)}\n`,
  );
  return dir;
}

describe("sync/migrate-catalog-paths — 구 레이아웃 → id 파생 경로 이전(B1 Step 1)", () => {
  let catalogRoot: string;
  beforeEach(() => {
    catalogRoot = mkdtempSync(path.join(tmpdir(), "ctk-migrate-test-"));
  });
  afterEach(() => {
    rmSync(catalogRoot, { recursive: true, force: true });
  });

  it(
    "회귀(부재 주입) — 이전기를 돌리지 않으면 새 경로 빌더는 구 레이아웃 문서를 못 찾는다 " +
      "(이전기 없이는 실제로 깨진다는 것을 실증)",
    () => {
      const id = "demo-skill@demo-plugin";
      writeOldLayoutAsset(catalogRoot, "skill", "demo-skill", id, {
        annotation: "# annotation\n",
        usage: "# usage\n",
      });

      // 이전기를 부르지 않았다 — 새 경로 빌더(id 축)로 찾으면 구 레이아웃 문서는 안 보인다.
      expect(existsSync(path.join(catalogRoot, annotationMdPath("skill", "demo-skill", id)))).toBe(false);
      expect(existsSync(path.join(catalogRoot, usageMdPath("skill", "demo-skill", id)))).toBe(false);
    },
  );

  it("이전 보존 — annotation.md·usage.md·occupancy.json이 새 경로에 내용 그대로(sha 동일) 남는다", () => {
    const id = "demo-skill@demo-plugin";
    const annotationContent = "# annotation content\nrole: 테스트\n";
    const usageContent = "# usage content\n본문\n";
    const occupancyContent = { schema_version: 1, _scope: "machine_independent", asset_id: id };
    writeOldLayoutAsset(catalogRoot, "skill", "demo-skill", id, {
      annotation: annotationContent,
      usage: usageContent,
      occupancy: occupancyContent,
    });

    const result = migrateCatalogPaths(catalogRoot);
    expect(result.dryRun).toBe(false);
    expect(result.moved).toHaveLength(1);
    expect(result.moved[0]?.id).toBe(id);

    const newAnnotationAbs = path.join(catalogRoot, annotationMdPath("skill", "demo-skill", id));
    const newUsageAbs = path.join(catalogRoot, usageMdPath("skill", "demo-skill", id));
    const newOccupancyAbs = path.join(catalogRoot, occupancyJsonPath("skill", "demo-skill", id));

    expect(existsSync(newAnnotationAbs)).toBe(true);
    expect(existsSync(newUsageAbs)).toBe(true);
    expect(existsSync(newOccupancyAbs)).toBe(true);

    expect(sha256(readFileSync(newAnnotationAbs, "utf8"))).toBe(sha256(annotationContent));
    expect(sha256(readFileSync(newUsageAbs, "utf8"))).toBe(sha256(usageContent));
    expect(JSON.parse(readFileSync(newOccupancyAbs, "utf8"))).toEqual(occupancyContent);
  });

  it("멱등 — 2회 실행하면 2회차는 이동 0건이고 결과가 동일하다", () => {
    const id = "demo-skill@demo-plugin";
    writeOldLayoutAsset(catalogRoot, "skill", "demo-skill", id, { annotation: "a" });

    const first = migrateCatalogPaths(catalogRoot);
    expect(first.moved).toHaveLength(1);

    const second = migrateCatalogPaths(catalogRoot);
    expect(second.moved).toHaveLength(0);
    expect(second.skippedCount).toBe(1);
  });

  it("dry-run — 실제로 옮기지 않고 이동 계획만 보고한다", () => {
    const id = "demo-skill@demo-plugin";
    const oldDir = writeOldLayoutAsset(catalogRoot, "skill", "demo-skill", id, { annotation: "a" });

    const result = migrateCatalogPaths(catalogRoot, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.moved).toHaveLength(1);

    // 실제로는 옮기지 않았다 — 구 경로가 그대로 있고 새 경로는 아직 없다.
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(path.join(catalogRoot, annotationMdPath("skill", "demo-skill", id)))).toBe(false);
  });

  it(
    "더러운 트리 거부 — 옮길 대상이 있는데 git 트리가 더러우면 DirtyCatalogRepoError를 던지고 " +
      "아무 것도 옮기지 않는다(되돌릴 길이 없으므로)",
    () => {
      const id = "demo-skill@demo-plugin";
      const oldDir = writeOldLayoutAsset(catalogRoot, "skill", "demo-skill", id, { annotation: "a" });
      initCommittedGitRepo(catalogRoot);
      // 트리를 더럽힌다 — 추적되지 않는 새 파일.
      writeFileSync(path.join(catalogRoot, "dirty.txt"), "uncommitted");

      expect(() => migrateCatalogPaths(catalogRoot)).toThrow(DirtyCatalogRepoError);
      expect(existsSync(oldDir)).toBe(true); // 아무 것도 옮기지 않았다
    },
  );

  it("dry-run은 트리가 더러워도 거부하지 않는다(아무 것도 쓰지 않으므로)", () => {
    const id = "demo-skill@demo-plugin";
    writeOldLayoutAsset(catalogRoot, "skill", "demo-skill", id, { annotation: "a" });
    initCommittedGitRepo(catalogRoot);
    writeFileSync(path.join(catalogRoot, "dirty.txt"), "uncommitted");

    expect(() => migrateCatalogPaths(catalogRoot, { dryRun: true })).not.toThrow();
  });

  it(
    "옮길 대상이 없으면 트리가 더러워도 통과한다 — 이미 끝난 이전 때문에 평소 ctk scan까지 " +
      "막으면 안 된다",
    () => {
      const id = "demo-skill@demo-plugin";
      writeNewLayoutAsset(catalogRoot, "skill", "demo-skill", id); // 이미 새 레이아웃
      initCommittedGitRepo(catalogRoot);
      writeFileSync(path.join(catalogRoot, "dirty.txt"), "uncommitted");

      const result = migrateCatalogPaths(catalogRoot);
      expect(result.moved).toHaveLength(0);
      expect(result.skippedCount).toBe(1);
    },
  );
});

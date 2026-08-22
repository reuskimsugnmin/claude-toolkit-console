import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Asset } from "@ctk/core";
import type { HomeContext } from "@ctk/probe";
import { ensureGitRepo, readCatalogIndex, rebuildCatalogIndex, upsertAsset } from "@ctk/sync";
import { assertOutputFieldsClean, InjectionPatternDetectedError } from "../src/output-verify.js";
import { ruleExtract } from "../src/rule-extract.js";
import { runGen } from "../src/index.js";

/**
 * AC-3.9 (iter 8 · B1-6 · R18) — 프롬프트 인젝션 부정 단언.
 *
 * ⚠️ P5(인용 강제)·AC-3.4·AC-3.6은 이 AC를 대체하지 않는다 — 공격 문자열은 원문에 실재하므로
 * 인용이 정당하게 붙어 그 셋을 전부 통과한다. 이 테스트는 그것과 **무관하게** 별도로
 * `output-verify.ts`(4규칙)가 ⓐ~ⓔ 전부를 검출하고 `sync` 쓰기 이전에 거부하는지만 본다.
 *
 * `--no-llm`(rule_extract) 경로로 검증한다 — M3: "LLM을 안 쓰니 안전하다"는 틀렸다. 규칙 기반
 * 추출은 원문을 축자 그대로 옮기므로 인젝션 문자열이 오히려 더 잘 보존된다. 이 경로가 막히면
 * LLM 경로(동일한 output-verify 함수를 거친다, gen/src/index.ts)도 같은 이유로 막힌다 —
 * `index.test.ts`의 "인젝션 패턴이 검출되면..." 테스트가 LLM 경로 쪽을 별도로 확인한다.
 */

const FIXTURES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "malicious");

const MALICIOUS_CASES = [
  { dir: "ignore-previous", label: "ⓐ ignore previous instructions" },
  { dir: "system-tag", label: "ⓑ <system> 유사 태그" },
  { dir: "delimiter-escape", label: "ⓒ 구획자 탈출 시도" },
  { dir: "exec-command", label: "ⓓ 실행 가능 명령(curl|sh)" },
  { dir: "outside-whitelist-url", label: "ⓔ 화이트리스트 밖 URL + 지시" },
] as const;

function readFixture(caseDir: string): string {
  return readFileSync(path.join(FIXTURES_ROOT, caseDir, "SKILL.md"), "utf8");
}

describe("AC-3.9 — 악성 픽스처 5종에 대한 프롬프트 인젝션 부정 단언", () => {
  it.each(MALICIOUS_CASES)("$label — output-verify가 injection_pattern_detected로 거부한다(rule_extract 경로)", ({ dir }) => {
    const asset: Asset = {
      schema_version: 1,
      _scope: "machine_independent",
      id: `malicious-${dir}`,
      kind: "skill",
      name: `malicious-${dir}`,
      source_ref: `skills/malicious-${dir}`,
    };
    const content = readFixture(dir);
    const { annotation, docPage } = ruleExtract(asset, [{ label: "SKILL.md", content }]);

    expect(() =>
      assertOutputFieldsClean(asset.id, {
        role: annotation.role,
        purpose: annotation.purpose,
        when_to_use: annotation.when_to_use,
        usage_title: docPage.title,
        usage_body: docPage.body,
      }),
    ).toThrow(InjectionPatternDetectedError);
  });

  it("정상 픽스처(악성 아님)는 output-verify를 통과한다 — 대조군(오탐 없음 확인)", () => {
    const asset: Asset = {
      schema_version: 1,
      _scope: "machine_independent",
      id: "benign-skill",
      kind: "skill",
      name: "benign-skill",
      source_ref: "skills/benign-skill",
    };
    const content = "---\nname: benign-skill\ndescription: PDF를 마크다운으로 바꾼다\n---\n\n## 사용법\n\n일반적인 설명입니다.\n";
    const { annotation, docPage } = ruleExtract(asset, [{ label: "SKILL.md", content }]);
    expect(() =>
      assertOutputFieldsClean(asset.id, {
        role: annotation.role,
        purpose: annotation.purpose,
        when_to_use: annotation.when_to_use,
        usage_title: docPage.title,
        usage_body: docPage.body,
      }),
    ).not.toThrow();
  });

  describe("전체 파이프라인(runGen --no-llm) — sync 쓰기 이전에 거부되고 자산이 stale로 남는다", () => {
    let ctkHome: string;
    let catalogRoot: string;
    let home: HomeContext;

    afterEach(() => {
      if (ctkHome) rmSync(ctkHome, { recursive: true, force: true });
      if (catalogRoot) rmSync(catalogRoot, { recursive: true, force: true });
    });

    it.each(MALICIOUS_CASES)("$label — usage.md가 카탈로그에 커밋되지 않고 gen_state가 stale로 남는다", async ({ dir }) => {
      ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-ac39-home-"));
      catalogRoot = mkdtempSync(path.join(tmpdir(), "ctk-ac39-catalog-"));
      home = { ctkHome, ctkConfigDir: path.join(ctkHome, ".claude"), configDirExplicit: true };
      const assetId = `malicious-${dir}`;
      const skillDir = path.join(home.ctkConfigDir, "skills", assetId);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), readFixture(dir));

      ensureGitRepo(catalogRoot);
      const asset: Asset = { schema_version: 1, _scope: "machine_independent", id: assetId, kind: "skill", name: assetId };
      upsertAsset(catalogRoot, asset);
      rebuildCatalogIndex(catalogRoot);

      const summary = await runGen({
        home,
        catalogRoot,
        assets: [asset],
        maxBudgetUsd: 0.2,
        timeoutSec: 30,
        noLlm: true, // claude를 전혀 spawn하지 않는다 — 비용 0.
        verifiedCliVersion: "2.1.238",
        sealedCwd: home.ctkHome, // no-llm 경로에서는 쓰이지 않는다.
        interactive: true,
        allowManagedPolicy: false,
      });

      expect(summary.results).toEqual([{ assetId, outcome: "stale", reason: "injection_pattern_detected" }]);
      expect(summary.injectionFindingsTotal.directive + summary.injectionFindingsTotal.executable + summary.injectionFindingsTotal.url).toBeGreaterThan(0);

      const index = readCatalogIndex(catalogRoot);
      expect(index.assets.find((e) => e.id === assetId)?.gen_state).toBe("stale");
      expect(() => readFileSync(path.join(catalogRoot, "catalog", "assets", "skill", assetId, "usage.md"), "utf8")).toThrow();
      expect(() => readFileSync(path.join(catalogRoot, "catalog", "assets", "skill", assetId, "annotation.md"), "utf8")).toThrow();
    });
  });
});

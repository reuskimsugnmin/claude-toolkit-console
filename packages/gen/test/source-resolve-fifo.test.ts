import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseAsset, type Asset } from "@ctk/core";
import type { HomeContext } from "@ctk/probe";

/**
 * gen/test/source-resolve-fifo.test.ts — 원본이 FIFO인 자산은 `source_missing`("드리프트 조사")이 아니라
 * `blocked/asset_source_not_a_file`("일반 파일 아님")이어야 한다(probe가 열지 않고 건너뛰어 후보가 0건이던 결함).
 *
 * ⚠️ 같은 프로세스에서 FIFO를 열면 동기 `readFileSync`가 vitest 워커째 영구 블록되므로(판정이 틀렸을 때
 * 테스트 러너가 멎는다) `probe` FIFO 테스트와 같은 방식으로 **자식 프로세스 + 5초 데드라인**에서 `gen/dist`를
 * 부른다. 이 파일을 손댄 뒤에는 `pnpm build`(= `tsc -b`)로 dist를 최신화해야 실제 변경을 검증한다.
 * 단건 판정(`classifyAssetDocState`)과 일괄 산출(`planGenTargets`)을 같은 자식에서 둘 다 부른다.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const genDistIndex = path.join(repoRoot, "packages", "gen", "dist", "index.js");
const coreDistIndex = path.join(repoRoot, "packages", "core", "dist", "index.js");

const PARENT = "demo-plugin@synth-marketplace";

interface Judged {
  single: { kind: string; failure_class?: string };
  display: { label: string; detail: string; action: string };
}
interface ChildReport {
  judged: Record<string, Judged>;
  targets: string[];
  unresolved: { assetId: string; reason: string }[];
  skipped: { assetId: string; failureClass: string }[];
}

function runInChild(home: HomeContext, assets: Asset[]): { report: ChildReport | null; timedOut: boolean; status: number | null } {
  const script = [
    `import { classifyAssetDocState, planGenTargets } from ${JSON.stringify(pathToFileURL(genDistIndex).href)};`,
    `import { describeAssetDocState } from ${JSON.stringify(pathToFileURL(coreDistIndex).href)};`,
    `const home = ${JSON.stringify(home)};`,
    `const assets = ${JSON.stringify(assets)};`,
    `const judged = {};`,
    `for (const a of assets) { const s = classifyAssetDocState(home, a, undefined); judged[a.id] = { single: s, display: describeAssetDocState(s) }; }`,
    `const plan = planGenTargets({ home, bundledParents: [${JSON.stringify(PARENT)}], assets, index: { schema_version: 1, assets: [] } });`,
    `process.stdout.write(JSON.stringify({ judged, targets: plan.targets.map((t) => t.asset.id), unresolved: plan.unresolved, skipped: plan.skipped }));`,
  ].join("\n");
  const scriptDir = mkdtempSync(path.join(tmpdir(), "ctk-gen-fifo-script-"));
  const scriptPath = path.join(scriptDir, "run.mjs");
  writeFileSync(scriptPath, script, "utf8");
  try {
    const proc = spawnSync(process.execPath, [scriptPath], { timeout: 5000, encoding: "utf8" });
    const report = proc.status === 0 && proc.stdout.length > 0 ? (JSON.parse(proc.stdout) as ChildReport) : null;
    return { report, timedOut: proc.signal !== null, status: proc.status };
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

function standalone(id: string): Asset {
  return parseAsset({ schema_version: 1, _scope: "machine_independent", id, kind: "skill", name: id });
}
function bundled(kind: "skill" | "agent", name: string): Asset {
  return parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: `${PARENT}:${kind}:${name}`,
    kind,
    name,
    parent_asset_id: PARENT,
  });
}

describe("gen/source-resolve — FIFO 원본은 source_missing이 아니라 blocked/asset_source_not_a_file", () => {
  let ctkHome: string;
  let home: HomeContext;
  afterEach(() => rmSync(ctkHome, { recursive: true, force: true }));

  function init(): string {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-gen-fifo-"));
    home = { ctkHome, ctkConfigDir: path.join(ctkHome, ".claude"), configDirExplicit: true };
    mkdirSync(home.ctkConfigDir, { recursive: true });
    const installPath = path.join(home.ctkConfigDir, "plugins", "cache", "synth-marketplace", "demo-plugin", "1.0.0");
    mkdirSync(installPath, { recursive: true });
    const registry = {
      version: 2,
      plugins: {
        [PARENT]: [{ scope: "user", installPath, version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" }],
      },
    };
    mkdirSync(path.join(home.ctkConfigDir, "plugins"), { recursive: true });
    writeFileSync(path.join(home.ctkConfigDir, "plugins", "installed_plugins.json"), JSON.stringify(registry), "utf8");
    return installPath;
  }
  const skillMdDir = (name: string): string => {
    const d = path.join(home.ctkConfigDir, "skills", name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const regularSkill = (dir: string, name: string): void =>
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n\n본문\n`, "utf8");

  function expectBlockedNotAFile(r: ChildReport, id: string): void {
    const j = r.judged[id];
    expect(j?.single, `${id} 단건`).toMatchObject({ kind: "blocked", failure_class: "asset_source_not_a_file" });
    expect(r.skipped.find((s) => s.assetId === id), `${id} 일괄 skipped`).toMatchObject({ failureClass: "asset_source_not_a_file" });
    expect(r.unresolved.find((u) => u.assetId === id), `${id}는 unresolved에 없어야 한다`).toBeUndefined();
    expect(r.targets).not.toContain(id);
    // 화면 문구 — 잘못된 처방("원본 없음 · ctk doctor --drift")이 아니라 "일반 파일 아님".
    expect(j?.display.label).toContain("일반 파일 아님");
    expect(`${j?.display.label} ${j?.display.detail} ${j?.display.action}`).not.toContain("원본 없음");
    expect(j?.display.action).not.toContain("doctor --drift");
  }

  it("FIFO 독립 스킬 · FIFO 번들 스킬 · FIFO 번들 에이전트가 단건·일괄 모두 blocked다(+ 반대 축 대조군)", () => {
    const installPath = init();
    // ① FIFO 독립 스킬
    execFileSync("mkfifo", [path.join(skillMdDir("fifo-skill"), "SKILL.md")]);
    // ② FIFO 번들 스킬
    const bundledSkillDir = path.join(installPath, "skills", "fifo-child");
    mkdirSync(bundledSkillDir, { recursive: true });
    execFileSync("mkfifo", [path.join(bundledSkillDir, "SKILL.md")]);
    // ③ FIFO 번들 에이전트(평면 .md)
    mkdirSync(path.join(installPath, "agents"), { recursive: true });
    execFileSync("mkfifo", [path.join(installPath, "agents", "fifo-agent.md")]);
    // 대조군 — 일반 독립 스킬은 그대로 대상이다.
    regularSkill(skillMdDir("ok-skill"), "ok-skill");
    // 반대 축 — 아예 없는 자산은 여전히 source_missing(드리프트 조사 대상)이다.
    mkdirSync(skillMdDir("gone-skill"), { recursive: true });

    const ids = [
      standalone("fifo-skill"),
      bundled("skill", "fifo-child"),
      bundled("agent", "fifo-agent"),
      standalone("ok-skill"),
      standalone("gone-skill"),
    ];
    const { report, timedOut, status } = runInChild(home, ids);
    expect(timedOut, "FIFO를 열어 영구 블록됐다").toBe(false);
    expect(status).toBe(0);
    expect(report).not.toBeNull();
    const r = report as ChildReport;

    expectBlockedNotAFile(r, "fifo-skill");
    expectBlockedNotAFile(r, `${PARENT}:skill:fifo-child`);
    expectBlockedNotAFile(r, `${PARENT}:agent:fifo-agent`);

    expect(r.targets).toEqual(["ok-skill"]);
    expect(r.judged["ok-skill"]?.single.kind).toBe("pending_generation");
    expect(r.judged["gone-skill"]?.single.kind).toBe("source_missing");
    expect(r.unresolved).toEqual([{ assetId: "gone-skill", reason: "source_missing" }]);
    expect(r.judged["gone-skill"]?.display.label).toBe("원본 없음");
  });

  it("D2 — 같은 id에 일반 원본과 FIFO 원본이 섞이면 blocked다(열 수 없는 사본은 동일성을 증명할 수 없다)", () => {
    const installPath = init();
    // 독립: 같은 id(=디렉터리명 폴백이 아니라 자칭 name `mixed`)의 일반 사본 + 디렉터리명 `mixed`의 FIFO 사본.
    regularSkill(skillMdDir("mixed-a"), "mixed");
    execFileSync("mkfifo", [path.join(skillMdDir("mixed"), "SKILL.md")]);
    // 번들: 일반 에이전트 `mixed-agent`는 하나뿐이라 섞임이 없다 — 번들 skill은 같은 suffix를 일반(자칭)·FIFO(디렉터리명)로 만든다.
    const sk = path.join(installPath, "skills");
    mkdirSync(path.join(sk, "mixed-dir-a"), { recursive: true });
    writeFileSync(path.join(sk, "mixed-dir-a", "SKILL.md"), "---\nname: mixed-child\n---\n\n본문\n", "utf8");
    mkdirSync(path.join(sk, "mixed-child"), { recursive: true });
    execFileSync("mkfifo", [path.join(sk, "mixed-child", "SKILL.md")]);

    const { report, timedOut, status } = runInChild(home, [standalone("mixed"), bundled("skill", "mixed-child")]);
    expect(timedOut).toBe(false);
    expect(status).toBe(0);
    const r = report as ChildReport;
    expectBlockedNotAFile(r, "mixed");
    expectBlockedNotAFile(r, `${PARENT}:skill:mixed-child`);
    expect(r.targets).toEqual([]);
  });
});

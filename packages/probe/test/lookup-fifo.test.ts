import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/lookup-fifo.test.ts — 되찾기 조회(`lookupSkillDirsById` · `findBundledToolPath`)가 FIFO 원본을
 * **열지 않고 세어** 호출자에게 알린다. 예전에는 FIFO가 조용히 버려져 "후보 0건"이 "없음"과 구분되지 않았다.
 * FIFO를 열면 영구 블록되므로 자식 프로세스 + 5초 데드라인(sources-skills-fifo.test.ts와 같은 방식)에서 `dist`를 부른다.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const probeDistIndex = path.join(repoRoot, "packages", "probe", "dist", "index.js");
const PARENT = "demo-plugin@synth-marketplace";

function runChild(home: HomeContext, body: string): { report: unknown; timedOut: boolean; status: number | null } {
  const script = [
    `import * as probe from ${JSON.stringify(pathToFileURL(probeDistIndex).href)};`,
    `const home = ${JSON.stringify(home)};`,
    body,
  ].join("\n");
  const scriptDir = mkdtempSync(path.join(tmpdir(), "ctk-lookup-fifo-script-"));
  const scriptPath = path.join(scriptDir, "run.mjs");
  writeFileSync(scriptPath, script, "utf8");
  try {
    const proc = spawnSync(process.execPath, [scriptPath], { timeout: 5000, encoding: "utf8" });
    const report: unknown = proc.status === 0 && proc.stdout.length > 0 ? JSON.parse(proc.stdout) : null;
    return { report, timedOut: proc.signal !== null, status: proc.status };
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

describe("probe — 되찾기 조회는 일반 파일이 아닌 원본을 열지 않고 센다", () => {
  let ctkHome: string;
  afterEach(() => rmSync(ctkHome, { recursive: true, force: true }));

  function init(): { home: HomeContext; installPath: string } {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-lookup-fifo-"));
    const ctkConfigDir = path.join(ctkHome, ".claude");
    const installPath = path.join(ctkConfigDir, "plugins", "cache", "synth-marketplace", "demo-plugin", "1.0.0");
    mkdirSync(installPath, { recursive: true });
    const registry = {
      version: 2,
      plugins: { [PARENT]: [{ scope: "user", installPath, version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" }] },
    };
    writeFileSync(path.join(ctkConfigDir, "plugins", "installed_plugins.json"), JSON.stringify(registry), "utf8");
    return { home: { ctkHome, ctkConfigDir, configDirExplicit: true }, installPath };
  }

  it("독립 스킬: FIFO SKILL.md는 notRegularCount로 잡히고 래퍼는 found만 돌려준다(반대 축: 일반·무관 id는 0)", () => {
    const { home } = init();
    const skills = path.join(home.ctkConfigDir, "skills");
    mkdirSync(path.join(skills, "fifo-skill"), { recursive: true });
    execFileSync("mkfifo", [path.join(skills, "fifo-skill", "SKILL.md")]);
    mkdirSync(path.join(skills, "ok-skill"), { recursive: true });
    writeFileSync(path.join(skills, "ok-skill", "SKILL.md"), "---\nname: ok-skill\n---\n\n본문\n", "utf8");

    const { report, timedOut, status } = runChild(
      home,
      `process.stdout.write(JSON.stringify({
        fifo: probe.lookupSkillDirsById(home, "fifo-skill"),
        ok: probe.lookupSkillDirsById(home, "ok-skill"),
        none: probe.lookupSkillDirsById(home, "nope"),
        wrapperFifo: probe.findSkillDirsById(home, "fifo-skill").length,
        wrapperOk: probe.findSkillDirsById(home, "ok-skill").length,
      }));`,
    );
    expect(timedOut).toBe(false);
    expect(status).toBe(0);
    const r = report as Record<string, { found: unknown[]; notRegularCount: number } | number>;
    expect(r["fifo"]).toMatchObject({ found: [], notRegularCount: 1 });
    expect(r["ok"]).toMatchObject({ notRegularCount: 0 });
    expect((r["ok"] as { found: unknown[] }).found).toHaveLength(1);
    expect(r["none"]).toEqual({ found: [], notRegularCount: 0 });
    expect(r["wrapperFifo"]).toBe(0);
    expect(r["wrapperOk"]).toBe(1);
  });

  it("독립 스킬: `:`를 담은 FIFO 디렉터리명은 id 후보로 세지 않는다(보안 재심 L-b — 일반 경로의 L-4와 같은 축)", () => {
    const { home } = init();
    const skills = path.join(home.ctkConfigDir, "skills");
    const colonName = "x@m:skill:y";
    mkdirSync(path.join(skills, colonName), { recursive: true });
    execFileSync("mkfifo", [path.join(skills, colonName, "SKILL.md")]);

    const { report, timedOut, status } = runChild(
      home,
      `process.stdout.write(JSON.stringify(probe.lookupSkillDirsById(home, ${JSON.stringify(colonName)})));`,
    );
    expect(timedOut).toBe(false);
    expect(status).toBe(0);
    expect(report).toEqual({ found: [], notRegularCount: 0 });
  });

  it("번들: FIFO 스킬 디렉터리·FIFO 에이전트 파일이 notRegularMatches로 잡힌다(반대 축: 일반·없는 이름은 0)", () => {
    const { home, installPath } = init();
    mkdirSync(path.join(installPath, "skills", "fifo-child"), { recursive: true });
    execFileSync("mkfifo", [path.join(installPath, "skills", "fifo-child", "SKILL.md")]);
    mkdirSync(path.join(installPath, "agents"), { recursive: true });
    execFileSync("mkfifo", [path.join(installPath, "agents", "fifo-agent.md")]);
    writeFileSync(path.join(installPath, "agents", "ok-agent.md"), "---\nname: ok-agent\n---\n\n본문\n", "utf8");

    const { report, timedOut, status } = runChild(
      home,
      `const f = (kind, name) => { const r = probe.findBundledToolPath(home, ${JSON.stringify(PARENT)}, kind, name); return r.ok ? { locations: r.locations.length, notRegularMatches: r.notRegularMatches } : r; };
      process.stdout.write(JSON.stringify({
        skill: f("skill", "fifo-child"), agent: f("agent", "fifo-agent"),
        ok: f("agent", "ok-agent"), none: f("agent", "nope"),
      }));`,
    );
    expect(timedOut).toBe(false);
    expect(status).toBe(0);
    expect(report).toEqual({
      skill: { locations: 0, notRegularMatches: 1 },
      agent: { locations: 0, notRegularMatches: 1 },
      ok: { locations: 1, notRegularMatches: 0 },
      none: { locations: 0, notRegularMatches: 0 },
    });
  });
});

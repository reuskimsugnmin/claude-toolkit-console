import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-skills-fifo.test.ts — 보안 **3차** 심사 M-A 처방 검증.
 *
 * M-1(FIFO 영구 블록)을 처음 고칠 때 **번들 스캐너 둘만 세고 이 세 번째 스캐너를 빠뜨렸다.**
 * 3차 심사가 `EXIT=137`(데드라인에 SIGKILL)로 실증했고, 독립 스킬은 번들보다 **모집단이 더 크다.**
 * 도달 경로는 셋 — `ctk scan`(`collectSkills`) · `ctk gen`(`findSkillDirsById`) ·
 * `ctk web`의 자산 상세 조회(`classifyAssetDocState`). 웹은 동기 읽기 + 단일 이벤트 루프라
 * 요청 하나가 아니라 **서버 전체**가 멈춘다.
 *
 * `sources-bundled-fifo.test.ts`와 같은 방식이다 — 동기 블로킹 `readFileSync`는 같은 프로세스
 * 안에서 시간 제한을 걸 수 없으므로 **별도 프로세스 + `spawnSync`의 `timeout`**으로 하드
 * 데드라인을 건다. 주입 하나에 실행 하나.
 *
 * 자식 프로세스는 `packages/probe/dist`를 직접 부르므로 이 파일을 손댄 뒤에는 `pnpm build`
 * (또는 `pnpm typecheck` — 둘 다 `tsc -b`라 dist를 emit한다)로 dist를 최신화해야 실제 변경을
 * 검증한다.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const probeDistIndex = path.join(repoRoot, "packages", "probe", "dist", "index.js");

function buildHome(): { home: HomeContext; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-skills-fifo-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  mkdirSync(path.join(ctkConfigDir, "skills"), { recursive: true });
  return {
    home: { ctkHome, ctkConfigDir, configDirExplicit: false },
    cleanup: () => rmSync(ctkHome, { recursive: true, force: true }),
  };
}

interface ChildReport {
  assetIds: string[];
}

/** 자식 프로세스에서 `collectSkills`를 1회 호출해 결과를 JSON으로 stdout에 찍고 종료한다. */
function runCollectSkillsInChildProcess(home: HomeContext): {
  report: ChildReport | null;
  timedOut: boolean;
  status: number | null;
} {
  const script = [
    `import { collectSkills } from ${JSON.stringify(pathToFileURL(probeDistIndex).href)};`,
    `const result = collectSkills({ home: ${JSON.stringify(home)}, machineId: "m1" });`,
    `process.stdout.write(JSON.stringify({ assetIds: result.assets.map((a) => a.id).sort() }));`,
  ].join("\n");
  const scriptDir = mkdtempSync(path.join(tmpdir(), "ctk-skills-fifo-script-"));
  const scriptPath = path.join(scriptDir, "run.mjs");
  writeFileSync(scriptPath, script, "utf8");

  try {
    // 5초 데드라인 — 정상 스캔은 수 ms면 끝난다. FIFO에서 블록되면 timeout이 죽인다.
    const proc = spawnSync(process.execPath, [scriptPath], { timeout: 5000, encoding: "utf8" });
    const timedOut = proc.signal !== null;
    const report = proc.status === 0 && proc.stdout.length > 0 ? (JSON.parse(proc.stdout) as ChildReport) : null;
    return { report, timedOut, status: proc.status };
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

describe("probe/sources/skills — FIFO SKILL.md은 독립 스킬 스캔도 영구 블록하지 않는다(3차 심사 M-A)", () => {
  let fixture: { home: HomeContext; cleanup: () => void };
  afterEach(() => fixture?.cleanup());

  it(
    "SKILL.md가 FIFO여도 5초 안에 정상 종료하고 그 스킬만 건너뛴다(수정 전엔 EXIT=137로 영구 블록됐다)",
    () => {
      fixture = buildHome();
      const skillsRoot = path.join(fixture.home.ctkConfigDir, "skills");

      const fifoSkillDir = path.join(skillsRoot, "fifo-skill");
      mkdirSync(fifoSkillDir, { recursive: true });
      execFileSync("mkfifo", [path.join(fifoSkillDir, "SKILL.md")]);

      // 대조군 — 정상 스킬도 하나 둔다. FIFO 건너뛰기가 스캔 전체를 죽이지 않는지 함께 본다.
      const normalSkillDir = path.join(skillsRoot, "normal-skill");
      mkdirSync(normalSkillDir, { recursive: true });
      writeFileSync(path.join(normalSkillDir, "SKILL.md"), "---\nname: normal-skill\n---\n\n정상\n", "utf8");

      const { report, timedOut, status } = runCollectSkillsInChildProcess(fixture.home);

      // 핵심 단언 — 데드라인에 죽지 않았다. 죽었다면 FIFO 영구 블록 결함이 재현된 것이다.
      expect(timedOut).toBe(false);
      expect(status).toBe(0);
      expect(report).not.toBeNull();
      // FIFO는 일반 파일이 아니므로 그 디렉터리는 스킬이 아니다 — 정상 스킬만 남는다(반대 축).
      expect(report?.assetIds).toEqual(["normal-skill"]);
    },
    20_000,
  );
});

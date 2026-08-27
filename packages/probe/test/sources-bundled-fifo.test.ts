import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-bundled-fifo.test.ts — 보안 심사 M-1 처방 검증.
 *
 * `SKILL.md`가 FIFO면 `readFileSync`가 영구 블록된다(심사가 실제로 `timeout` 아래서
 * `EXIT=124`로 실증했다). **같은 프로세스 안에서는 이 결함을 안전하게 재현·검증할 수 없다** —
 * 동기 블로킹 `readFileSync` 호출 하나가 Node 이벤트 루프 자체를 멈추므로 `Promise.race` 같은
 * 걸로 감쌀 방법이 없다. 그래서 이 테스트는 **별도 프로세스 + `spawnSync`의 `timeout` 옵션**으로
 * 실제 하드 데드라인을 건다(외부 `timeout` 커맨드에 기대지 않는다 — Node 자체 기능이라
 * 어떤 머신에서도 동작한다). 주입 하나에 실행 하나: FIFO 하나만 심고, 자식 프로세스 하나만 띄운다.
 *
 * 픽스처는 `packages/probe/dist`(이미 빌드된 산출물)를 그대로 불러온다 — 자식 프로세스는 이
 * 저장소의 TS 트랜스파일 파이프라인을 갖지 않으므로 컴파일된 JS를 직접 실행해야 한다. 이 파일을
 * 손댄 뒤에는 `pnpm build`(또는 `pnpm typecheck`, 둘 다 `tsc -b`라 dist를 함께 emit한다)로
 * dist를 최신으로 맞춰야 이 테스트가 그 변경을 실제로 검증한다.
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const probeDistIndex = path.join(repoRoot, "packages", "probe", "dist", "index.js");

function buildHome(): { home: HomeContext; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-probe-fifo-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  mkdirSync(ctkConfigDir, { recursive: true });
  return {
    home: { ctkHome, ctkConfigDir, configDirExplicit: false },
    cleanup: () => rmSync(ctkHome, { recursive: true, force: true }),
  };
}

function writeInstalledPlugins(home: HomeContext, entries: Record<string, string>): void {
  const plugins: Record<string, unknown[]> = {};
  for (const [id, installPath] of Object.entries(entries)) {
    plugins[id] = [
      {
        scope: "user",
        installPath,
        version: "1.0.0",
        installedAt: "2026-08-01T00:00:00.000Z",
        lastUpdated: "2026-08-01T00:00:00.000Z",
      },
    ];
  }
  const dir = path.join(home.ctkConfigDir, "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }), "utf8");
}

function makePluginDir(home: HomeContext, name: string): string {
  const dir = path.join(home.ctkConfigDir, "plugins", "cache", "synth-marketplace", name, "1.0.0");
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface ChildReport {
  skills: number | null;
  reasons: string[];
}

/** 자식 프로세스에서 `collectBundled`를 1회 호출해 결과를 JSON으로 stdout에 찍고 종료한다. */
function runCollectBundledInChildProcess(home: HomeContext, parentId: string): { report: ChildReport | null; timedOut: boolean; status: number | null } {
  const script = [
    `import { collectBundled } from ${JSON.stringify(pathToFileURL(probeDistIndex).href)};`,
    `const result = collectBundled({ home: ${JSON.stringify(home)}, pluginIds: [${JSON.stringify(parentId)}] });`,
    `process.stdout.write(JSON.stringify(result.perParent[0] ?? null));`,
  ].join("\n");
  const scriptDir = mkdtempSync(path.join(tmpdir(), "ctk-probe-fifo-script-"));
  const scriptPath = path.join(scriptDir, "run.mjs");
  writeFileSync(scriptPath, script, "utf8");

  try {
    // 5초 데드라인 — 정상 스캔은 수 ms면 끝난다. FIFO에서 블록되면 timeout이 SIGTERM으로 죽인다.
    const proc = spawnSync(process.execPath, [scriptPath], { timeout: 5000, encoding: "utf8" });
    const timedOut = proc.signal !== null;
    const report = proc.status === 0 && proc.stdout.length > 0 ? (JSON.parse(proc.stdout) as ChildReport) : null;
    return { report, timedOut, status: proc.status };
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

describe("probe/sources/bundled — FIFO SKILL.md은 스캔을 영구 블록하지 않는다(보안 심사 M-1)", () => {
  let fixture: { home: HomeContext; cleanup: () => void };
  afterEach(() => fixture?.cleanup());

  it(
    "SKILL.md가 FIFO여도 5초 안에 정상 종료하고 그 스킬은 건너뛴다(수정 전엔 EXIT=124로 영구 블록됐다)",
    () => {
      fixture = buildHome();
      const parentId = "demo-plugin@synth-marketplace";
      const pluginDir = makePluginDir(fixture.home, "demo-plugin");
      writeInstalledPlugins(fixture.home, { [parentId]: pluginDir });

      const skillDir = path.join(pluginDir, "skills", "fifo-skill");
      mkdirSync(skillDir, { recursive: true });
      const fifoPath = path.join(skillDir, "SKILL.md");
      execFileSync("mkfifo", [fifoPath]);

      // 대조군 — 정상 스킬도 하나 둔다. FIFO 건너뛰기가 부모 전체를 죽이지 않는지 함께 본다.
      const normalSkillDir = path.join(pluginDir, "skills", "normal-skill");
      mkdirSync(normalSkillDir, { recursive: true });
      writeFileSync(path.join(normalSkillDir, "SKILL.md"), "---\nname: normal-skill\n---\n\n정상 스킬\n", "utf8");

      const { report, timedOut, status } = runCollectBundledInChildProcess(fixture.home, parentId);

      // 핵심 단언 — 타임아웃으로 죽지 않았다. 죽었다면(SIGTERM) FIFO 영구 블록 결함이 재현된 것.
      expect(timedOut).toBe(false);
      expect(status).toBe(0);
      expect(report).not.toBeNull();
      // FIFO는 일반 파일이 아니므로 그 스킬 디렉터리는 편입되지 않는다 — 정상 스킬 1건만 남는다.
      expect(report?.skills).toBe(1);
    },
    // 자식 프로세스 기동 오버헤드를 감안해 테스트 자체 타임아웃은 넉넉히 잡는다(내부 5초 데드라인과
    // 별개 — 이건 vitest가 이 it 블록에 거는 상한이다).
    15000,
  );
});

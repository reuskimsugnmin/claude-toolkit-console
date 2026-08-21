import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runScan } from "../src/commands/scan.js";
import { runMove } from "../src/commands/move.js";
import { runRollback } from "../src/commands/rollback.js";
import { McpMoveRejectedError } from "@ctk/actuator";
import { collectTree } from "@ctk/probe";

/**
 * cli/test/move-rollback.test.ts — Step 5 필수 산출물: **격리 홈에서의 이관 왕복 e2e**
 * (플러그인 1개 전역→프로젝트 이관 → 재스캔 실측 확인 → 롤백 → 원상복구 확인. 스킬도 동일 왕복).
 *
 * 플러그인 케이스는 **실제 `claude` 바이너리**를 격리된 `CTK_HOME`/`CTK_CONFIG_DIR`에 대해
 * 돌린다(spikes/fixtures/marketplace-source/synth-mp — Step 0 스파이크가 이미 검증한 합성
 * 마켓플레이스/플러그인, 네트워크 불요·오프라인 동작 확인됨). `claude`가 실제로 없는 CI 환경을
 * 위해 마켓플레이스 등록이 실패하면 스킵한다(그 자체가 회귀는 아니다 — 하네스 부재일 뿐).
 *
 * 실제 `~/.claude`는 전혀 건드리지 않는다 — `CTK_HOME`/`CTK_CONFIG_DIR` 둘 다 매 테스트 임시
 * 디렉터리로 격리한다(§6.0 규약과 동형).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const SYNTH_MARKETPLACE_SRC = path.join(REPO_ROOT, "spikes/fixtures/marketplace-source/synth-mp");

function runRealClaude(ctkHome: string, ctkConfigDir: string, cwd: string, args: string[]) {
  return spawnSync("claude", args, {
    cwd,
    env: {
      HOME: ctkHome,
      CLAUDE_CONFIG_DIR: ctkConfigDir,
      PATH: process.env.PATH ?? "",
      TERM: "xterm",
      SHELL: "/bin/bash",
      TMPDIR: "/tmp",
    },
    encoding: "utf8",
  });
}

function writeJson(absPath: string, value: unknown): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(value, null, 2), "utf8");
}

describe("cli — ctk move / ctk rollback 왕복 e2e (Step 5, AC-2.1/2.2/2.3/2.4/2.5/2.9)", () => {
  let ctkHome: string;
  let ctkConfigDir: string;
  let projectDir: string;
  let originalEnv: { CTK_HOME?: string; CTK_CONFIG_DIR?: string };
  let claudeAvailable = true;

  beforeEach(() => {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-move-e2e-home-"));
    ctkConfigDir = path.join(ctkHome, ".claude");
    projectDir = mkdtempSync(path.join(tmpdir(), "ctk-move-e2e-project-"));
    mkdirSync(ctkConfigDir, { recursive: true });

    // 알려진 프로젝트 레지스트리(.claude.json의 projects 키) — probe/known-projects.ts와
    // actuator move.ts의 --project-index가 이걸 읽는다. 실제 claude 바이너리는 이 파일을
    // HOME이 아니라 CLAUDE_CONFIG_DIR 안에 쓴다(실측, docs/harness-facts.md) — 이 테스트는
    // CTK_HOME과 CTK_CONFIG_DIR을 둘 다 명시 설정하므로(아래) configDirExplicit=true가 되고,
    // H5 수정 이후 `claudeJsonPath()`도 이제 CLAUDE_CONFIG_DIR 안을 본다(probe/src/home.ts).
    // 실제 claude 서브프로세스가 쓰는 위치와 probe가 읽는 위치가 이제 일치하므로 같은 곳에 씨딩한다.
    writeJson(path.join(ctkConfigDir, ".claude.json"), { projects: { [projectDir]: {} } });

    originalEnv = { CTK_HOME: process.env.CTK_HOME, CTK_CONFIG_DIR: process.env.CTK_CONFIG_DIR };
    process.env.CTK_HOME = ctkHome;
    process.env.CTK_CONFIG_DIR = ctkConfigDir;

    const marketplaceAdd = runRealClaude(ctkHome, ctkConfigDir, ctkHome, [
      "plugin",
      "marketplace",
      "add",
      SYNTH_MARKETPLACE_SRC,
    ]);
    claudeAvailable = marketplaceAdd.status === 0;
    if (claudeAvailable) {
      const install = runRealClaude(ctkHome, ctkConfigDir, ctkHome, ["plugin", "install", "synth@synth-mp", "-s", "user", "-y"]);
      claudeAvailable = install.status === 0;
    }
  });

  afterEach(() => {
    if (originalEnv.CTK_HOME === undefined) delete process.env.CTK_HOME;
    else process.env.CTK_HOME = originalEnv.CTK_HOME;
    if (originalEnv.CTK_CONFIG_DIR === undefined) delete process.env.CTK_CONFIG_DIR;
    else process.env.CTK_CONFIG_DIR = originalEnv.CTK_CONFIG_DIR;
    rmSync(ctkHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("플러그인: user → project 전이 → 재스캔 실측 확인 → 롤백 → 원상복구 확인(AC-2.1)", async (ctx) => {
    // M9 수정 — `if (!claudeAvailable) return;`은 vitest에서 조용한 PASS다(skip이 아니다).
    // 필수 게이트가 실제 claude 바이너리 부재 환경에서 공허하게 초록으로 찍히는 회귀가 있었다.
    // `ctx.skip()`은 이 테스트를 명시적으로 "건너뜀"으로 리포트해 PASS와 구분되게 만든다.
    if (!claudeAvailable) {
      ctx.skip(); // 실제 claude 바이너리/오프라인 마켓플레이스 등록 불가 환경 — 명시적 스킵
      return;
    }

    await runInit({});

    const ipjAbsPath = path.join(ctkConfigDir, "plugins", "installed_plugins.json");
    const ipjBefore = readFileSync(ipjAbsPath, "utf8");

    const before = await runScan();
    expect(before.assetCounts.plugin).toBeGreaterThanOrEqual(1);

    const moveSummary = await runMove({ assetId: "synth@synth-mp", to: "project", toProjectIndex: 0 });
    expect(moveSummary.kind).toBe("plugin");
    expect(moveSummary.from).toBe("user");
    expect(moveSummary.to).toBe("project:project");

    // AC-2.1ⓒ — installed_plugins.json이 바이트 단위로 무변경(install_scope 무변경의 직접 증거).
    const ipjAfterMove = readFileSync(ipjAbsPath, "utf8");
    expect(ipjAfterMove).toBe(ipjBefore);

    // AC-2.1ⓐ — 재스캔 실측으로 enabled_at 전이 확인.
    const afterMove = await runScan();
    const projectSettings = JSON.parse(readFileSync(path.join(projectDir, ".claude", "settings.json"), "utf8")) as {
      enabledPlugins?: Record<string, boolean>;
    };
    expect(projectSettings.enabledPlugins?.["synth@synth-mp"]).toBe(true);
    const userSettings = JSON.parse(readFileSync(path.join(ctkConfigDir, "settings.json"), "utf8")) as {
      enabledPlugins?: Record<string, boolean>;
    };
    expect(userSettings.enabledPlugins?.["synth@synth-mp"]).toBe(false);
    void afterMove;

    // 롤백 — 원상복구.
    const rollbackSummary = await runRollback({ last: true });
    expect(rollbackSummary.assetId).toBe("synth@synth-mp");

    const ipjAfterRollback = readFileSync(ipjAbsPath, "utf8");
    expect(ipjAfterRollback).toBe(ipjBefore);

    const userSettingsRestored = JSON.parse(readFileSync(path.join(ctkConfigDir, "settings.json"), "utf8")) as {
      enabledPlugins?: Record<string, boolean>;
    };
    expect(userSettingsRestored.enabledPlugins?.["synth@synth-mp"]).toBe(true);

    const afterRollback = await runScan();
    expect(afterRollback.scopeDistribution).toEqual(before.scopeDistribution);
  }, 60_000);

  it("스킬: user → project 전이 → 재스캔 실측 확인 → 롤백 → 원상복구 확인(AC-2.2)", async () => {
    await runInit({});

    mkdirSync(path.join(ctkConfigDir, "skills", "demo-skill"), { recursive: true });
    writeFileSync(
      path.join(ctkConfigDir, "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: 왕복 e2e 픽스처\n---\n\n# demo-skill\n",
      "utf8",
    );

    const before = await runScan({ spawnFn: async () => ({ exitCode: 0, stdout: "[]", stderr: "", timedOut: false }) });
    expect(before.assetCounts.skill).toBeGreaterThanOrEqual(1);

    const configDirBefore = path.join(ctkConfigDir, "skills", "demo-skill");
    const projectDirAfter = path.join(projectDir, ".claude", "skills", "demo-skill");
    expect(existsSync(configDirBefore)).toBe(true);
    expect(existsSync(projectDirAfter)).toBe(false);

    const moveSummary = await runMove({ assetId: "demo-skill", to: "project", toProjectIndex: 0 });
    expect(moveSummary.kind).toBe("skill");

    // AC-2.2 — 원본 경로 부재 + 새 위치에 존재 + 내용 sha256 동일.
    expect(existsSync(configDirBefore)).toBe(false);
    expect(existsSync(projectDirAfter)).toBe(true);
    expect(readFileSync(path.join(projectDirAfter, "SKILL.md"), "utf8")).toBe(
      "---\nname: demo-skill\ndescription: 왕복 e2e 픽스처\n---\n\n# demo-skill\n",
    );

    await runRollback({ last: true });

    // 원상복구 — 원래 위치로 되돌아오고 새 위치는 사라진다.
    expect(existsSync(configDirBefore)).toBe(true);
    expect(existsSync(projectDirAfter)).toBe(false);
    expect(readFileSync(path.join(configDirBefore, "SKILL.md"), "utf8")).toBe(
      "---\nname: demo-skill\ndescription: 왕복 e2e 픽스처\n---\n\n# demo-skill\n",
    );
  });

  it(
    "✅ 신설 AC-5.1 재현 — apply가 실패해 self-rollback하면(스킬 이동 목적지 충돌) journal에 " +
      "result:\"rolled_back\" 레코드가 실제로 남고 run-log에도 실패가 기록된다(수정 전에는 " +
      "JournalResult의 \"failure\"/\"rolled_back\"이 스키마에만 있고 코드가 한 번도 안 썼다 — " +
      "이 시도 자체가 journal에서 통째로 사라졌었다)",
    async () => {
      const initResult = await runInit({});

      mkdirSync(path.join(ctkConfigDir, "skills", "conflict-skill"), { recursive: true });
      writeFileSync(path.join(ctkConfigDir, "skills", "conflict-skill", "SKILL.md"), "---\nname: conflict-skill\n---\n", "utf8");
      // 목적지 자리에 이미 무관한 콘텐츠가 있다 — moveSkillDir이 조용한 덮어쓰기를 거부하고
      // SkillDirMoveError를 던진다(apply 단계 실패, 3단계).
      mkdirSync(path.join(projectDir, ".claude", "skills", "conflict-skill"), { recursive: true });
      writeFileSync(
        path.join(projectDir, ".claude", "skills", "conflict-skill", "SKILL.md"),
        "---\nname: pre-existing\n---\n",
        "utf8",
      );

      await runScan({ spawnFn: async () => ({ exitCode: 0, stdout: "[]", stderr: "", timedOut: false }) });

      await expect(runMove({ assetId: "conflict-skill", to: "project", toProjectIndex: 0 })).rejects.toThrow();

      // journal에 이 시도의 기록이 남아 있고, result가 "rolled_back"이다(apply 실패 후 백업에서
      // 되돌리는 데는 성공했다 — 애초에 아무 것도 바뀌지 않았으므로).
      const journalDir = path.join(initResult.catalogPath, "journal");
      const journalFiles = readdirSync(journalDir).filter((f) => f.endsWith(".jsonl")).sort();
      const lastEntry = JSON.parse(readFileSync(path.join(journalDir, journalFiles[journalFiles.length - 1]!), "utf8")) as {
        action: string;
        asset_id: string;
        result: string;
      };
      expect(lastEntry.asset_id).toBe("conflict-skill");
      expect(lastEntry.action).toBe("move_skill_dir");
      expect(lastEntry.result).toBe("rolled_back");

      // run-log에도 이 실패한 move 시도가 exit_code!=0으로 남는다(AC-5.1 — move 자체가 이전엔
      // run-log를 전혀 안 썼다).
      const machinesDir = path.join(initResult.catalogPath, "machines");
      const machineDirName = readdirSync(machinesDir)[0]!;
      const runFiles = readdirSync(path.join(machinesDir, machineDirName, "runs")).sort();
      const lastRun = JSON.parse(
        readFileSync(path.join(machinesDir, machineDirName, "runs", runFiles[runFiles.length - 1]!), "utf8"),
      ) as { command: string; exit_code: number; failure_class: string | null };
      expect(lastRun.command).toBe("move");
      expect(lastRun.exit_code).not.toBe(0);
      expect(lastRun.failure_class).not.toBeNull();

      // 목적지 원래 내용은 훼손되지 않았다(조용한 덮어쓰기가 없었다).
      expect(readFileSync(path.join(projectDir, ".claude", "skills", "conflict-skill", "SKILL.md"), "utf8")).toBe(
        "---\nname: pre-existing\n---\n",
      );
      // 소스도 원래 위치에 그대로 남아있다(self-rollback이 정상 작동).
      expect(existsSync(path.join(ctkConfigDir, "skills", "conflict-skill"))).toBe(true);
    },
  );

  it("MCP 자산 이관은 거부되고 어떤 파일도 변경되지 않는다(AC-2.9)", async () => {
    await runInit({});
    writeJson(path.join(ctkConfigDir, "settings.json"), {});
    // root mcpServers — probe/sources/mcp.ts가 kind:"mcp" Asset으로 잡는 유일한 정의 위치.
    // H5 수정 이후 이 테스트(CTK_CONFIG_DIR 명시 설정, configDirExplicit=true)의 .claude.json은
    // ctkConfigDir 안에 있다(위 beforeEach와 동일 근거).
    writeJson(path.join(ctkConfigDir, ".claude.json"), {
      projects: { [projectDir]: {} },
      mcpServers: { "demo-mcp": { command: "true" } },
    });
    await runScan({ spawnFn: async () => ({ exitCode: 0, stdout: "[]", stderr: "", timedOut: false }) });

    const beforeTree = collectTree(ctkConfigDir).entries;

    await expect(runMove({ assetId: "demo-mcp", to: "project", toProjectIndex: 0 })).rejects.toBeInstanceOf(
      McpMoveRejectedError,
    );

    const afterTree = collectTree(ctkConfigDir).entries;
    expect(afterTree).toEqual(beforeTree); // 어떤 파일도 변경되지 않음
  });

  it(
    "✅ Step 5 e2e에서 발견한 경로 순회 취약점(H2) — SKILL.md frontmatter name 위조로 " +
      "카탈로그 루트 밖에 파일이 써지지 않는다. `ctk scan` 단계에서부터 거부된다(sync/asset-store.ts)",
    async () => {
      const initResult = await runInit({});
      // 디렉터리명은 평범하지만 frontmatter `name`이 경로 순회 문자열을 자칭한다 — probe/
      // sources/skills.ts는 frontmatter.name을 검증 없이 그대로 asset id로 쓴다. 고쳐진
      // sync/asset-store.ts가 이 값을 카탈로그 경로 세그먼트로 쓰기 직전에 막는다.
      mkdirSync(path.join(ctkConfigDir, "skills", "malicious-skill"), { recursive: true });
      writeFileSync(
        path.join(ctkConfigDir, "skills", "malicious-skill", "SKILL.md"),
        "---\nname: ../../evil\n---\n",
        "utf8",
      );

      await expect(
        runScan({ spawnFn: async () => ({ exitCode: 0, stdout: "[]", stderr: "", timedOut: false }) }),
      ).rejects.toMatchObject({ failureClass: "path_traversal_detected" });

      // 카탈로그 디렉터리의 부모(="../../evil"이 실제로 탈출하면 파일이 생겼을 자리)에
      // 그 이름을 담은 경로가 전혀 생기지 않았다 — run-log/machine.json처럼 실패 자체를
      // 기록하는 정상적인 부수 쓰기는 허용하되(byte-for-byte 트리 동일성은 과한 단언이다),
      // 취약점 클래스(경로 세그먼트 탈출) 자체가 재현되지 않았음만 정확히 확인한다.
      const catalogParentAfter = collectTree(path.dirname(initResult.catalogPath)).entries;
      expect(catalogParentAfter.some((e) => e.path.includes("evil"))).toBe(false);
    },
  );

  it(
    "✅ 방어 심층 — 카탈로그 index.json에 이미 경로 순회 id가 올라간 최악의 경우에도 " +
      "`ctk move`가 그 값을 skills/<id> 경로 세그먼트로 쓰지 않는다(H2/H6, move.ts 자체 검증). " +
      "H6 수정 이후에는 id로 경로를 지어내지 않고 probe로 실제 디렉터리를 찾으므로, 대응하는 " +
      "실제 디렉터리가 없다는 판정(SkillLocationAmbiguousError)으로 거부된다 — 문자열 패턴 " +
      "매칭이 아니라 구조적으로 경로 순회가 성립할 수 없다",
    async () => {
      const result = await runInit({});
      mkdirSync(path.join(ctkConfigDir, "skills", "demo-skill"), { recursive: true });
      writeFileSync(path.join(ctkConfigDir, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\n---\n", "utf8");
      await runScan({ spawnFn: async () => ({ exitCode: 0, stdout: "[]", stderr: "", timedOut: false }) });

      // 카탈로그 자체 방어(sync/asset-store.ts)를 우회해 index.json에 직접 악성 항목을
      // 주입한다 — "만약 이 방어선이 없었다면"을 재현하는 방어 심층 테스트다.
      const indexAbsPath = path.join(result.catalogPath, "catalog", "index.json");
      const index = JSON.parse(readFileSync(indexAbsPath, "utf8")) as { assets: unknown[] };
      index.assets.push({ id: "../../evil", kind: "skill", name: "../../evil" });
      writeFileSync(indexAbsPath, JSON.stringify(index, null, 2), "utf8");

      const beforeTree = collectTree(ctkConfigDir).entries;

      await expect(runMove({ assetId: "../../evil", to: "project", toProjectIndex: 0 })).rejects.toMatchObject({
        failureClass: "skill_location_ambiguous",
      });

      const afterTree = collectTree(ctkConfigDir).entries;
      expect(afterTree).toEqual(beforeTree);
    },
  );
});

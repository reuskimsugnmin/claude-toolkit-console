import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPath, McpToggleJournalStateSchema, parseClaudeJsonFile, parseJournalEntry, parseRunLogEntry, type Installation } from "@ctk/core";
import type { SpawnClaudeOptions, SpawnClaudeResult } from "@ctk/probe";
import { readFixtureJson } from "../../core/test/support/fixtures.js";

/**
 * 프로덕션 형태 `ctk mcp` e2e — `CTK_HOME=<tmp>`, `CTK_CONFIG_DIR` 미설정이라 실제 `.claude.json`은 `$HOME/.claude.json`이고
 * `$HOME/.claude/.claude.json`은 쓰이지 않는다(선례: move-production-shape.test.ts). 파일은 전부 임시 디렉터리다 — 실제 홈을 건드리지 않는다.
 * 파서는 가짜가 아니라 실물이다: `.claude.json`은 `parseClaudeJsonFile`, journal은 `parseJournalEntry`를 통과시킨다.
 */
const hooks = vi.hoisted(() => ({
  /** 다른 머신이 남긴 Installation 행을 이 머신 probe 결과에 섞는다 — 이 머신 필터를 태우는 이음매. */
  foreignRows: undefined as unknown[] | undefined,
  /** true면 카탈로그 커밋이 던진다 — journal 파일은 써진 뒤라 "썼다"와 "커밋됐다"를 가른다. */
  commitThrows: false,
}));

vi.mock("@ctk/sync", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ctk/sync")>();
  return {
    ...real,
    commitAll: (...args: Parameters<typeof real.commitAll>) => {
      if (hooks.commitThrows) throw new Error("commit forced throw");
      return real.commitAll(...args);
    },
  };
});

vi.mock("@ctk/probe", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ctk/probe")>();
  return {
    ...real,
    collectMcp: (...args: Parameters<typeof real.collectMcp>) => {
      const r = real.collectMcp(...args);
      return hooks.foreignRows === undefined ? r : { ...r, installations: [...r.installations, ...(hooks.foreignRows as Installation[])] };
    },
  };
});

const { main } = await import("../bin/ctk.js");
const { runInit } = await import("../src/commands/init.js");
const { runScan } = await import("../src/commands/scan.js");
const { runMcpToggle, formatMcpToggleSummary } = await import("../src/commands/mcp-toggle.js");
const { runRollback, McpToggleRollbackRefusedError } = await import("../src/commands/rollback.js");
const { McpToggleRefusedError } = await import("../src/project-select.js");
const { readLocalConfig, readOrCreateMachineIdentity } = await import("../src/local-config.js");
const { resolveHomeContext } = await import("@ctk/probe");

const PLUGIN = "plug@mkt";
const PLUGIN_CHILD = `${PLUGIN}:mcp:plug-srv`;
const fakeSpawn = (stdout: string) => async (_o: SpawnClaudeOptions): Promise<SpawnClaudeResult> => ({ exitCode: 0, stdout, stderr: "", timedOut: false });

describe("cli — ctk mcp 프로덕션 형태(CTK_CONFIG_DIR 미설정)", () => {
  let root: string;
  let ctkHome: string;
  let dirA: string;
  let dirB: string;
  let jsonAbs: string;
  let s0: string;
  let catalogPath: string;
  let saved: { CTK_HOME?: string; CTK_CONFIG_DIR?: string };

  const readJson = () => readFileSync(jsonAbs, "utf8");
  const journalFiles = () => (existsSync(path.join(catalogPath, "journal")) ? readdirSync(path.join(catalogPath, "journal")).sort() : []);
  const runLogs = (command: string) => {
    const machinesDir = path.join(catalogPath, "machines");
    const runsDir = path.join(machinesDir, readdirSync(machinesDir)[0]!, "runs");
    return readdirSync(runsDir)
      .sort()
      .map((f) => parseRunLogEntry(JSON.parse(readFileSync(path.join(runsDir, f), "utf8"))))
      .filter((l) => l.command === command);
  };
  const toggle = (op: "disable" | "enable", assetId: string, dir: string = dirA) => runMcpToggle({ op, assetId, projectHash: hashPath(dir).slice(0, 8) });
  const refusal = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToggleRefusedError);
    return err as InstanceType<typeof McpToggleRefusedError>;
  };
  /** 쓰기 0 — 바이트·journal 수가 그대로다. */
  const expectNoWrite = (journalsBefore: number) => {
    expect(readJson()).toBe(s0);
    expect(journalFiles()).toHaveLength(journalsBefore);
  };
  /** 같은 CLI 진입점(`main`)을 argv로 태운다. 화면 출력과 종료 코드를 모은다. */
  async function ctk(...args: string[]) {
    const out: string[] = [];
    const sinks = (["log", "error", "warn"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.join(" "))));
    const argv = process.argv;
    process.argv = ["node", "ctk.ts", ...args];
    process.exitCode = undefined;
    try {
      await main();
      const exitCode = process.exitCode as number | undefined;
      return { out: out.join("\n"), exitCode: exitCode ?? 0 };
    } finally {
      process.argv = argv;
      process.exitCode = undefined;
      for (const s of sinks) s.mockRestore();
    }
  }

  beforeEach(async () => {
    saved = { CTK_HOME: process.env.CTK_HOME, CTK_CONFIG_DIR: process.env.CTK_CONFIG_DIR };
    hooks.foreignRows = undefined;
    hooks.commitThrows = false;
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "ctk-mcp-e2e-")));
    ctkHome = path.join(root, "home");
    dirA = path.join(root, "proj-a");
    dirB = path.join(root, "proj-b");
    for (const d of [path.join(ctkHome, ".claude"), path.join(dirA, ".git"), path.join(dirB, ".git")]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(dirA, ".mcp.json"), JSON.stringify({ mcpServers: { "pend-srv": { command: "echo" } } }), "utf8");

    // 실제 CLI 산출물 서식(fixtures)을 뼈대로 쓴다 — 왕복 전제를 합성 서식이 아니라 실물 서식으로 태운다.
    const fx = readFixtureJson("claude-json/real-cli-add-json.json") as { projects: Record<string, Record<string, unknown>> } & Record<string, unknown>;
    // 하네스가 /mcp 토글 뒤에 남기는 모양(빈 목록 키 존재)으로 둔다 — `enable`로 마지막 이름을 빼면 키는 `[]`로 남는다(planMcpToggle), 키 부재 S0이면 왕복 바이트가 달라진다.
    const proto = { ...fx.projects["/synthetic/projects/alpha"]!, disabledMcpServers: [] };
    const server = { type: "stdio", command: "echo", args: [] };
    s0 = JSON.stringify(
      { ...fx, mcpServers: { "user-srv": server }, projects: { [dirA]: { ...proto, mcpServers: { "local-srv": server } }, [dirB]: { ...proto, mcpServers: {} } } },
      null,
      2,
    );
    jsonAbs = path.join(ctkHome, ".claude.json");
    writeFileSync(jsonAbs, s0, "utf8");
    writeFileSync(path.join(ctkHome, ".claude", ".claude.json"), '{"decoy":true}', "utf8"); // 프로덕션 형태의 미끼

    // 플러그인 하나(번들 MCP 서버 한 개) — 레지스트리는 테스트마다 바꾼다.
    const installDir = path.join(ctkHome, ".claude", "plugins", "cache", "mkt", "plug", "1.0.0");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(installDir, ".mcp.json"), JSON.stringify({ mcpServers: { "plug-srv": { command: "echo" } } }), "utf8");
    writeRegistry("user");
    writeFileSync(path.join(ctkHome, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [PLUGIN]: true } }), "utf8");

    process.env.CTK_HOME = ctkHome;
    delete process.env.CTK_CONFIG_DIR; // 프로덕션 형태
    catalogPath = (await runInit({})).catalogPath;
    await runScan({
      spawnFn: fakeSpawn(
        JSON.stringify([{ id: PLUGIN, version: "1.0.0", scope: "user", enabled: true, installPath: installDir, installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" }]),
      ),
    });
  });

  afterEach(() => {
    for (const k of ["CTK_HOME", "CTK_CONFIG_DIR"] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try {
      chmodSync(path.join(catalogPath, "journal"), 0o700);
    } catch {
      /* 없을 수 있다 */
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function writeRegistry(scope: "user" | "local", projectPath?: string): void {
    const installPath = path.join(ctkHome, ".claude", "plugins", "cache", "mkt", "plug", "1.0.0");
    mkdirSync(path.join(ctkHome, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      path.join(ctkHome, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { [PLUGIN]: [{ scope, installPath, version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z", ...(projectPath !== undefined ? { projectPath } : {}) }] } }),
      "utf8",
    );
  }

  it("(1) 가장 먼저 — 토글 직후 `ctk rollback --last`는 거부되고 journal 수와 .claude.json 바이트가 그대로다", async () => {
    await toggle("disable", "user-srv");
    const afterToggle = readJson();
    expect(afterToggle).not.toBe(s0);
    const journals = journalFiles();
    expect(journals).toHaveLength(1);

    const err = await runRollback({ last: true }).catch((e: unknown) => e as Error);

    // 사실(쓰기 0)을 먼저, 종류(어떤 오류인가)를 나중에 본다 — 거부가 빠지면 먼저 걸리는 것은 "성공 rollback journal이 생겼다"여야 한다.
    expect(journalFiles()).toEqual(journals); // 거부가 "성공 rollback" journal을 만들지 않았다
    expect(readJson()).toBe(afterToggle);
    expect(err).toBeInstanceOf(McpToggleRollbackRefusedError);
    expect((err as { failureClass?: string }).failureClass).toBe("mcp_toggle_refused");
    expect(runLogs("rollback").at(-1)).toMatchObject({ exit_code: 1, failure_class: "mcp_toggle_refused" });
  });

  it("(2) 웹 경로와 같은 클래스 — NoRollbackTargetError의 하위라 web-actions가 bad_request로 분류한다", async () => {
    await toggle("disable", "user-srv");
    const { NoRollbackTargetError } = await import("../src/commands/rollback.js");
    const err = await runRollback({ last: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoRollbackTargetError);
  });

  it("(2b) 웹 롤백 액션도 같은 거부를 bad_request로 돌려준다(메시지는 UI가 textContent로만 렌더한다)", async () => {
    await toggle("disable", "user-srv");
    const { createActionHandlers } = await import("../src/commands/web-actions.js");
    const err = (await createActionHandlers().rollback().catch((e: unknown) => e)) as { code?: string; message: string };
    expect(err.code).toBe("bad_request");
    expect(err.message).toContain("되돌리려면: ctk mcp enable");
  });

  it("(3) 출력된 힌트를 그대로 같은 CLI 진입점으로 실행하면 S0로 돌아온다", async () => {
    await toggle("disable", "user-srv");
    const err = await runRollback({ last: true }).catch((e: unknown) => e as Error);
    const hint = /되돌리려면: (ctk mcp .+)$/.exec((err as Error).message)?.[1];
    expect(hint).toBe(`ctk mcp enable --asset user-srv --project-hash ${hashPath(dirA)}`);

    const run = await ctk(...hint!.split(" ").slice(1));

    expect(run.exitCode).toBe(0);
    expect(readJson()).toBe(s0);
  });

  it.each([
    ["세미콜론", "x;rm -rf ~"],
    ["명령 치환", "x$(id)"],
    ["백틱", "x`id`"],
    ["ESC", "x\u001b[31m"],
  ])("(4) journal의 asset_id에 %s가 있으면 힌트를 만들지 않고 일반 안내(`ctk scan` 먼저)를 낸다", async (_label, evilId) => {
    await toggle("disable", "user-srv");
    // 동기화된 journal은 신뢰할 수 없다 — 마지막 레코드를 악성 id로 바꿔 본다.
    const file = path.join(catalogPath, "journal", journalFiles()[0]!);
    const entry = parseJournalEntry(JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(file, `${JSON.stringify({ ...entry, asset_id: evilId })}\n`, "utf8");

    const err = (await runRollback({ last: true }).catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(McpToggleRollbackRefusedError);
    expect(err.message).not.toContain("되돌리려면:");
    expect(err.message).not.toContain(evilId);
    expect(err.message).toContain("`ctk scan`");
  });

  it("(5) after가 상태 스키마를 못 통과하거나 result가 success가 아니어도 일반 안내다", async () => {
    await toggle("disable", "user-srv");
    const file = path.join(catalogPath, "journal", journalFiles()[0]!);
    const entry = parseJournalEntry(JSON.parse(readFileSync(file, "utf8")));
    for (const mutated of [{ ...entry, after: { ...entry.after, extra: 1 } }, { ...entry, result: "failure" }]) {
      writeFileSync(file, `${JSON.stringify(mutated)}\n`, "utf8");
      const err = (await runRollback({ last: true }).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(McpToggleRollbackRefusedError);
      expect(err.message).not.toContain("되돌리려면:");
    }
  });

  it("(6) disable → enable 왕복은 바이트가 S0과 같고, 중간 상태는 실물 파서·journal 파서를 통과한다", async () => {
    const dis = await toggle("disable", "user-srv");
    expect(dis.outcome).toBe("applied");
    const parsed = parseClaudeJsonFile(JSON.parse(readJson()));
    expect(parsed.projects?.[dirA]?.disabledMcpServers).toEqual(["user-srv"]);
    const entry = parseJournalEntry(JSON.parse(readFileSync(path.join(catalogPath, "journal", journalFiles()[0]!), "utf8")));
    expect(entry).toMatchObject({ action: "toggle_mcp_project", result: "success", asset_id: "user-srv" });
    expect(McpToggleJournalStateSchema.parse(entry.after)).toEqual({ harness_name: "user-srv", project_path_hash: hashPath(dirA), disabled: true });
    expect(entry.backup_ref.startsWith("~/")).toBe(true);

    await toggle("enable", "user-srv");
    expect(readJson()).toBe(s0);
    expect(journalFiles()).toHaveLength(2);
  });

  it("(7) noop은 바이트·백업·journal을 만들지 않고 run-log만 한 건 남긴다", async () => {
    const before = journalFiles().length;
    const summary = await toggle("enable", "user-srv"); // 애초에 꺼져 있지 않다
    expect(summary.outcome).toBe("noop");
    expectNoWrite(before);
    expect(existsSync(path.join(ctkHome, ".ctk-backups"))).toBe(false);
    expect(runLogs("mcp")).toHaveLength(1);
    expect(runLogs("mcp")[0]).toMatchObject({ exit_code: 0, failure_class: null, args: { outcome: "noop", journal_written: false, project_path_hash: hashPath(dirA) } });
  });

  describe("선택자·프로젝트 키 거부 — 쓰기 0", () => {
    it("두 선택자를 함께 주면 거부", async () => {
      const err = await refusal(runMcpToggle({ op: "disable", assetId: "user-srv", projectHash: hashPath(dirA).slice(0, 8), project: dirA }));
      expect(err.guard).toBe("selector_conflict");
      expectNoWrite(0);
    });

    it.each([["짧다", "abcd123"], ["대문자", "ABCDEF12"], ["17자", "a".repeat(17)], ["빈 값", ""]])("해시 형식 오류(%s)", async (_l, hash) => {
      const err = await refusal(runMcpToggle({ op: "disable", assetId: "user-srv", projectHash: hash }));
      expect(err.guard).toBe("hash_format");
      expectNoWrite(0);
    });

    it("형식은 맞지만 목록에 없는 해시(stale)", async () => {
      const err = await refusal(runMcpToggle({ op: "disable", assetId: "user-srv", projectHash: "00000000" }));
      expect(err.guard).toBe("hash_stale");
      expectNoWrite(0);
    });

    it("--project가 projects의 키가 아니면 거부(디스크에 있어도)", async () => {
      const other = path.join(root, "not-a-key");
      mkdirSync(other);
      const err = await refusal(runMcpToggle({ op: "disable", assetId: "user-srv", project: other }));
      expect(err.guard).toBe("key_absent");
      expectNoWrite(0);
    });

    it("키가 realpath가 아니면(심볼릭 링크 경유 — /tmp 대 /private/tmp 모양) 거부", async () => {
      const link = path.join(root, "link-a");
      symlinkSync(dirA, link);
      const v = JSON.parse(s0) as { projects: Record<string, unknown> };
      v.projects[link] = v.projects[dirA];
      s0 = JSON.stringify(v, null, 2);
      writeFileSync(jsonAbs, s0, "utf8");
      const err = await refusal(runMcpToggle({ op: "disable", assetId: "user-srv", project: link }));
      expect(err.guard).toBe("key_not_realpath");
      expectNoWrite(0);
    });

    it("실제 디렉터리 이름과 대소문자만 다른 키면 거부 — 대소문자 무시 FS는 key_case_differs, 구분 FS는 key_not_on_disk", async () => {
      mkdirSync(path.join(root, "CaseDir", ".git"), { recursive: true });
      const caseKey = path.join(root, "casedir");
      // 조용히 return하면 Linux CI에서 "통과"가 미측정을 가린다 — 두 FS 모두 거부를 단정한다(축마다 기대 가드가 다르다).
      const caseInsensitive = existsSync(caseKey);
      const v = JSON.parse(s0) as { projects: Record<string, unknown> };
      v.projects[caseKey] = v.projects[dirA];
      s0 = JSON.stringify(v, null, 2);
      writeFileSync(jsonAbs, s0, "utf8");
      const err = await refusal(runMcpToggle({ op: "disable", assetId: "user-srv", project: caseKey }));
      expect(err.guard).toBe(caseInsensitive ? "key_case_differs" : "key_not_on_disk");
      expectNoWrite(0);
    });

    it("키가 저장소 루트의 하위 디렉터리면 거부(위쪽에 .git)", async () => {
      const sub = path.join(dirA, "sub");
      mkdirSync(sub);
      const v = JSON.parse(s0) as { projects: Record<string, unknown> };
      v.projects[sub] = v.projects[dirA];
      s0 = JSON.stringify(v, null, 2);
      writeFileSync(jsonAbs, s0, "utf8");
      const err = await refusal(runMcpToggle({ op: "disable", assetId: "user-srv", project: sub }));
      expect(err.guard).toBe("git_root_above_key");
      expectNoWrite(0);
    });

    it("$HOME에 .git이 있고 그 아래 비-저장소 프로젝트 키면 거부 — 가장 가까운 .git 규칙", async () => {
      mkdirSync(path.join(ctkHome, ".git")); // dotfiles 저장소 흉내
      const plain = path.join(ctkHome, "plain");
      mkdirSync(plain);
      const v = JSON.parse(s0) as { projects: Record<string, unknown> };
      v.projects[plain] = v.projects[dirA];
      s0 = JSON.stringify(v, null, 2);
      writeFileSync(jsonAbs, s0, "utf8");
      const err = await refusal(runMcpToggle({ op: "disable", assetId: "user-srv", project: plain }));
      expect(err.guard).toBe("git_root_above_key");
      expectNoWrite(0);
    });

    it("worktree의 .git *파일*도 저장소 루트다: 그 하위는 거부, 루트 자신은 허용", async () => {
      const wt = path.join(root, "wt");
      mkdirSync(path.join(wt, "deep"), { recursive: true });
      writeFileSync(path.join(wt, ".git"), "gitdir: /synthetic/elsewhere\n", "utf8");
      const v = JSON.parse(s0) as { projects: Record<string, unknown> };
      v.projects[wt] = v.projects[dirA];
      v.projects[path.join(wt, "deep")] = v.projects[dirA];
      s0 = JSON.stringify(v, null, 2);
      writeFileSync(jsonAbs, s0, "utf8");
      const err = await refusal(runMcpToggle({ op: "disable", assetId: "user-srv", project: path.join(wt, "deep") }));
      expect(err.guard).toBe("git_root_above_key");
      expectNoWrite(0);
      expect((await runMcpToggle({ op: "disable", assetId: "user-srv", project: wt })).outcome).toBe("applied");
    });

    it("선택자가 없으면 cwd의 하위 디렉터리에서도 git 루트 키를 고른다(반대 축: 쓰기가 일어난다)", async () => {
      const sub = path.join(dirA, "deep", "er");
      mkdirSync(sub, { recursive: true });
      const summary = await runMcpToggle({ op: "disable", assetId: "user-srv", cwd: sub });
      expect(summary.projectHash8).toBe(hashPath(dirA).slice(0, 8));
      expect((JSON.parse(readJson()) as { projects: Record<string, { disabledMcpServers?: string[] }> }).projects[dirA]!.disabledMcpServers).toEqual(["user-srv"]);
    });
  });

  describe("적격성 거부 — 사유(guard)와 hint, 쓰기 0", () => {
    it.each([
      ["claude.ai 커넥터", "claude.ai Foo", "connector_or_builtin"],
      ["computer-use", "computer-use", "connector_or_builtin"],
      ["카탈로그에 없는 id", "nonexistent-srv", "not_mcp"],
      ["MCP가 아닌 자산", PLUGIN, "not_mcp"],
    ])("%s", async (_l, assetId, reason) => {
      const err = await refusal(toggle("disable", assetId));
      expect(err.guard).toBe(reason);
      expect(err.message.length).toBeGreaterThan(10); // hint가 사유를 설명한다
      expectNoWrite(0);
      expect(runLogs("mcp").at(-1)).toMatchObject({ exit_code: 1, failure_class: "mcp_toggle_refused", args: { guard: reason, outcome: "refused", journal_written: false } });
    });

    it("다른 프로젝트의 local 서버를 이 프로젝트에서 끄려 하면 거부", async () => {
      const err = await refusal(toggle("disable", "local-srv", dirB));
      expect(err.guard).toBe("not_defined_for_project");
      expectNoWrite(0);
    });

    it("다른 머신의 Installation 행은 판정 입력에서 걸러진다 — 걸러지지 않으면 B에서 local-srv가 통과한다", async () => {
      hooks.foreignRows = [
        { schema_version: 1, _scope: "machine_dependent", asset_id: "local-srv", machine_id: "foreign-machine", install_scope: "user", enabled_at: null, project_path_hash: null, mcp_enabled_state: null, mcp_state_source: null },
      ];
      const err = await refusal(toggle("disable", "local-srv", dirB));
      expect(err.guard).toBe("not_defined_for_project");
      expectNoWrite(0);
    });

    it(".mcp.json 서버는 허용하되 op별 승인 경고를 낸다(disable은 Pending 문구, enable은 거부 문구)", async () => {
      const hash8 = hashPath(dirA).slice(0, 8);
      const off = await ctk("mcp", "disable", "--asset", "pend-srv", "--project-hash", hash8);
      expect(off.exitCode).toBe(0);
      expect(off.out).toContain("끈 서버는 세션이 띄우지 않는다");
      expect(off.out).toContain("Pending");
      expect(off.out).not.toContain("Rejected");
      const on = await ctk("mcp", "enable", "--asset", "pend-srv", "--project-hash", hash8);
      expect(on.exitCode).toBe(0);
      expect(on.out).toContain("Rejected");
      expect(on.out).not.toContain("Pending");
    });

    it(".mcp.json 정의가 아닌(user) 서버는 두 승인 경고를 모두 내지 않는다(반대 축)", async () => {
      const hash8 = hashPath(dirA).slice(0, 8);
      const off = await ctk("mcp", "disable", "--asset", "user-srv", "--project-hash", hash8);
      expect(off.exitCode).toBe(0);
      const on = await ctk("mcp", "enable", "--asset", "user-srv", "--project-hash", hash8);
      expect(on.exitCode).toBe(0);
      for (const out of [off.out, on.out]) {
        expect(out).not.toContain("Pending");
        expect(out).not.toContain("Rejected");
      }
    });

    describe("깨진 .mcp.json은 '파일 없음'이 아니다", () => {
      const mcpJsonOfA = () => path.join(dirA, ".mcp.json");

      it("읽을 수 없으면(깨진 JSON) mcp_json_unreadable로 거부한다 — not_defined_for_project가 아니다", async () => {
        writeFileSync(mcpJsonOfA(), "{not json", "utf8");
        const err = await refusal(toggle("disable", "pend-srv"));
        expect(err.guard).toBe("mcp_json_unreadable");
        expect(err.message).toContain(".mcp.json");
        expectNoWrite(0);
      });

      it("디렉터리가 .mcp.json 자리에 있어도(EISDIR) 같은 사유로 거부한다", async () => {
        rmSync(mcpJsonOfA());
        mkdirSync(mcpJsonOfA());
        const err = await refusal(toggle("enable", "pend-srv"));
        expect(err.guard).toBe("mcp_json_unreadable");
        expectNoWrite(0);
      });

      it("반대 축 — 읽을 수 있는 파일에 그 이름이 없으면 그대로 not_defined_for_project", async () => {
        writeFileSync(mcpJsonOfA(), JSON.stringify({ mcpServers: { other: { command: "echo" } } }), "utf8");
        const err = await refusal(toggle("disable", "pend-srv"));
        expect(err.guard).toBe("not_defined_for_project");
      });

      it("반대 축 — 깨진 파일은 그 프로젝트에만 걸린다(다른 프로젝트는 not_defined_for_project 그대로)", async () => {
        writeFileSync(mcpJsonOfA(), "{not json", "utf8");
        const err = await refusal(toggle("disable", "pend-srv", dirB));
        expect(err.guard).toBe("not_defined_for_project");
      });

      it("ctk scan은 죽지 않고 해시 접두만 경고한다(경로 없음) — 파일 없음(ENOENT)은 경고 없음", async () => {
        const clean = await runScan({ spawnFn: fakeSpawn("[]") });
        expect(clean.warnings.join(" ")).not.toContain(".mcp.json");
        writeFileSync(mcpJsonOfA(), "{not json", "utf8");
        const broken = await runScan({ spawnFn: fakeSpawn("[]") });
        const text = broken.warnings.join(" ");
        expect(text).toContain(".mcp.json");
        expect(text).toContain(`#${hashPath(dirA).slice(0, 8)}`);
        expect(text).not.toContain(dirA);
        expect(text).not.toContain(root);
      });
    });

    it("플러그인 서버: 부모가 다른 프로젝트의 local 스코프에만 설치돼 있으면 거부, user 스코프면 `plugin:<이름>:<서버>`로 적용", async () => {
      writeRegistry("local", dirB);
      const err = await refusal(toggle("disable", PLUGIN_CHILD, dirA));
      expect(err.guard).toBe("plugin_not_installed_for_project");
      expectNoWrite(0);

      writeRegistry("user");
      expect((await toggle("disable", PLUGIN_CHILD, dirA)).outcome).toBe("applied");
      expect(parseClaudeJsonFile(JSON.parse(readJson())).projects?.[dirA]?.disabledMcpServers).toEqual(["plugin:plug:plug-srv"]);
      await toggle("enable", PLUGIN_CHILD, dirA);
      expect(readJson()).toBe(s0);
    });
  });

  it("(8) journal을 쓸 수 없으면 파일은 이미 바뀐 채 journal_write_failed — 역방향 명령을 직접 출력하고 run-log가 사실대로 남는다", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root는 권한 검사를 우회한다
    mkdirSync(path.join(catalogPath, "journal"), { recursive: true });
    chmodSync(path.join(catalogPath, "journal"), 0o500);

    const run = await ctk("mcp", "disable", "--asset", "user-srv", "--project-hash", hashPath(dirA).slice(0, 8));

    expect(run.exitCode).toBe(1);
    expect(run.out).toContain("journal_write_failed");
    expect(run.out).toContain(`ctk mcp enable --asset user-srv --project-hash ${hashPath(dirA)}`);
    expect(run.out).not.toContain(root); // 절대 백업 경로 금지
    expect(readJson()).not.toBe(s0);
    chmodSync(path.join(catalogPath, "journal"), 0o700);
    expect(journalFiles()).toHaveLength(0);
    expect(runLogs("mcp").at(-1)).toMatchObject({
      exit_code: 1,
      failure_class: "journal_write_failed",
      args: { op: "disable", asset_id: "user-srv", project_path_hash: hashPath(dirA), outcome: "applied", guard: null, concurrent_write_observed: false, journal_written: false },
    });
  });

  it("출력에 절대 경로(백업 포함)가 없다 — 홈 상대 참조만", async () => {
    const run = await ctk("mcp", "disable", "--asset", "user-srv", "--project-hash", hashPath(dirA).slice(0, 8));
    expect(run.exitCode).toBe(0);
    expect(run.out).toContain("백업: ~/.ctk-backups/");
    expect(run.out).toContain("재시작");
    expect(run.out).not.toContain(root);
  });

  it("`ctk mcp` 단독은 인덱스 없는 `hash8  이름` 목록을 낸다", async () => {
    const run = await ctk("mcp");
    expect(run.exitCode).toBe(0);
    const lines = run.out.split("\n");
    expect(lines).toContain(`${hashPath(dirA).slice(0, 8)}  proj-a`);
    expect(lines).toContain(`${hashPath(dirB).slice(0, 8)}  proj-b`);
    expect(run.out).not.toContain(root);
    expect(lines.every((l) => /^[0-9a-f]{8} {2}\S/.test(l))).toBe(true);
  });

  it("`ctk mcp` 단독 — 알려진 프로젝트가 0건이면 빈 출력 대신 0건을 말로 적는다", async () => {
    writeFileSync(jsonAbs, JSON.stringify({ projects: {} }, null, 2), "utf8");
    const run = await ctk("mcp");
    expect(run.exitCode).toBe(0);
    expect(run.out).toContain("알려진 프로젝트가 없다");
  });

  it.each([
    [["mcp", "toggle", "--asset", "user-srv"]],
    [["mcp", "disable"]],
    [["mcp", "disable", "--asset", "user-srv", "--project-hash"]],
    [["mcp", "disable", "--asset", "user-srv", "--project", "--asset"]],
    [["mcp", "disable", "--asset", "user-srv", "--project=/synthetic/x"]], // `--x=y` 형태는 무시되면 cwd 프로젝트로 바뀐다
    [["mcp", "disable", "--asset=user-srv"]],
    [["mcp", "disable", "--asset", "user-srv", "--projet", "x"]], // 오타
    [["mcp", "disable", "--asset", "user-srv", "--asset", "other-srv"]], // 반복
    [["mcp", "disable", "--asset", "user-srv", "--project-hash", "abcd1234", "--project-hash", "abcd1234"]],
    [["mcp", "disable", "--asset", "user-srv", "extra"]], // 위치 인자
    [["mcp", "disable", "user-srv"]],
  ])("잘못된 사용은 사용법을 내고 쓰지 않는다: %j", async (args) => {
    const run = await ctk(...args);
    expect(run.exitCode).toBe(1);
    expect(run.out).toContain("사용법: ctk mcp");
    expectNoWrite(0);
  });

  it.each([
    [["move", "--asset", "x", "--to", "project", "--project-index", "0", "--form", "project"]], // `--from` 오타 → user로 조용히 바뀌던 모양
    [["move", "--asset", "x", "--to=user"]],
    [["move", "--asset", "x", "--to", "user", "--to", "project"]],
    [["move", "--asset", "x", "--to", "user", "stray"]],
  ])("move도 알 수 없는 플래그·반복·위치 인자는 사용법으로 거부한다: %j", async (args) => {
    const run = await ctk(...args);
    expect(run.exitCode).toBe(1);
    expect(run.out).toContain("사용법: ctk move");
    expectNoWrite(0);
  });

  describe("카탈로그 인덱스 행은 신뢰하지 않는다", () => {
    const indexAbs = () => path.join(catalogPath, "catalog", "index.json");
    const tamper = (id: string, patch: Record<string, unknown>) => {
      const idx = JSON.parse(readFileSync(indexAbs(), "utf8")) as { assets: Record<string, unknown>[] };
      Object.assign(idx.assets.find((a) => a["id"] === id)!, patch);
      writeFileSync(indexAbs(), JSON.stringify(idx), "utf8");
    };

    it("F-1 독립 서버: id와 name이 다른 행은 거부 — 다른 서버를 쓰고 id를 보고하지 않는다", async () => {
      tamper("user-srv", { name: "other-srv" });
      const err = await refusal(toggle("disable", "user-srv"));
      expect(err.guard).toBe("index_name_mismatch");
      expect(err.message).toContain("ctk scan");
      expectNoWrite(0);
    });

    it("F-1 번들 서버: id가 `<부모>:mcp:<name>`이 아니면 거부", async () => {
      tamper(PLUGIN_CHILD, { name: "other-srv" });
      const err = await refusal(toggle("disable", PLUGIN_CHILD));
      expect(err.guard).toBe("index_name_mismatch");
      expectNoWrite(0);
    });

    it("F-6 인덱스가 손상됐으면 '없음'이 아니라 분류된 거부(index_corrupted)", async () => {
      writeFileSync(indexAbs(), "{not json", "utf8");
      const err = await refusal(toggle("disable", "user-srv"));
      expect(err.guard).toBe("index_corrupted");
      expectNoWrite(0);
    });

    it("F-3 부모 id의 ESC·OSC가 힌트로 stderr에 닿기 전에 걷힌다(그리고 힌트 자체는 실제로 출력된다)", async () => {
      const parent = "evil\u001b]0;pwned\u0007@mkt";
      tamper(PLUGIN_CHILD, { id: `${parent}:mcp:plug-srv`, parent_asset_id: parent });
      const run = await ctk("mcp", "disable", "--asset", `${parent}:mcp:plug-srv`, "--project-hash", hashPath(dirA).slice(0, 8));
      expect(run.exitCode).toBe(1);
      expect(run.out).toContain("설치돼 있지 않다");
      expect(run.out).not.toMatch(/[\u001b\u0007]/);
    });
  });

  it("F-4 설치 디렉터리의 .mcp.json을 못 읽으면 synced가 아닌 plugin_manifest_unmeasured로 거부한다", async () => {
    writeFileSync(path.join(ctkHome, ".claude", "plugins", "cache", "mkt", "plug", "1.0.0", ".mcp.json"), "{not json", "utf8");
    const err = await refusal(toggle("disable", PLUGIN_CHILD));
    expect(err.guard).toBe("plugin_manifest_unmeasured");
    expect(err.message).toContain(".mcp.json");
    expectNoWrite(0);
  });

  it("F-5 journal은 썼는데 커밋이 던지면 journal_written:true + journal_commit_failed — 파일·역방향 명령·run-log가 사실대로", async () => {
    hooks.commitThrows = true;
    const run = await ctk("mcp", "disable", "--asset", "user-srv", "--project-hash", hashPath(dirA).slice(0, 8));
    hooks.commitThrows = false;
    expect(run.exitCode).toBe(1);
    expect(run.out).toContain("journal_commit_failed");
    expect(run.out).toContain(`ctk mcp enable --asset user-srv --project-hash ${hashPath(dirA)}`);
    expect(readJson()).not.toBe(s0);
    expect(journalFiles()).toHaveLength(1);
    expect(runLogs("mcp").at(-1)).toMatchObject({ exit_code: 1, failure_class: "journal_commit_failed", args: { outcome: "applied", journal_written: true } });
  });

  it("I-2 토글 롤백 거부는 CLI 출력에 failure_class를 싣는다", async () => {
    await toggle("disable", "user-srv");
    const run = await ctk("rollback", "--last");
    expect(run.exitCode).toBe(1);
    expect(run.out).toContain("FAIL mcp_toggle_refused:");
    expect(run.out).toContain("되돌리려면: ctk mcp enable");
  });

  it("동시 쓰기 관측 줄과 Pending 경고는 요약에 실린다", () => {
    const lines = formatMcpToggleSummary({ outcome: "applied", op: "disable", assetId: "x", projectHash8: "abcd1234", backupRef: "~/.ctk-backups/r", pendingApproval: true, concurrentWriteObserved: true, inverseCommand: "ctk mcp enable --asset x --project-hash h", warnings: [] }).join("\n");
    expect(lines).toContain("다른 세션이 .claude.json의 다른 부분도 바꿨다");
    expect(lines).toContain("Pending");
    expect(lines).toContain("끈 서버는 세션이 띄우지 않는다");
    expect(lines).not.toContain("Rejected");
    expect(lines).toContain("재시작");
    const enableLines = formatMcpToggleSummary({ outcome: "applied", op: "enable", assetId: "x", projectHash8: "abcd1234", backupRef: "~/.ctk-backups/r", pendingApproval: true, concurrentWriteObserved: false, inverseCommand: "ctk mcp disable --asset x --project-hash h", warnings: [] }).join("\n");
    expect(enableLines).toContain("Rejected");
    expect(enableLines).not.toContain("Pending");
  });

  it("마지막 — 카탈로그 파일·git 이력·화면 출력 어디에도 임시 HOME 경로(및 mkdtemp 접미사)가 없다", async () => {
    await toggle("disable", "user-srv");
    await toggle("enable", "user-srv");
    await toggle("enable", "user-srv"); // noop
    await refusal(toggle("disable", "claude.ai Foo"));
    await refusal(runMcpToggle({ op: "disable", assetId: "user-srv", projectHash: "zz" }));
    // 화면 경로: 거부·적용·롤백 거부가 stdout/stderr로 내는 문자열도 같은 검사를 받는다.
    const screens = [
      await ctk("mcp", "disable", "--asset", "claude.ai Foo", "--project-hash", hashPath(dirA).slice(0, 8)),
      await ctk("mcp", "disable", "--asset", "user-srv", "--project-hash", hashPath(dirA).slice(0, 8)),
      await ctk("rollback", "--last"),
    ];
    expect(screens[0]!.exitCode).toBe(1);

    // `/var/...`와 `/private/var/...` 두 표기 모두 잡히도록 경로 전체가 아니라 mkdtemp 접미사로 찾는다.
    const needles = [root, path.basename(root)];
    const hits: string[] = [];
    const scan = (label: string, bytes: Buffer | string) => {
      for (const n of needles) if (bytes.toString().includes(n)) hits.push(`${label}:${n === root ? "root" : "basename"}`);
    };
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const abs = path.join(dir, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else scan(path.relative(catalogPath, abs), readFileSync(abs));
      }
    };
    walk(catalogPath);
    scan("git-log", execFileSync("git", ["-C", catalogPath, "log", "--format=%B"], { encoding: "utf8" }));
    screens.forEach((sc, i) => scan(`screen-${i}`, sc.out));
    expect(hits).toEqual([]);
    expect(journalFiles().length).toBeGreaterThan(0);
    expect(runLogs("mcp").length).toBeGreaterThanOrEqual(3); // run-log 파일명은 ms 단위 타임스탬프라 같은 ms의 두 기록은 합쳐질 수 있다(기존 규약)
    expect(readLocalConfig(resolveHomeContext())!.catalog_path.startsWith(root)).toBe(true);
    expect(readOrCreateMachineIdentity(resolveHomeContext(), "local-machine").machine_id.length).toBeGreaterThan(0);
  });
});

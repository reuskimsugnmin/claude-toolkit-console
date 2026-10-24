import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeJsonPath, resolveHomeContext, type HomeContext } from "@ctk/probe";
import { readFixture } from "../../core/test/support/fixtures.js";

/**
 * 프로덕션 형태 — `CTK_CONFIG_DIR` 미설정이라 실제 파일은 `$HOME/.claude.json`이고, `$HOME/.claude/.claude.json`은
 * 내용이 다른 **별개** 파일(미끼)이다. 모든 경로는 임시 디렉터리다(`CTK_HOME`) — 실제 홈을 건드리지 않는다.
 * 모든 거부·중단 테스트가 **guard · outcome · 파일 바이트 · 백업 런 디렉터리 유무** 네 가지를 함께 본다.
 */
const hooks = vi.hoisted(() => ({
  backupThrows: false,
  beginThrows: false,
  /** 설정되면 beginBackupRun이 이 경로를 백업 런 디렉터리로 돌려준다(백업 루트 **밖**) — 삭제 경로 검증용. */
  backupRootOverride: undefined as string | undefined,
}));

vi.mock("../src/backup.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/backup.js")>();
  return {
    ...real,
    beginBackupRun: (...args: Parameters<typeof real.beginBackupRun>) => {
      if (hooks.beginThrows) throw new Error("beginBackupRun forced throw");
      return hooks.backupRootOverride !== undefined ? { backupRoot: hooks.backupRootOverride } : real.beginBackupRun(...args);
    },
    backupFile: (...args: Parameters<typeof real.backupFile>) => {
      if (hooks.backupThrows) throw new Error("backupFile forced throw");
      return real.backupFile(...args);
    },
  };
});

const { applyMcpToggle, applyMcpToggleWithSeam, isOwnedByCurrentUser, McpToggleClobberedError } = await import("../src/apply/mcp-toggle.js");

const KEY = "/synthetic/projects/alpha";
const NAME = "synthetic-echo";
const S0 = readFixture("claude-json/real-cli-add-json.json"); // 실제 CLI 산출물(비식별화) — 왕복 전제를 실제 서식으로 태운다.

/** S0에서 그 키의 disabledMcpServers만 `list`로 바꾼 바이트(기대값은 판정 코드를 거치지 않고 따로 만든다). */
function withList(base: string, list: string[] | null): string {
  const v = JSON.parse(base) as { projects: Record<string, Record<string, unknown>> };
  if (list === null) delete v.projects[KEY]!.disabledMcpServers;
  else v.projects[KEY]!.disabledMcpServers = list;
  return JSON.stringify(v, null, 2);
}
/** 다른 세션이 파일의 다른 부분을 바꾼 것을 흉내 낸다(최상위 키 하나 추가). */
function withChurn(base: string): string {
  const v = JSON.parse(base) as Record<string, unknown>;
  v["numStartups"] = 7;
  return JSON.stringify(v, null, 2);
}

describe("actuator/apply/mcp-toggle — 프로덕션 형태(CTK_CONFIG_DIR 미설정)", () => {
  let root: string;
  let ctkHome: string;
  let home: HomeContext;
  let realAbs: string;
  let decoyAbs: string;
  const DECOY = '{"decoy":true}';
  let saved: { CTK_HOME?: string; CTK_CONFIG_DIR?: string };

  const req = (op: "disable" | "enable" = "disable") => ({ home, projectKey: KEY, name: NAME, op });
  const read = () => readFileSync(realAbs, "utf8");
  const backupsRoot = () => path.join(ctkHome, ".ctk-backups");
  const runDirs = () => (existsSync(backupsRoot()) ? readdirSync(backupsRoot()) : []);
  const tmpLeftovers = () => readdirSync(ctkHome).filter((n) => n.includes(".tmp."));

  beforeEach(() => {
    saved = { CTK_HOME: process.env.CTK_HOME, CTK_CONFIG_DIR: process.env.CTK_CONFIG_DIR };
    root = mkdtempSync(path.join(tmpdir(), "ctk-mcp-toggle-"));
    ctkHome = path.join(root, "home");
    mkdirSync(path.join(ctkHome, ".claude"), { recursive: true });
    process.env.CTK_HOME = ctkHome;
    delete process.env.CTK_CONFIG_DIR;
    home = resolveHomeContext();
    realAbs = claudeJsonPath(home);
    decoyAbs = path.join(ctkHome, ".claude", ".claude.json");
    writeFileSync(realAbs, S0, "utf8");
    writeFileSync(decoyAbs, DECOY, "utf8");
    hooks.backupThrows = false;
    hooks.beginThrows = false;
    hooks.backupRootOverride = undefined;
  });
  afterEach(() => {
    chmodSync(ctkHome, 0o700); // 읽기 전용 테스트가 남긴 권한을 풀고 지운다.
    rmSync(root, { recursive: true, force: true });
    for (const k of ["CTK_HOME", "CTK_CONFIG_DIR"] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("전제: 테스트 홈은 임시 경로이고 실제 파일 ≠ 미끼 파일이다", () => {
    expect(realAbs).toBe(path.join(ctkHome, ".claude.json"));
    expect(realAbs.startsWith(root)).toBe(true);
    expect(decoyAbs).not.toBe(realAbs);
    expect(read()).not.toBe(readFileSync(decoyAbs, "utf8"));
  });

  describe("반대 축 — 주입 없는 같은 설정은 applied", () => {
    it("disable: 정확히 그 키의 목록만 바뀌고, 백업은 S0이며, 미끼는 그대로", () => {
      const r = applyMcpToggle(req());
      expect(r).toMatchObject({ outcome: "applied", before: [], after: [NAME], concurrentWriteObserved: false });
      expect(read()).toBe(withList(S0, [NAME]));
      expect(runDirs()).toHaveLength(1);
      if (r.outcome !== "applied") return;
      const manifest = JSON.parse(readFileSync(path.join(r.backupRoot, "manifest.json"), "utf8")) as { entries: Record<string, { storedRelPath: string }> };
      expect(readFileSync(path.join(r.backupRoot, manifest.entries["config_claude_json"]!.storedRelPath), "utf8")).toBe(S0);
      expect(readFileSync(decoyAbs, "utf8")).toBe(DECOY);
      expect(tmpLeftovers()).toEqual([]);
    });
    it("disable 뒤 enable → 바이트가 S0과 같다(목록 키를 이미 가진 S0)", () => {
      const s0WithList = withList(S0, []);
      writeFileSync(realAbs, s0WithList, "utf8");
      expect(applyMcpToggle(req("disable")).outcome).toBe("applied");
      expect(applyMcpToggle(req("enable"))).toMatchObject({ outcome: "applied", before: [NAME], after: [] });
      expect(read()).toBe(s0WithList);
      expect(runDirs()).toHaveLength(2);
    });
    // 결정(코디네이터): 키가 없던 파일에서 disable→enable하면 `"disabledMcpServers": []`를 남긴다. 하네스는 빈 목록을 부재와 같게
    // 읽는다(F1). 부재를 되살리는 것은 추측이라 하지 않는다 — 바이트가 S0과 달라지는 것이 의도된 동작이다(Step 6에 문서화).
    it("실제 CLI 픽스처(목록 키 없음)는 disable 뒤 enable하면 `disabledMcpServers: []`가 남는다 — 의미는 같고 바이트는 다르다", () => {
      applyMcpToggle(req("disable"));
      applyMcpToggle(req("enable"));
      expect(read()).toBe(withList(S0, []));
      expect(read()).not.toBe(S0);
    });
  });

  describe("noop", () => {
    it("이미 disable인 것을 disable, 없는 것을 enable → noop, 백업 런 없음, 바이트 불변", () => {
      expect(applyMcpToggle(req("enable"))).toEqual({ outcome: "noop" });
      expect(runDirs()).toEqual([]);
      expect(read()).toBe(S0);
      applyMcpToggle(req("disable"));
      const after = read();
      const runsBefore = runDirs().length;
      expect(applyMcpToggle(req("disable"))).toEqual({ outcome: "noop" });
      expect(runDirs()).toHaveLength(runsBefore);
      expect(read()).toBe(after);
    });
  });

  describe("① lstat", () => {
    it("파일 부재 → refused lstat_absent (미끼 파일은 쓰이지 않는다)", () => {
      rmSync(realAbs);
      expect(applyMcpToggle(req())).toMatchObject({ outcome: "refused", failureClass: "mcp_toggle_refused", guard: "lstat_absent" });
      expect(existsSync(realAbs)).toBe(false);
      expect(readFileSync(decoyAbs, "utf8")).toBe(DECOY);
      expect(runDirs()).toEqual([]);
    });
    it("시작 시 하드링크 → refused hardlink — rename 쓰기가 링크를 끊지 않게 쓰기 0건", () => {
      const twin = path.join(root, "dotfiles-claude.json");
      linkSync(realAbs, twin);
      expect(applyMcpToggle(req())).toMatchObject({ outcome: "refused", failureClass: "mcp_toggle_refused", guard: "hardlink" });
      expect(lstatSync(realAbs).nlink).toBe(2);
      expect(read()).toBe(S0);
      expect(runDirs()).toEqual([]);
    });
    it("시작 시 심볼릭 링크 → refused lstat_type, 링크·대상 불변", () => {
      const target = path.join(root, "elsewhere.json");
      writeFileSync(target, S0, "utf8");
      rmSync(realAbs);
      symlinkSync(target, realAbs);
      expect(applyMcpToggle(req())).toMatchObject({ outcome: "refused", failureClass: "mcp_toggle_refused", guard: "lstat_type" });
      expect(lstatSync(realAbs).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe(S0);
      expect(runDirs()).toEqual([]);
    });
  });

  describe("③ 왕복 전제", () => {
    it("끝 개행이 있는 파일 → format_unrecognized round_trip, 백업 런 없음, 바이트 불변", () => {
      writeFileSync(realAbs, `${S0}\n`, "utf8");
      expect(applyMcpToggle(req())).toMatchObject({ outcome: "refused", failureClass: "claude_json_format_unrecognized", guard: "round_trip" });
      expect(read()).toBe(`${S0}\n`);
      expect(runDirs()).toEqual([]);
    });
    it("잘못된 UTF-8 바이트(문자열 왕복은 통과) → 바이트 수준에서 round_trip으로 거부, 바이트 불변", () => {
      const bad = Buffer.concat([Buffer.from(S0.replace('"command": "echo"', '"command": "echo~~"'), "utf8")]);
      const at = bad.indexOf(Buffer.from("~~"));
      const withInvalid = Buffer.concat([bad.subarray(0, at), Buffer.from([0xff]), bad.subarray(at + 2)]);
      writeFileSync(realAbs, withInvalid);
      expect(applyMcpToggle(req())).toMatchObject({ outcome: "refused", failureClass: "claude_json_format_unrecognized", guard: "round_trip", detail: "utf8" });
      expect(readFileSync(realAbs).equals(withInvalid)).toBe(true);
      expect(runDirs()).toEqual([]);
    });
    it("프로젝트 키 부재 → refused plan (project_key_absent)", () => {
      const r = applyMcpToggle({ ...req(), projectKey: "/synthetic/projects/none" });
      expect(r).toMatchObject({ outcome: "refused", failureClass: "mcp_toggle_refused", guard: "plan", detail: "project_key_absent" });
      expect(read()).toBe(S0);
      expect(runDirs()).toEqual([]);
    });
  });

  describe("④ 판정", () => {
    it("플래너 결함(afterPlan이 이름을 하나 더 얹음) → refused forbidden_path_write verdict, 백업 런 없음", () => {
      const r = applyMcpToggleWithSeam(req(), { afterPlan: (next) => next.replace(`"${NAME}"`, `"${NAME}", "extra"`) });
      expect(r).toMatchObject({ outcome: "refused", failureClass: "forbidden_path_write", guard: "verdict" });
      expect(read()).toBe(S0);
      expect(runDirs()).toEqual([]);
    });
    it("플래너 결함(afterPlan이 다른 키를 함께 바꿈) → verdict", () => {
      const r = applyMcpToggleWithSeam(req(), { afterPlan: (next) => withChurn(next) });
      expect(r).toMatchObject({ outcome: "refused", guard: "verdict" });
      expect(read()).toBe(S0);
      expect(runDirs()).toEqual([]);
    });
  });

  describe("④ 정본 직렬화", () => {
    it("같은 값의 minified JSON을 쓰려 하면 → refused forbidden_path_write verdict next_not_canonical, 백업 런 없음", () => {
      const r = applyMcpToggleWithSeam(req(), { afterPlan: (next) => JSON.stringify(JSON.parse(next)) });
      expect(r).toMatchObject({ outcome: "refused", failureClass: "forbidden_path_write", guard: "verdict", detail: "next_not_canonical" });
      expect(read()).toBe(S0);
      expect(runDirs()).toEqual([]);
    });
  });

  describe("L4 소유자", () => {
    it("파일 소유자가 현재 사용자가 아니면 거부 대상이다(순수 술어 — chown은 root만 가능해 가짜 stat으로 태운다)", () => {
      expect(isOwnedByCurrentUser({ uid: 501 }, 501)).toBe(true);
      expect(isOwnedByCurrentUser({ uid: 0 }, 501)).toBe(false);
      expect(isOwnedByCurrentUser({ uid: 0 }, null)).toBe(true);
      expect(isOwnedByCurrentUser(lstatSync(realAbs))).toBe(true); // 실제 파일: 우리가 만들었다
    });
  });

  describe("⑤ 백업", () => {
    it("ABA: beforeBackup 변이 → 백업이 변이본을 복사 → beforeCas에서 S0 바이트로 복귀 → backup_sha (cas_sha는 통과하므로 이 가드만 막는다)", () => {
      const r = applyMcpToggleWithSeam(req(), {
        beforeBackup: () => writeFileSync(realAbs, withChurn(S0), "utf8"),
        beforeCas: () => writeFileSync(realAbs, S0, "utf8"),
      });
      expect(r).toMatchObject({ outcome: "aborted_unchanged", failureClass: "config_clobbered", guard: "backup_sha" });
      expect(read()).toBe(withChurn(S0)); // 가드가 beforeCas보다 앞이라 복귀 이음매는 돌지 않는다 — 가드가 없으면 복귀 후 CAS를 통과해 쓴다.
      expect(runDirs()).toHaveLength(1);
    });
    it("backupFile이 던지면 → aborted_unchanged backup_failed backup_threw, 그 런 디렉터리 제거, 바이트 불변", () => {
      hooks.backupThrows = true;
      const r = applyMcpToggle(req());
      expect(r).toMatchObject({ outcome: "aborted_unchanged", failureClass: "backup_failed", guard: "backup_threw", backupRunRemoved: true });
      expect(read()).toBe(S0);
      expect(runDirs()).toEqual([]);
    });
    it("beginBackupRun 자체가 던지면 지운 것이 없으므로 backupRunRemoved=false", () => {
      hooks.beginThrows = true;
      const r = applyMcpToggle(req());
      expect(r).toMatchObject({ outcome: "aborted_unchanged", failureClass: "backup_failed", guard: "backup_threw", backupRunRemoved: false, backupRoot: null });
      expect(read()).toBe(S0);
      expect(runDirs()).toEqual([]);
    });
    it("백업 루트 밖을 가리키는 런 경로는 지우지 않는다(경로 검증)", () => {
      const outside = path.join(root, "outside-run");
      mkdirSync(outside);
      writeFileSync(path.join(outside, "sentinel"), "keep", "utf8");
      hooks.backupRootOverride = outside;
      hooks.backupThrows = true;
      const r = applyMcpToggle(req());
      expect(r).toMatchObject({ outcome: "aborted_unchanged", guard: "backup_threw", backupRunRemoved: false });
      expect(readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("keep");
      expect(read()).toBe(S0);
    });
  });

  describe("⑥ CAS", () => {
    it("beforeCas에서 심볼릭 링크로 바꿔치기 → cas_lstat, 링크 대상(S0) 불변", () => {
      const moved = path.join(root, "moved.json");
      const r = applyMcpToggleWithSeam(req(), {
        beforeCas: () => {
          renameSync(realAbs, moved);
          symlinkSync(moved, realAbs);
        },
      });
      expect(r).toMatchObject({ outcome: "aborted_unchanged", failureClass: "config_clobbered", guard: "cas_lstat" });
      expect(lstatSync(realAbs).isSymbolicLink()).toBe(true);
      expect(readFileSync(moved, "utf8")).toBe(S0);
      expect(runDirs()).toHaveLength(1);
    });
    it("beforeCas 변이 → cas_sha, 바이트는 상대의 것 그대로", () => {
      const theirs = withChurn(S0);
      const r = applyMcpToggleWithSeam(req(), { beforeCas: () => writeFileSync(realAbs, theirs, "utf8") });
      expect(r).toMatchObject({ outcome: "aborted_unchanged", failureClass: "config_clobbered", guard: "cas_sha" });
      expect(read()).toBe(theirs);
      expect(runDirs()).toHaveLength(1);
    });
    it("beforeRename 변이는 CAS 뒤라 못 막는다 → applied, 상대의 변경은 사라진다(risk 7을 문서화)", () => {
      const r = applyMcpToggleWithSeam(req(), { beforeRename: () => writeFileSync(realAbs, withChurn(S0), "utf8") });
      expect(r).toMatchObject({ outcome: "applied", concurrentWriteObserved: false });
      expect(read()).toBe(withList(S0, [NAME]));
      expect(read()).not.toContain("numStartups");
    });
  });

  describe("⑦⑧ 쓰기와 사후 분류", () => {
    // root는 0o500 디렉터리에도 쓸 수 있어 이 시나리오가 성립하지 않는다 — 가짜로 통과시키지 않고 이유를 밝혀 건너뛴다.
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    it.skipIf(isRoot)("부모 디렉터리가 읽기 전용이라 rename 전에 던짐 → aborted_unchanged claude_json_write_failed write_not_applied, 바이트 불변", () => {
      const r = applyMcpToggleWithSeam(req(), { beforeRename: () => chmodSync(ctkHome, 0o500) });
      chmodSync(ctkHome, 0o700);
      expect(r).toMatchObject({ outcome: "aborted_unchanged", failureClass: "claude_json_write_failed", guard: "write_not_applied" });
      expect(read()).toBe(S0);
      expect(tmpLeftovers()).toEqual([]);
      expect(runDirs()).toHaveLength(1);
    });
    it.skipIf(isRoot)("L1: 던졌는데 S0도 우리 바이트도 아니면 → post_write_unmeasured (clobbered로 단정하지 않는다)", () => {
      const r = applyMcpToggleWithSeam(req(), {
        beforeRename: () => {
          writeFileSync(realAbs, withChurn(S0), "utf8");
          chmodSync(ctkHome, 0o500);
        },
      });
      chmodSync(ctkHome, 0o700);
      expect(r).toMatchObject({ outcome: "post_write_unmeasured", failureClass: "claude_json_post_write_unmeasured" });
      expect(read()).toBe(withChurn(S0));
    });
    it("L3 수용된 창: beforeRename에서 링크로 바꿔치기 → applied, 링크는 일반 파일로 교체되고 링크 대상은 건드리지 않는다(risk 7과 같은 창)", () => {
      const moved = path.join(root, "moved.json");
      const r = applyMcpToggleWithSeam(req(), {
        beforeRename: () => {
          renameSync(realAbs, moved);
          symlinkSync(moved, realAbs);
        },
      });
      expect(r).toMatchObject({ outcome: "applied" });
      expect(lstatSync(realAbs).isSymbolicLink()).toBe(false);
      expect(read()).toBe(withList(S0, [NAME]));
      expect(readFileSync(moved, "utf8")).toBe(S0);
    });
    it("afterRename이 잘못된 JSON을 쓰고 던짐 → post_write_unmeasured, 바이트는 그대로(두 번째 쓰기 없음)", () => {
      const r = applyMcpToggleWithSeam(req(), {
        afterRename: () => {
          writeFileSync(realAbs, "{not json", "utf8");
          throw new Error("injected");
        },
      });
      expect(r).toMatchObject({ outcome: "post_write_unmeasured", failureClass: "claude_json_post_write_unmeasured" });
      expect(read()).toBe("{not json");
    });
    it("던지지 않는 경로도 같은 분류기: afterWrite가 잘못된 JSON을 남김 → post_write_unmeasured", () => {
      const r = applyMcpToggleWithSeam(req(), { afterWrite: () => writeFileSync(realAbs, "{not json", "utf8") });
      expect(r.outcome).toBe("post_write_unmeasured");
      expect(read()).toBe("{not json");
    });
    it("afterRename이 던졌지만 파일은 우리 바이트 → applied (던진 경로의 분류)", () => {
      const r = applyMcpToggleWithSeam(req(), {
        afterRename: () => {
          throw new Error("injected");
        },
      });
      expect(r).toMatchObject({ outcome: "applied", concurrentWriteObserved: false });
      expect(read()).toBe(withList(S0, [NAME]));
    });
    it("afterWrite가 우리 변경은 두고 다른 키를 바꿈 → applied + concurrentWriteObserved, 이후 쓰지 않음", () => {
      const theirs = withChurn(withList(S0, [NAME]));
      const r = applyMcpToggleWithSeam(req(), { afterWrite: () => writeFileSync(realAbs, theirs, "utf8") });
      expect(r).toMatchObject({ outcome: "applied", concurrentWriteObserved: true });
      expect(read()).toBe(theirs);
    });
    it("afterWrite가 우리 변경을 지움 → clobbered_after_write, 바이트는 상대의 것 그대로(두 번째 쓰기 없음)", () => {
      const theirs = withChurn(S0);
      const r = applyMcpToggleWithSeam(req(), { afterWrite: () => writeFileSync(realAbs, theirs, "utf8") });
      expect(r).toMatchObject({ outcome: "clobbered_after_write", failureClass: "config_clobbered" });
      expect(read()).toBe(theirs);
      const err = new McpToggleClobberedError("cas_sha", false);
      expect(err.failureClass).toBe("config_clobbered");
      expect(err.message).not.toContain("복원 직전");
    });
  });
});

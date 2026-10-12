import { describe, expect, it } from "vitest";
import { AssetSchema, type Asset } from "../src/schema/asset.js";
import { InstallationSchema, type Installation } from "../src/schema/installation.js";
import { claudeJsonSemanticVerdict, maskedProjectPath } from "../src/guard/claude-json-semantic.js";
import { hashPath, matchHashPrefix } from "../src/snapshot/path-normalize.js";
import {
  isDisplayableAssetId,
  isExactMcpToggleVerdict,
  ownedSubtreeEquals,
  planMcpToggle,
  resolveMcpToggleTarget,
  serializeClaudeJson,
  type InstalledPluginRef,
  type McpToggleTargetInput,
} from "../src/mcp-toggle.js";
import { readFixture } from "./support/fixtures.js";

const P = "/synthetic/projects/alpha";
const ser = (v: unknown) => serializeClaudeJson(v);

describe("serializeClaudeJson + 실제 CLI 라운드트립", () => {
  /**
   * fixtures/claude-json/real-cli-add-json.json — 실제 CLI(2.1.296) 산출물을 비식별화한 것이다.
   * 생성(무료, 모델 호출 없음): 임시 디렉터리 T에서 `git init proj` 후 proj 안에서
   *   `env -i HOME=$T/home PATH="$PATH" claude mcp add-json synthetic-echo '{"type":"stdio","command":"echo"}' -s local`
   * (CLAUDE_CONFIG_DIR·CTK_* 미설정) → `$T/home/.claude.json`. 스크럽: 프로젝트 키(임시 realpath) →
   * `/synthetic/projects/alpha`, firstStartTime·machineID·userID → 같은 형의 합성값. 키 순서·서식은 그대로.
   */
  const raw = readFixture("claude-json/real-cli-add-json.json");
  it("serialize(parse(raw)) === raw (끝 개행 없음)", () => {
    expect(raw.endsWith("\n")).toBe(false);
    expect(ser(JSON.parse(raw))).toBe(raw);
  });
  it("그 파일에 대한 plan이 write로 나오고 다음 바이트도 라운드트립한다", () => {
    const plan = planMcpToggle(raw, P, "synthetic-echo", "disable");
    expect(plan.kind).toBe("write");
    if (plan.kind !== "write") return;
    expect(ser(JSON.parse(plan.nextRaw))).toBe(plan.nextRaw);
    // 키 순서 보존 + 새 키는 엔트리 끝에 추가
    const back = planMcpToggle(plan.nextRaw, P, "synthetic-echo", "enable");
    expect(back.kind).toBe("write");
    if (back.kind !== "write") return;
    expect(back.after).toEqual([]);
  });
  it("큰 정수는 재직렬화로 달라져 format_unrecognized + 첫 차이 오프셋", () => {
    const text = '{\n  "n": 12345678901234567890,\n  "projects": {}\n}';
    const plan = planMcpToggle(text, P, "x", "disable");
    expect(plan).toEqual({ kind: "format_unrecognized", offset: text.indexOf("12345678901234567890") + 17 });
  });
  it("끝 개행이 있으면 format_unrecognized (offset = 원문 길이 - 1)", () => {
    const text = `${raw}\n`;
    expect(planMcpToggle(text, P, "x", "disable")).toEqual({ kind: "format_unrecognized", offset: raw.length });
  });
  it("JSON이 아니면 not_json", () => {
    expect(planMcpToggle("{", P, "x", "disable")).toEqual({ kind: "refused", reason: "not_json" });
  });
});

describe("planMcpToggle", () => {
  const file = (entry: unknown, key = P) => ser({ numStartups: 1, projects: { [key]: entry } });
  it("disable 두 번째는 noop, enable 없는 이름은 noop (목록 부재 포함)", () => {
    expect(planMcpToggle(file({ disabledMcpServers: ["x"] }), P, "x", "disable")).toEqual({ kind: "noop" });
    expect(planMcpToggle(file({ disabledMcpServers: ["a"] }), P, "x", "enable")).toEqual({ kind: "noop" });
    expect(planMcpToggle(file({}), P, "x", "enable")).toEqual({ kind: "noop" });
  });
  it("마지막 이름을 enable하면 목록이 []로 남는다(키 삭제 아님)", () => {
    const plan = planMcpToggle(file({ disabledMcpServers: ["x"] }), P, "x", "enable");
    expect(plan).toEqual({ kind: "write", nextRaw: file({ disabledMcpServers: [] }), before: ["x"], after: [] });
  });
  it("disable은 끝에 추가하고 다른 키는 바이트 그대로다", () => {
    const plan = planMcpToggle(file({ k: 1, disabledMcpServers: ["a"], z: 2 }), P, "x", "disable");
    expect(plan).toMatchObject({ kind: "write", nextRaw: file({ k: 1, disabledMcpServers: ["a", "x"], z: 2 }) });
  });
  it("프로젝트 키가 없으면 project_key_absent — 엔트리를 만들지 않는다", () => {
    expect(planMcpToggle(file({}, "/synthetic/projects/other"), P, "x", "disable")).toEqual({ kind: "refused", reason: "project_key_absent" });
    expect(planMcpToggle(ser({ numStartups: 1 }), P, "x", "disable")).toEqual({ kind: "refused", reason: "project_key_absent" });
  });
  it('"__proto__"는 자기 키가 없으면 project_key_absent', () => {
    expect(planMcpToggle(file({}), "__proto__", "x", "disable")).toEqual({ kind: "refused", reason: "project_key_absent" });
  });
  it("엔트리가 객체가 아니거나 목록이 문자열 배열이 아니면 거부", () => {
    expect(planMcpToggle(file(null), P, "x", "disable")).toEqual({ kind: "refused", reason: "entry_not_object" });
    expect(planMcpToggle(file([]), P, "x", "disable")).toEqual({ kind: "refused", reason: "entry_not_object" });
    expect(planMcpToggle(file({ disabledMcpServers: "x" }), P, "x", "disable")).toEqual({ kind: "refused", reason: "list_not_string_array" });
    expect(planMcpToggle(file({ disabledMcpServers: ["a", 1] }), P, "x", "disable")).toEqual({ kind: "refused", reason: "list_not_string_array" });
  });
  it("plan이 만든 diff는 가드가 정확히 토글 하나로 통과시킨다(planner↔guard 결합)", () => {
    const rawText = file({ disabledMcpServers: ["a"] });
    const plan = planMcpToggle(rawText, P, "x", "disable");
    if (plan.kind !== "write") throw new Error("write 기대");
    const v = claudeJsonSemanticVerdict(JSON.parse(rawText), JSON.parse(plan.nextRaw), [], null, true, { projectKey: P, name: "x", op: "disable" });
    expect(isExactMcpToggleVerdict(v, P)).toBe(true);
  });
});

describe("ownedSubtreeEquals", () => {
  const v = { projects: { [P]: { disabledMcpServers: ["a", "b"] } } };
  it("순서까지 같을 때만 true", () => {
    expect(ownedSubtreeEquals(v, P, ["a", "b"])).toBe(true);
    expect(ownedSubtreeEquals(v, P, ["b", "a"])).toBe(false);
    expect(ownedSubtreeEquals(v, P, ["a"])).toBe(false);
  });
  it("키·목록 부재, 잘못된 형태는 false", () => {
    expect(ownedSubtreeEquals(v, "/synthetic/projects/other", [])).toBe(false);
    expect(ownedSubtreeEquals({ projects: { [P]: {} } }, P, [])).toBe(false);
    expect(ownedSubtreeEquals(null, P, [])).toBe(false);
    expect(ownedSubtreeEquals({ projects: { [P]: { disabledMcpServers: [1] } } }, P, [1 as unknown as string])).toBe(false);
  });
});

describe("isExactMcpToggleVerdict", () => {
  const toggle = { projectKey: P, name: "x", op: "disable" } as const;
  const before = { projects: { [P]: { disabledMcpServers: [] } }, pluginUsage: { "p@m": { lastUsedAt: 1, usageCount: 1 } } };
  it("토글 한 경로뿐이면 true", () => {
    const after = { projects: { [P]: { disabledMcpServers: ["x"] } }, pluginUsage: before.pluginUsage };
    expect(isExactMcpToggleVerdict(claudeJsonSemanticVerdict(before, after, [], null, true, toggle), P)).toBe(true);
  });
  it("살아 있는 세션의 pluginUsage churn이 같이 있으면 false (판정기는 그것을 허용하지만 '정확히 하나'가 아니다)", () => {
    const after = { projects: { [P]: { disabledMcpServers: ["x"] } }, pluginUsage: { "p@m": { lastUsedAt: 2, usageCount: 2 } } };
    const v = claudeJsonSemanticVerdict(before, after, [], null, true, toggle);
    expect(v.overallStatus).toBe("allowed_churn");
    expect(isExactMcpToggleVerdict(v, P)).toBe(false);
  });
  it("토글 경로가 첫 항목이어도 뒤에 다른 경로가 있으면 false (순서에 기대지 않는다)", () => {
    const togglePath = { path: maskedProjectPath(P, "disabledMcpServers"), status: "allowed_churn", mcpForbidden: false } as const;
    const live = { path: "pluginUsage", status: "allowed_churn", mcpForbidden: false } as const;
    expect(isExactMcpToggleVerdict({ changed: [togglePath], violations: [], overallStatus: "allowed_churn" }, P)).toBe(true);
    expect(isExactMcpToggleVerdict({ changed: [togglePath, live], violations: [], overallStatus: "allowed_churn" }, P)).toBe(false);
  });
  it("변경이 없거나(clean) 위반이 있으면 false", () => {
    expect(isExactMcpToggleVerdict(claudeJsonSemanticVerdict(before, before, [], null, true, toggle), P)).toBe(false);
    const bad = { projects: { [P]: { disabledMcpServers: ["x", "y"] } } };
    expect(isExactMcpToggleVerdict(claudeJsonSemanticVerdict(before, bad, [], null, true, toggle), P)).toBe(false);
  });
  it("다른 프로젝트 키의 경로면 false (경로는 maskedProjectPath 한 곳에서 나온다)", () => {
    const v = claudeJsonSemanticVerdict({ projects: { [P]: {} } }, { projects: { [P]: { disabledMcpServers: ["x"] } } }, [], null, true, toggle);
    expect(v.changed[0]?.path).toBe(maskedProjectPath(P, "disabledMcpServers"));
    expect(isExactMcpToggleVerdict(v, "/synthetic/projects/other")).toBe(false);
  });
});

describe("resolveMcpToggleTarget — 적격성 8거부 + 허용", () => {
  const H = hashPath(P);
  const OTHER = hashPath("/synthetic/projects/other");
  const asset = (o: Record<string, unknown>): Asset => AssetSchema.parse({ schema_version: 1, _scope: "machine_independent", kind: "mcp", ...o });
  const inst = (o: Record<string, unknown>): Installation =>
    InstallationSchema.parse({ schema_version: 1, _scope: "machine_dependent", machine_id: "m1", enabled_at: null, mcp_enabled_state: null, mcp_state_source: null, project_path_hash: null, ...o });
  const plugin = (id: string, scope: InstalledPluginRef["scope"], projectPathHash: string | null = null): InstalledPluginRef => ({ id, scope, projectPathHash });

  const base = (o: Partial<McpToggleTargetInput> & { asset: Asset | undefined }): McpToggleTargetInput => ({
    assetId: o.asset?.id ?? "ghost",
    projectPathHash: H,
    installations: [],
    installedPlugins: [],
    bundledMcpAssetIds: new Set(),
    ...o,
  });
  const reason = (r: ReturnType<typeof resolveMcpToggleTarget>) => (r.ok ? "ok" : r.reason);

  const child = asset({ id: "pm@mk:mcp:srv", name: "srv", parent_asset_id: "pm@mk" });

  it("1 not_mcp: 다른 kind, 카탈로그에 없는 id", () => {
    const skill = AssetSchema.parse({ schema_version: 1, _scope: "machine_independent", kind: "skill", id: "s1", name: "s1" });
    expect(reason(resolveMcpToggleTarget(base({ asset: skill })))).toBe("not_mcp");
    expect(reason(resolveMcpToggleTarget(base({ asset: undefined })))).toBe("not_mcp");
  });
  it("2 connector_or_builtin: 로컬 정의 computer-use, 커넥터/내장 이름", () => {
    const cu = asset({ id: "computer-use", name: "computer-use" });
    const r = resolveMcpToggleTarget(base({ asset: cu, installations: [inst({ asset_id: "computer-use", install_scope: "user" })] }));
    expect(reason(r)).toBe("connector_or_builtin");
    expect(reason(resolveMcpToggleTarget(base({ asset: undefined, assetId: "claude.ai Gmail" })))).toBe("connector_or_builtin");
    expect(reason(resolveMcpToggleTarget(base({ asset: undefined, assetId: "computer-use" })))).toBe("connector_or_builtin");
  });
  it("3 not_defined_for_project: 다른 프로젝트의 local 정의뿐 / 정의 행이 없는(상태 전용 install_scope:null) 경우", () => {
    const a = asset({ id: "loc", name: "loc" });
    expect(reason(resolveMcpToggleTarget(base({ asset: a, installations: [inst({ asset_id: "loc", install_scope: "local", project_path_hash: OTHER })] })))).toBe("not_defined_for_project");
    expect(reason(resolveMcpToggleTarget(base({ asset: a, installations: [inst({ asset_id: "loc", install_scope: null, project_path_hash: H, mcp_enabled_state: "disabled", mcp_state_source: "disabledMcpServers" })] })))).toBe("not_defined_for_project");
  });
  it("허용: user 서버는 어느 프로젝트든, local은 그 프로젝트만, .mcp.json은 pendingApproval", () => {
    const a = asset({ id: "srv1", name: "srv1" });
    expect(resolveMcpToggleTarget(base({ asset: a, installations: [inst({ asset_id: "srv1", install_scope: "user" })] }))).toEqual({ ok: true, harnessName: "srv1", pendingApproval: false });
    expect(resolveMcpToggleTarget(base({ asset: a, installations: [inst({ asset_id: "srv1", install_scope: "local", project_path_hash: H })] }))).toEqual({ ok: true, harnessName: "srv1", pendingApproval: false });
    expect(resolveMcpToggleTarget(base({ asset: a, installations: [inst({ asset_id: "srv1", install_scope: "project", project_path_hash: H })] }))).toEqual({ ok: true, harnessName: "srv1", pendingApproval: true });
  });
  it("4 plugin_not_installed", () => {
    expect(reason(resolveMcpToggleTarget(base({ asset: child })))).toBe("plugin_not_installed");
  });
  it("5 plugin_not_installed_for_project: 다른 프로젝트의 project/local 설치뿐", () => {
    for (const scope of ["project", "local"] as const) {
      expect(reason(resolveMcpToggleTarget(base({ asset: child, installedPlugins: [plugin("pm@mk", scope, OTHER)], bundledMcpAssetIds: new Set([child.id]) })))).toBe("plugin_not_installed_for_project");
    }
  });
  it("6 plugin_name_ambiguous: 이름이 같은 다른 id가 설치돼 있다", () => {
    const r = resolveMcpToggleTarget(base({ asset: child, installedPlugins: [plugin("pm@mk", "user"), plugin("pm@other-mk", "user")], bundledMcpAssetIds: new Set([child.id]) }));
    expect(reason(r)).toBe("plugin_name_ambiguous");
  });
  it("7 plugin_synced_unmeasured: 매니페스트를 못 읽음(null)", () => {
    expect(reason(resolveMcpToggleTarget(base({ asset: child, installedPlugins: [plugin("pm@mk", "synced")], bundledMcpAssetIds: null })))).toBe("plugin_synced_unmeasured");
  });
  it("8 server_not_in_plugin", () => {
    expect(reason(resolveMcpToggleTarget(base({ asset: child, installedPlugins: [plugin("pm@mk", "user")], bundledMcpAssetIds: new Set(["pm@mk:mcp:other"]) })))).toBe("server_not_in_plugin");
  });
  it("허용: 플러그인 자식 — 하네스 이름은 pluginNameFromId(마지막 @) 기준 plugin:<n>:<서버>", () => {
    const at = asset({ id: "a@b@mk:mcp:srv", name: "srv", parent_asset_id: "a@b@mk" });
    const ok = (p: InstalledPluginRef) => resolveMcpToggleTarget(base({ asset: at, installedPlugins: [p], bundledMcpAssetIds: new Set([at.id]) }));
    expect(ok(plugin("a@b@mk", "user"))).toEqual({ ok: true, harnessName: "plugin:a@b:srv", pendingApproval: false });
    expect(ok(plugin("a@b@mk", "local", H))).toMatchObject({ ok: true });
    expect(ok(plugin("a@b@mk", "project", H))).toMatchObject({ ok: true });
  });
  it("synced 스코프는 user처럼 센다 (매니페스트를 읽었을 때)", () => {
    const r = resolveMcpToggleTarget(base({ asset: child, installedPlugins: [plugin("pm@mk", "synced")], bundledMcpAssetIds: new Set([child.id]) }));
    expect(r).toEqual({ ok: true, harnessName: "plugin:pm:srv", pendingApproval: false });
  });
  it("모든 거부에 비어 있지 않은 hint가 있다", () => {
    const r = resolveMcpToggleTarget(base({ asset: undefined }));
    expect(!r.ok && r.hint.length > 0).toBe(true);
  });
});

describe("isDisplayableAssetId", () => {
  it("셸 메타문자·제어문자·공백·빈 값·긴 값을 거른다", () => {
    for (const bad of ["a;b", "a$(x)", "a`x`", "a\u001b[31m", "a b", "a\nb", "", "x".repeat(201), "-rf", "..", ".hidden", "a|b", "a&b", "a'b", 'a"b', "a/b", "a\\b"]) {
      expect(isDisplayableAssetId(bad), JSON.stringify(bad)).toBe(false);
    }
  });
  it("플러그인 자식 id와 평범한 id를 받는다", () => {
    for (const ok of ["pm@mk:mcp:srv", "user-mcp", "a.b_c+d", "x".repeat(200)]) expect(isDisplayableAssetId(ok), ok).toBe(true);
  });
});

describe("matchHashPrefix", () => {
  const paths = Array.from({ length: 400 }, (_, i) => `/synthetic/projects/p${i}`);
  it("hex 1~16자가 아닌 접두사(빈 문자열·대문자·긴 값)는 none", () => {
    const hash = hashPath(paths[7]!);
    expect(matchHashPrefix(paths, "")).toEqual({ kind: "none" });
    expect(matchHashPrefix(paths, hash.slice(0, 8).toUpperCase())).toEqual({ kind: "none" });
    expect(matchHashPrefix(paths, `${hash}0`)).toEqual({ kind: "none" });
    expect(matchHashPrefix(paths, hash.slice(0, 8)).kind).toBe("one");
  });
  it("하나면 one, 없으면 none", () => {
    const target = paths[7]!;
    expect(matchHashPrefix(paths, hashPath(target).slice(0, 12))).toEqual({ kind: "one", path: target });
    expect(matchHashPrefix(paths, "ffffffffffffffff")).toEqual({ kind: "none" });
  });
  it("여럿이면 ambiguous — 더 긴 최단 접두사를 후보 수만큼 돌려주고 각각이 하나만 고른다", () => {
    const r = matchHashPrefix(paths, "a");
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.prefixes.length).toBeGreaterThan(1);
    for (const longer of r.prefixes) {
      expect(longer.length).toBeGreaterThan(1);
      expect(matchHashPrefix(paths, longer).kind).toBe("one");
    }
  });
  it("같은 경로가 중복돼도 한 후보다", () => {
    const t = paths[3]!;
    expect(matchHashPrefix([t, t], hashPath(t).slice(0, 8))).toEqual({ kind: "one", path: t });
  });
});

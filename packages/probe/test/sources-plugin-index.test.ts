import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPluginInstallPaths } from "../src/sources/plugins.js";
import type { HomeContext } from "../src/home.js";

/**
 * R7 Step 5 — `PluginInstallPathIndex.ids()/scopes()`. 설치 여부·스코프 판정이 `ctk mcp`의 D7(부모가 이 프로젝트에 설치됐나)의 입력이다.
 * 이 모듈은 `claude`를 띄우지 않는다 — 파일 직독만이다(spawnClaude를 import하지 않은 경로로 호출되고, 아래는 전부 동기 호출이다).
 */
describe("probe/sources/plugins — listPluginInstallPaths ids()/scopes()", () => {
  let root: string;
  let home: HomeContext;
  const entry = (scope: string, extra: Record<string, unknown> = {}) => ({
    scope,
    installPath: "/synthetic/cache/p",
    version: "1.0.0",
    installedAt: "2026-08-01T00:00:00.000Z",
    lastUpdated: "2026-08-01T00:00:00.000Z",
    ...extra,
  });
  const writeRegistry = (plugins: Record<string, unknown[]>) => {
    mkdirSync(path.join(home.ctkConfigDir, "plugins"), { recursive: true });
    writeFileSync(path.join(home.ctkConfigDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }), "utf8");
  };
  const writeSynced = (names: string[]) => {
    const dir = path.join(home.ctkConfigDir, "plugins", "synced", "acct-synthetic");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ plugins: names.map((name) => ({ name, generation: 1 })) }), "utf8");
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-probe-plugin-index-"));
    home = { ctkHome: root, ctkConfigDir: path.join(root, ".claude"), configDirExplicit: false };
    mkdirSync(home.ctkConfigDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("레지스트리도 synced도 없으면 아무것도 없다(0건 — 던지지 않는다)", () => {
    const index = listPluginInstallPaths(home);
    expect(index.ids()).toEqual([]);
    expect(index.scopes("x@m")).toEqual([]);
  });

  it("레지스트리 파싱 실패는 빈 결과로 삼키지 않고 던진다", () => {
    mkdirSync(path.join(home.ctkConfigDir, "plugins"), { recursive: true });
    writeFileSync(path.join(home.ctkConfigDir, "plugins", "installed_plugins.json"), "{not json", "utf8");
    expect(() => listPluginInstallPaths(home)).toThrow();
  });

  it("레지스트리 id는 엔트리마다 스코프와 projectPath를 싣고, synced는 계정 전체 한 건이다", () => {
    writeRegistry({ "a@m": [entry("user"), entry("local", { projectPath: "/synthetic/proj" })], "b@m": [entry("project", { projectPath: "/synthetic/other" })] });
    writeSynced(["s"]);
    const index = listPluginInstallPaths(home);
    expect(index.ids().sort()).toEqual(["a@m", "b@m", "s@synced"]);
    expect(index.scopes("a@m")).toEqual([{ scope: "user", projectPath: null }, { scope: "local", projectPath: "/synthetic/proj" }]);
    expect(index.scopes("b@m")).toEqual([{ scope: "project", projectPath: "/synthetic/other" }]);
    expect(index.scopes("s@synced")).toEqual([{ scope: "synced", projectPath: null }]);
    expect(index.scopes("nope@m")).toEqual([]);
  });

  it("`x@synced`가 레지스트리에도 있으면 어느 쪽인지 판정할 수 없다 — 우선순위 규칙(`pluginInstallPathEntry`)이 거부로 내고, 열거도 그 규칙을 따른다", () => {
    writeRegistry({ "only-reg@synced": [entry("user")], "both@synced": [entry("user")] });
    writeSynced(["both"]);
    const index = listPluginInstallPaths(home);
    expect(index.ids().sort()).toEqual(["both@synced", "only-reg@synced"]);
    expect(index.get("both@synced")).toHaveProperty("rejected");
    expect(index.get("only-reg@synced")).toHaveProperty("rejected");
  });

  it("synced manifest를 못 읽으면 일반 플러그인은 그대로 열거되고 synced id만 빠지며, 실패는 그 id의 get()에만 실린다", () => {
    writeRegistry({ "a@m": [entry("user")] });
    const dir = path.join(home.ctkConfigDir, "plugins", "synced", "acct-synthetic");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), "{not json", "utf8");
    const index = listPluginInstallPaths(home);
    expect(index.ids()).toEqual(["a@m"]);
    expect(index.get("a@m")).toEqual({ path: "/synthetic/cache/p" });
    expect(index.get("z@synced")).toHaveProperty("missing"); // 미설치가 아니라 미측정
    expect(index.scopes("z@synced")).toEqual([]);
  });
});

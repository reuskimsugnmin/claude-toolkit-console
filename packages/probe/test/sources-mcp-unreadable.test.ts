import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashPath } from "@ctk/core";
import { collectMcp } from "../src/sources/mcp.js";
import type { HomeContext } from "../src/home.js";

/**
 * 프로젝트 `.mcp.json`의 "없음"과 "못 읽음"을 가른다(안전 원칙 7). 파서는 실물이다.
 * ENOENT만 정상이고, 깨진 JSON·디렉터리(EISDIR)·잘못된 모양은 해시로 남되 던지지 않는다.
 */
describe("collectMcp — .mcp.json 읽기 실패는 '파일 없음'이 아니다", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function setup(prepare: (projectDir: string) => void): { projectDir: string; run: () => ReturnType<typeof collectMcp> } {
    root = mkdtempSync(path.join(tmpdir(), "ctk-mcp-unreadable-"));
    const ctkHome = path.join(root, "home");
    const projectDir = path.join(root, "proj");
    mkdirSync(path.join(ctkHome, ".claude"), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(ctkHome, ".claude.json"), JSON.stringify({ projects: { [projectDir]: {} } }), "utf8");
    prepare(projectDir);
    const home: HomeContext = { ctkHome, ctkConfigDir: path.join(ctkHome, ".claude"), configDirExplicit: false };
    return { projectDir, run: () => collectMcp({ home, machineId: "m1", installedPluginNames: new Set() }) };
  }

  it("깨진 JSON — 던지지 않고 그 프로젝트 해시를 남긴다", () => {
    const { projectDir, run } = setup((d) => writeFileSync(path.join(d, ".mcp.json"), "{not json", "utf8"));
    const r = run();
    expect(r.unreadableMcpJsonProjectHashes).toEqual([hashPath(projectDir)]);
  });

  it("디렉터리가 .mcp.json 자리에 있다(EISDIR)", () => {
    const { projectDir, run } = setup((d) => mkdirSync(path.join(d, ".mcp.json")));
    expect(run().unreadableMcpJsonProjectHashes).toEqual([hashPath(projectDir)]);
  });

  it("모양이 틀린 JSON(mcpServers가 배열) — 파서가 던져도 못 읽음으로 센다", () => {
    const { projectDir, run } = setup((d) => writeFileSync(path.join(d, ".mcp.json"), JSON.stringify({ mcpServers: [] }), "utf8"));
    expect(run().unreadableMcpJsonProjectHashes).toEqual([hashPath(projectDir)]);
  });

  it("반대 축 — 파일 없음(ENOENT)은 못 읽음이 아니다", () => {
    const { run } = setup(() => {});
    expect(run().unreadableMcpJsonProjectHashes).toEqual([]);
  });

  it("반대 축 — 정상 파일은 서버를 정의로 올리고 못 읽음이 아니다", () => {
    const { run } = setup((d) => writeFileSync(path.join(d, ".mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "echo" } } }), "utf8"));
    const r = run();
    expect(r.unreadableMcpJsonProjectHashes).toEqual([]);
    expect(r.assets.map((a) => a.id)).toEqual(["srv"]);
  });
});

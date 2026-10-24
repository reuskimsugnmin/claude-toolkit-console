import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBundled } from "../src/sources/bundled.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-bundled-plugin-description.test.ts — 플러그인 매니페스트의 원문 `description`.
 * 플러그인 `Asset`에는 설명이 없어, 생성 문서가 없는 플러그인(정책 차단·미생성)은 무엇을 하는지 보이지 않았다.
 * 서드파티 트리이므로 `.mcp.json`과 같은 리프 방어를 지나는지 함께 태운다.
 */
const PARENT = "demo-plugin@synth-marketplace";

let ctkHome = "";
afterEach(() => rmSync(ctkHome, { recursive: true, force: true }));

function setup(): { home: HomeContext; manifestAbs: string } {
  ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-plugin-desc-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  const dir = path.join(ctkConfigDir, "plugins", "cache", "synth-marketplace", "demo-plugin", "1.0.0");
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(ctkConfigDir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { [PARENT]: [{ scope: "user", installPath: dir, version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z", lastUpdated: "2026-08-01T00:00:00.000Z" }] },
    }),
    "utf8",
  );
  return { home: { ctkHome, ctkConfigDir, configDirExplicit: false }, manifestAbs: path.join(dir, ".claude-plugin", "plugin.json") };
}

const describedAs = (home: HomeContext) => collectBundled({ home, pluginIds: [PARENT] }).parentDescriptions.get(PARENT);

describe("probe/sources/bundled — 플러그인 매니페스트 description", () => {
  it("description을 한 줄로 읽는다(공백·개행을 접는다)", () => {
    const { home, manifestAbs } = setup();
    writeFileSync(manifestAbs, JSON.stringify({ name: "demo-plugin", description: "Does  a\nsynthetic thing." }), "utf8");
    expect(describedAs(home)).toBe("Does a synthetic thing.");
  });

  it("길이를 자른다", () => {
    const { home, manifestAbs } = setup();
    writeFileSync(manifestAbs, JSON.stringify({ description: "x".repeat(2000) }), "utf8");
    expect(describedAs(home)?.length).toBe(500);
  });

  it.each([
    ["없는 매니페스트", (_m: string) => {}],
    ["문자열이 아닌 description", (m: string) => writeFileSync(m, JSON.stringify({ description: ["a"] }), "utf8")],
    ["빈 description", (m: string) => writeFileSync(m, JSON.stringify({ description: "   " }), "utf8")],
    ["JSON이 아님", (m: string) => writeFileSync(m, "{not json", "utf8")],
    ["크기 상한 초과", (m: string) => writeFileSync(m, JSON.stringify({ description: "ok", pad: "x".repeat(70_000) }), "utf8")],
    [
      "심볼릭 링크(따라가지 않는다)",
      (m: string) => {
        const outside = path.join(ctkHome, "outside.json");
        writeFileSync(outside, JSON.stringify({ description: "leaked" }), "utf8");
        symlinkSync(outside, m);
      },
    ],
  ])("%s → 항목 없음(scan은 멈추지 않는다)", (_label, arrange) => {
    const { home, manifestAbs } = setup();
    arrange(manifestAbs);
    expect(describedAs(home)).toBeUndefined();
  });
});

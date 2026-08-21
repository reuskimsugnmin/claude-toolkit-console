import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listKnownProjectPaths, readClaudeJsonFile } from "../src/sources/known-projects.js";
import { ParseSchemaMismatchError } from "../src/sources/errors.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-known-projects.test.ts — 회귀 방지(Step 2, test-engineer 실측 발견).
 * `listKnownProjectPaths`/`readClaudeJsonFile`는 plugins/skills/mcp 세 소스가 공유하는 유일한
 * 프로젝트 레지스트리 관문이다. 이전 구현은 "~/.claude.json이 없다"(정상)와 "있는데 깨졌다"(R13
 * 하네스 드리프트 가능성)를 구분하지 않고 둘 다 빈 결과로 조용히 삼켰다 — 후자가 실제로 발생하면
 * 세 소스 전부의 프로젝트 스코프 데이터가 "프로젝트 0개"로 조용히 사라진다. 여기서는 두 경로가
 * 실제로 갈라지는지 확인한다.
 */
describe("probe/sources/known-projects — ENOENT(정상) vs 파싱 실패(R13, 시끄러운 실패여야 함)", () => {
  let ctkHome: string;
  let home: HomeContext;

  afterEach(() => rmSync(ctkHome, { recursive: true, force: true }));

  function setup(): void {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-known-projects-"));
    home = { ctkHome, ctkConfigDir: path.join(ctkHome, ".claude") };
  }

  it("~/.claude.json이 아예 없으면 빈 배열/null을 정상 반환한다(파일 부재는 합법적 상태)", () => {
    setup();
    expect(listKnownProjectPaths(home)).toEqual([]);
    expect(readClaudeJsonFile(home)).toBeNull();
  });

  it(
    "✅ 회귀 방지 — ~/.claude.json이 존재하지만 JSON 구문이 깨졌으면 빈 배열로 조용히 삼키지 " +
      "않고 ParseSchemaMismatchError를 던진다(이전엔 파일 부재와 구분 없이 [] 반환)",
    () => {
      setup();
      writeFileSync(path.join(ctkHome, ".claude.json"), "{not valid json", "utf8");
      expect(() => listKnownProjectPaths(home)).toThrow(ParseSchemaMismatchError);
      expect(() => readClaudeJsonFile(home)).toThrow(ParseSchemaMismatchError);
    },
  );

  it("~/.claude.json이 디렉터리(읽기 실패이지만 ENOENT가 아님)면 ParseSchemaMismatchError를 던진다", () => {
    setup();
    // 파일이 있어야 할 자리에 디렉터리를 둔다 — readFileSync가 EISDIR로 실패한다(ENOENT 아님).
    mkdirSync(path.join(ctkHome, ".claude.json"), { recursive: true });
    expect(() => listKnownProjectPaths(home)).toThrow(ParseSchemaMismatchError);
  });

  it("정상 JSON이면 projects 키 집합을 반환한다(회귀 방지 — 거부가 과도해지지 않았는가)", () => {
    setup();
    writeFileSync(
      path.join(ctkHome, ".claude.json"),
      JSON.stringify({ projects: { "/synthetic/a": {}, "/synthetic/b": {} } }),
      "utf8",
    );
    expect(listKnownProjectPaths(home).sort()).toEqual(["/synthetic/a", "/synthetic/b"]);
  });
});

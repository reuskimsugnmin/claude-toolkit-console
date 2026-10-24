import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `bin/ctk.ts`의 실행 전 관문 — `ctk scan --help`가 도움말 대신 실제 scan을 돌아 카탈로그에 스냅샷을 남겼다.
 * 관문은 `main` 안에 있으므로 함수가 아니라 **빌드된 바이너리를 실행해** 본다(vitest가 main을 우회해도 통과하던 전례).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = path.join(repoRoot, "packages/cli/bin/ctk.ts");
const DIST_BIN = path.join(repoRoot, "packages/cli/dist/bin/ctk.js");

describe("KNOWN_FLAGS — 코드가 읽는 플래그가 표에서 빠지지 않는다", () => {
  // 명령별로 대조한다 — 합집합으로 보면 다른 명령의 같은 이름 플래그(`--catalog`)가 누락을 가린다.
  it("각 `case` 블록이 읽는 `--플래그`는 그 명령의 표 항목에 있다", () => {
    const src = readFileSync(SRC, "utf8");
    const start = src.indexOf("const KNOWN_FLAGS");
    const end = src.indexOf("};", start);
    expect(start).toBeGreaterThan(-1);
    const flags = (text: string) => [...text.matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]!);
    const table = new Map(
      [...src.slice(start, end).matchAll(/^ {2}(?:"([a-z-]+)"|([a-z]+)): \[([^\]]*)\]/gm)].map((m) => [m[1] ?? m[2]!, new Set(flags(m[3]!))]),
    );
    const cases = [...src.matchAll(/^ {6}case "([a-z-]+)": \{/gm)];
    const missing: string[] = [];
    cases.forEach((m, i) => {
      const body = src.slice(m.index, cases[i + 1]?.index ?? src.length);
      for (const f of flags(body)) if (!table.get(m[1]!)?.has(f)) missing.push(`${m[1]} ${f}`);
    });
    expect(missing).toEqual([]);
    // 양성 대조 — 추출기가 비면 위 단언이 공허해진다
    expect(cases.length).toBeGreaterThanOrEqual(13);
    expect(table.get("init")).toEqual(new Set(["--catalog", "--machine-alias"]));
  });
});

describe.skipIf(!existsSync(DIST_BIN))("빌드된 바이너리 — 도움말·모르는 플래그는 실행 전에 멈춘다", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  function run(args: string[]): { status: number; out: string; home: string } {
    const home = mkdtempSync(path.join(tmpdir(), "ctk-preflight-"));
    homes.push(home);
    try {
      const out = execFileSync("node", [DIST_BIN, ...args], { env: { ...process.env, CTK_HOME: home }, encoding: "utf8", stdio: "pipe" });
      return { status: 0, out, home };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}`, home };
    }
  }

  it.each([["scan", "--help"], ["scan", "-h"], ["init", "--help"], ["gen", "--help"]])("`ctk %s %s`는 사용법만 내고 아무것도 쓰지 않는다", (cmd, flag) => {
    const r = run([cmd, flag]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`사용법: ctk ${cmd}`);
    expect(readdirSync(r.home)).toEqual([]);
  });

  it("모르는 플래그는 exit 1 · unknown_flag · 아무것도 쓰지 않는다", () => {
    const r = run(["init", "--catalgo", "/tmp/x"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL unknown_flag: --catalgo");
    expect(readdirSync(r.home)).toEqual([]);
  });

  it("양성 대조 — 아는 플래그는 관문을 지나 명령이 돈다(빈 홈의 workflow-doc --check는 미측정 2)", () => {
    expect(run(["workflow-doc", "--check"]).status).toBe(2);
  });
});

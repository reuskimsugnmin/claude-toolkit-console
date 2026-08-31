import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findUnusedLeakAllowances,
  findWorkflowDocLeaks,
  INSTALL_INVENTORY_AXES,
} from "@ctk/core";
import { describe, expect, it } from "vitest";

/**
 * README가 안내하는 CLI 표면이 **실제로 존재하는가.**
 *
 * 이 프로젝트에서 반복해 나온 실패다 — 계획서에 적힌 `pnpm ctk`가 없어 검증 블록이 통째로
 * 실행 불가였고, 릴리스 게이트 셋이 문서에만 있고 어떤 명령에도 없어 한 번도 실행된 적이
 * 없었다. **문서에 적은 명령은 한 번은 실행해 본다**를 사람의 기억이 아니라 게이트로 만든다.
 *
 * ⚠️ 이 테스트는 "명령이 배선돼 있다"까지만 본다 — **동작한다는 뜻이 아니다.** 실제 실행은
 * 사람이 한 번 해야 하고(README 작성 시 전부 실행해 확인했다), 여기서는 그 뒤의 드리프트만
 * 막는다. 못 재는 것을 잰 것처럼 적지 않는다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const README = readFileSync(path.join(repoRoot, "README.md"), "utf8");
/** 로드맵도 사용 이력을 적는 문서라 실제 출력을 붙여넣기 쉽다 — 같은 검사를 받게 한다. */
const ROADMAP = readFileSync(path.join(repoRoot, "ROADMAP.md"), "utf8");
const BIN = readFileSync(path.join(repoRoot, "packages/cli/bin/ctk.ts"), "utf8");
const PKG = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** README의 `ctk <명령>` 등장에서 명령 이름만 뽑는다. */
function documentedCommands(): string[] {
  const found = new Set<string>();
  for (const match of README.matchAll(/\bctk\s+([a-z][a-z0-9-]*)/g)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}

/**
 * README가 쓴 `--flag` 중 **ctk의 것만** 고른다.
 *
 * 산문에는 `claude`의 플래그(`--safe-mode` 등)도 등장하므로 전부 세면 오탐이 난다.
 * `ctk`가 같은 줄에 있는 경우만 ctk 플래그로 본다.
 */
function documentedCtkFlags(): string[] {
  const found = new Set<string>();
  for (const line of README.split("\n")) {
    if (!line.includes("ctk ")) continue;
    for (const match of line.matchAll(/--[a-z][a-z0-9-]+/g)) found.add(match[0]);
  }
  return [...found].sort();
}

describe("README가 안내하는 ctk 명령이 실재한다", () => {
  const commands = documentedCommands();

  it("문서에서 명령을 실제로 뽑아냈다 — 정규식이 빈손이면 이 파일 전체가 공허하다", () => {
    expect(commands.length).toBeGreaterThan(5);
    expect(commands).toContain("init");
    expect(commands).toContain("gen");
  });

  it.each(documentedCommands())("`ctk %s`가 bin에 배선돼 있다", (name) => {
    // `verify seal`처럼 서브커맨드인 것은 case 분기가 아니라 문자열 비교로 배선된다.
    const wired = BIN.includes(`case "${name}":`) || BIN.includes(`=== "${name}"`);
    expect(wired, `README는 \`ctk ${name}\`를 안내하는데 bin에 그 분기가 없다`).toBe(true);
  });
});

describe("README가 쓴 ctk 플래그가 실재한다", () => {
  const flags = documentedCtkFlags();

  it("문서에서 플래그를 실제로 뽑아냈다", () => {
    expect(flags.length).toBeGreaterThan(10);
    expect(flags).toContain("--max-budget-usd");
  });

  it.each(documentedCtkFlags())("`%s`를 bin이 읽는다", (flag) => {
    expect(BIN.includes(`"${flag}"`), `README는 \`${flag}\`를 안내하는데 bin이 읽지 않는다`).toBe(true);
  });

  it("존재하지 않는 플래그는 검출된다 — 이 검사가 공허하지 않다", () => {
    expect(BIN.includes('"--this-flag-does-not-exist"')).toBe(false);
  });
});

describe("README가 안내하는 pnpm 스크립트가 실재한다", () => {
  const documented = [...new Set([...README.matchAll(/\bpnpm\s+([a-z][a-z0-9:-]*)/g)].map((m) => m[1]))]
    .filter((s): s is string => s !== undefined)
    // `pnpm install`은 pnpm 내장 명령이라 scripts에 없다.
    .filter((s) => s !== "install");

  it("문서에서 스크립트를 뽑아냈다", () => {
    expect(documented).toContain("ctk");
    expect(documented).toContain("verify");
  });

  it.each(
    [...new Set([...README.matchAll(/\bpnpm\s+([a-z][a-z0-9:-]*)/g)].map((m) => m[1]))]
      .filter((s): s is string => s !== undefined)
      .filter((s) => s !== "install"),
  )("`pnpm %s`가 package.json에 있다", (name) => {
    expect(PKG.scripts[name], `README는 \`pnpm ${name}\`를 안내하는데 스크립트가 없다`).toBeDefined();
  });
});

/**
 * 개인 환경 데이터 부정 단언 — **대상이 `README.md`·`ROADMAP.md` 둘뿐이었다(B4-c Step 1에서 확장).**
 * `docs/`는 이 축에서 무방비였다: `scripts/hygiene-check.mjs`는 헤더에 적힌 대로 경로 리터럴 축만
 * 보고 **설치 목록 축은 스스로 범위 밖**이라 적어 두었으며, 이 파일은 두 문서만 보고 있었다.
 *
 * ⚠️ **정규식을 여기 두지 않는다** — `@ctk/core`의 `findWorkflowDocLeaks`를 부른다. 사본을 남기면
 * 원본의 정정이 사본에 도달하지 않는다(이 저장소가 반복해 데인 형태다).
 * ⚠️ **축은 `INSTALL_INVENTORY_AXES`(설치 목록 3축)다.** 6축을 문서 전문에 걸면 `~/`만으로
 * 오늘 27건이 위반이 되는데 전부 `~/.claude.json` 같은 정당한 설정 경로 표기다 —
 * **초록인 게이트를 새로 빨갛게 만들지 않는다.**
 */
const HYGIENE_DOCS: readonly (readonly [string, string])[] = [
  ["README.md", README],
  ["ROADMAP.md", ROADMAP],
  ...execFileSync("git", ["ls-files", "docs"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".md"))
    .map((f) => [f, readFileSync(path.join(repoRoot, f), "utf8")] as const),
];

describe.each(HYGIENE_DOCS)("%s에 개인 환경 데이터가 없다 (public 저장소)", (_name, DOC) => {
  it("설치 목록 축(자산 id·machine_id·스냅샷 파일명)이 새지 않는다", () => {
    const leaks = findWorkflowDocLeaks(DOC, INSTALL_INVENTORY_AXES);
    expect(leaks, `유출: ${leaks.map((l) => `${l.axis}=${l.match}`).join(", ")}`).toEqual([]);
  });
});

describe("위생 허용목록", () => {
  it("대상 문서를 하나 이상 실제로 읽었다 — 목록이 비면 위 단언이 통째로 공허하다", () => {
    // 이 저장소의 실패: 정규식이 빈손이면 파일 전체가 아무것도 검사하지 않는다.
    expect(HYGIENE_DOCS.length).toBeGreaterThanOrEqual(3);
  });

  it("쓰이지 않는 허용 항목이 없다 — 상류가 바뀌면 허용도 사라져야 한다", () => {
    const unused = findUnusedLeakAllowances(HYGIENE_DOCS.map(([, text]) => text));
    expect(unused.map((a) => a.match), "미사용 허용 항목은 조용히 썩는다").toEqual([]);
  });

  it("양성 대조군 — 오염된 합성 문서는 실제로 걸린다", () => {
    const polluted = "machine_id는 3f2a91be-77c4-4d18-9b02-5ea6c1d40f88이다";
    expect(findWorkflowDocLeaks(polluted, INSTALL_INVENTORY_AXES)).toHaveLength(1);
  });
});

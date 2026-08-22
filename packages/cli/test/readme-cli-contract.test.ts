import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

describe("README에 개인 환경 데이터가 없다 (public 저장소)", () => {
  /**
   * 위생 검사는 **경로 리터럴만** 본다 — 설치된 툴 이름·머신 id는 그 축이 아니라서 통과한다
   * (이번 세션에 같은 사각지대를 두 번 만났다). README는 사용 안내라 실제 출력을 붙여넣기
   * 쉬우므로 여기서 따로 막는다.
   */
  it("실제 machine_id(UUID)가 없다 — `ctk init` 출력을 그대로 붙이면 들어온다", () => {
    expect(README).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("실제 스냅샷 파일명이 없다 — 시각이 곧 사용 이력이다", () => {
    expect(README).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.jsonl/);
  });

  it("마켓플레이스 자산 id 형태(`name@marketplace`)가 없다 — 설치된 툴 목록이다", () => {
    // 코드펜스 안의 `<자산id>` 같은 자리표시자는 이 패턴에 걸리지 않는다.
    expect(README).not.toMatch(/\b[a-z][a-z0-9-]{2,}@[a-z][a-z0-9-]{2,}\b/);
  });
});

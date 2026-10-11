import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const tempHomes: string[] = [];
afterAll(() => {
  for (const dir of tempHomes) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * ADR-003 데몬 불변식의 회귀 테스트 (P2-4 · Step 6b).
 *
 * > ctk는 자동 시작하지 않는다. 데몬 유닛 파일(systemd/launchd/plist)을 제공하지 않는다.
 * > 데몬화·백그라운드 상주 플래그를 노출하지 않는다. `ctk web`은 사용자가 띄우고 사용자가 끄는
 * > 포그라운드 프로세스다.
 *
 * 이 약속은 계획서와 ADR에만 적혀 있었고 **검사가 없었다.** 적어두기만 한 규칙은 규칙이 아니다
 * (CLAUDE.md: 게이트가 존재하는 것과 실행된 것은 다르다). 상주 데몬은 한번 들어오면 빼기
 * 어렵고, 사용자가 모르는 사이 유료 세션(`gen`)을 띄울 수 있는 유일한 경로이기도 하다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * `detached` 옵션을 쓰는 코드의 줄 번호를 돌려준다 (R5).
 *
 * 처음에는 `/detached\s*:\s*true/` 정규식으로 원문을 훑었는데, 그 패턴을 인용한 **주석**까지
 * 잡았다. AST로 바꾸면 주석·문자열은 노드가 아니라 범위가 코드로 좁아지고, 대신 정규식이
 * 놓치던 형태(`detached: flag`, `"detached": !0`, 단축 속성, 대입)는 넓게 잡는다.
 * `detached: false`만 명시적 무해로 통과시킨다.
 */
function findDetachedUses(source: string, fileName: string): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const isDetachedName = (n: ts.Node): boolean =>
    (ts.isIdentifier(n) || ts.isStringLiteral(n)) && n.text === "detached";
  const isAssignTarget = (n: ts.Node): boolean =>
    ts.isBinaryExpression(n.parent) &&
    n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    n.parent.left === n;
  const visit = (n: ts.Node): void => {
    const hit =
      (ts.isPropertyAssignment(n) && isDetachedName(n.name) && n.initializer.kind !== ts.SyntaxKind.FalseKeyword) ||
      (ts.isShorthandPropertyAssignment(n) && n.name.text === "detached") ||
      (ts.isPropertyAccessExpression(n) && n.name.text === "detached" && isAssignTarget(n)) ||
      (ts.isElementAccessExpression(n) && isDetachedName(n.argumentExpression) && isAssignTarget(n));
    if (hit) lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

function tracked(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("데몬 불변식 — 유닛 파일이 저장소에 없다", () => {
  it("systemd/launchd 유닛 파일이 추적 파일에 0건이다", () => {
    // 추적 목록으로 본다 — `.gitignore`는 이미 추적 중인 파일을 막지 못한다(R4와 같은 함정).
    const offenders = tracked().filter((f) => /\.(service|plist|timer|socket)$/.test(f));
    expect(offenders).toEqual([]);
  });

  it("자동 시작을 등록하는 문자열이 코드에 없다", () => {
    const suspicious = tracked()
      .filter((f) => f.endsWith(".ts") || f.endsWith(".mjs") || f.endsWith(".js"))
      .filter((f) => !f.includes("/test/"))
      .filter((f) => /launchctl|systemctl|LaunchAgents|crontab/.test(readFileSync(path.join(repoRoot, f), "utf8")));
    expect(suspicious).toEqual([]);
  });
});

describe("데몬 불변식 — 데몬화 플래그를 노출하지 않는다", () => {
  it("CLI 진입점에 --daemon/--background류 플래그 리터럴이 없다", () => {
    const argvSurface = readFileSync(path.join(repoRoot, "packages/cli/bin/ctk.ts"), "utf8");
    for (const flag of ["--daemon", "--background", "--detach", "--service", "--install-service", "-d "]) {
      expect(argvSurface).not.toContain(flag);
    }
  });

  it("이 검사가 공허하지 않다 — 실제로 존재하는 플래그는 같은 방식으로 검출된다", () => {
    // 위 단언이 "파일을 못 읽어서 통과"하는 상태와 구분한다.
    const argvSurface = readFileSync(path.join(repoRoot, "packages/cli/bin/ctk.ts"), "utf8");
    expect(argvSurface).toContain("--export-view-model");
  });

  it("서브프로세스를 detached로 띄우지 않는다", () => {
    const offenders = tracked()
      .filter((f) => f.endsWith(".ts") && !f.includes("/test/"))
      .flatMap((f) =>
        findDetachedUses(readFileSync(path.join(repoRoot, f), "utf8"), f).map((line) => `${f}:${line}`),
      );
    expect(offenders).toEqual([]);
  });

  it("검출기가 공허하지 않다 — 코드는 잡고 주석은 놓친다", () => {
    // 위 단언이 "아무것도 못 잡아서 통과"하는 상태와 구분한다. 1~3줄은 잡히면 안 되고(R5),
    // 4~7줄은 잡혀야 하며, 8줄(`false`)은 무해다.
    const source = [
      "// detached: true",
      "/* detached: true */",
      'const s = "detached: true";',
      "spawn(a, [], { detached: true });",
      "spawn(a, [], { detached: flag });",
      "spawn(a, [], { detached });",
      "o.detached = true;",
      "spawn(a, [], { detached: false });",
    ].join("\n");
    expect(findDetachedUses(source, "synthetic.ts")).toEqual([4, 5, 6, 7]);
  });
});

describe("데몬 불변식 — ctk web은 포그라운드이고 신호로 종료된다", () => {
  const cliPath = path.join(repoRoot, "packages/cli/dist/bin/ctk.js");

  it.runIf(existsSync(cliPath))("SIGTERM을 받으면 종료한다 — 상주하지 않는다", async () => {
    // ⚠️ **격리 홈을 만들어 준다.** 처음에는 그냥 띄웠는데, `ctk web`은 카탈로그가 없으면
    // 기동 전에 `CatalogNotInitializedError`로 죽는다 — 개발 머신에서는 카탈로그가 있어
    // 통과했지만 CI에서는 실패했다. 이번 세션에서 **같은 형태의 실수를 두 번째** 한 것이다
    // (앞선 것은 `$HOME/.claude` 존재를 단언한 cwd 가드 테스트).
    const home = mkdtempSync(path.join(tmpdir(), "ctk-daemon-"));
    tempHomes.push(home);
    const catalog = path.join(home, "catalog");
    mkdirSync(path.join(catalog, "catalog"), { recursive: true });
    mkdirSync(path.join(home, ".config", "ctk"), { recursive: true });
    writeFileSync(
      path.join(home, ".config", "ctk", "config.json"),
      JSON.stringify({ schema_version: 1, catalog_path: catalog }),
      "utf8",
    );

    const child = spawn(process.execPath, [cliPath, "web", "--port", "0"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CTK_HOME: home },
    });

    // 기동을 확인한 뒤에 죽인다 — 기동 전에 죽으면 "종료됐다"가 아무것도 증명하지 않는다.
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const started = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("http://127.0.0.1:")) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    // 실패하면 왜 못 떴는지 함께 보여준다 — "expected false to be true"만으로는 알 수 없다.
    expect(started, `서버가 기동하지 못했다. stderr: ${stderr}`).toBe(true);

    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
      child.kill("SIGTERM");
    });
    if (!exited) child.kill("SIGKILL");
    expect(exited).toBe(true);
  }, 40_000);
});

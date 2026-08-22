import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
      .filter((f) => /detached\s*:\s*true/.test(readFileSync(path.join(repoRoot, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("데몬 불변식 — ctk web은 포그라운드이고 신호로 종료된다", () => {
  const cliPath = path.join(repoRoot, "packages/cli/dist/bin/ctk.js");

  it.runIf(existsSync(cliPath))("SIGTERM을 받으면 종료한다 — 상주하지 않는다", async () => {
    const child = spawn(process.execPath, [cliPath, "web", "--port", "0"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 기동을 확인한 뒤에 죽인다 — 기동 전에 죽으면 "종료됐다"가 아무것도 증명하지 않는다.
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
    expect(started).toBe(true);

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

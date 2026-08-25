import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runScan } from "../src/commands/scan.js";

/**
 * cli/test/ac26-injection.test.ts — **신설 AC-2.6 주입 테스트**(security-reviewer 지적:
 * "변조된 settings.json 주입 → 자동 롤백 발동 테스트가 코드베이스에 없다").
 *
 * `ctk move`가 백업을 마치고(step 2) 실제 `claude plugin disable/enable`을 spawn하는 동안
 * (step 3, 실제 서브프로세스라 진짜 비동기 대기 구간이 생긴다) **동시에 다른 프로세스가
 * CLAUDE.md를 새로 만든다**(공격 시나리오 흉내 — 조치 도중 외부 개입). `ctk move`가 이걸
 * 감지해 자동 롤백을 시도하고, **exit code≠0**, **stdout/stderr에 failure_class 문자열이
 * 그대로 출현**하는지까지 단언한다(H3/M5/AC-2.6 배선 전체를 end-to-end로 검증) — 이 저장소는
 * 실제 `dist/` 빌드가 있어야 돈다(`pnpm exec tsc -b` 이후).
 *
 * 실측(이 테스트로 처음 확인) — CLAUDE.md는 ctk가 의도적으로 쓰는 파일이 아니므로 백업 대상이
 * 아니다. self-rollback이 플러그인 enablement는 되돌리더라도 CLAUDE.md 변조까지는 되돌릴 수
 * 없다 — H4의 사후 잔존 diff 확인이 이를 잡아 "rolled_back"이 아니라 더 보수적인
 * `rollback_failed`로 격상한다("일부만 되돌렸다"를 "성공적으로 롤백함"으로 거짓 보고하지
 * 않는다). 그래서 최종 failure_class는 `forbidden_path_write`가 아니라 `rollback_failed`다 —
 * 원래 감사 위반(CLAUDE.md)은 원인 체인 메시지에 그대로 남는다(H3: 원인 소실 금지).
 *
 * 타이밍: `fs.watch`로 `.ctk-backups/` 안에 새 백업 런 디렉터리가 생기는 순간을 감지해 그
 * 즉시(동기) CLAUDE.md를 쓴다 — 실제 `claude` 서브프로세스 spawn(수십~수백ms의 진짜 프로세스
 * 생성·I/O)이 감사(step 4) 이전에 끝나기 전에 개입이 끼어들 여지를 준다.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const SYNTH_MARKETPLACE_SRC = path.join(REPO_ROOT, "spikes/fixtures/marketplace-source/synth-mp");
const CTK_BIN = path.join(REPO_ROOT, "packages/cli/dist/bin/ctk.js");

function runRealClaude(ctkHome: string, ctkConfigDir: string, cwd: string, args: string[]) {
  return spawnSync("claude", args, {
    cwd,
    env: {
      HOME: ctkHome,
      CLAUDE_CONFIG_DIR: ctkConfigDir,
      PATH: process.env.PATH ?? "",
      TERM: "xterm",
      SHELL: "/bin/bash",
      TMPDIR: "/tmp",
    },
    encoding: "utf8",
  });
}

function writeJson(absPath: string, value: unknown): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(value, null, 2), "utf8");
}

describe("cli — AC-2.6 주입 테스트: 조치 도중 CLAUDE.md 변조 → 자동 롤백 시도 → exit≠0 → failure_class 노출", () => {
  let ctkHome: string;
  let ctkConfigDir: string;
  let projectDir: string;
  let originalEnv: { CTK_HOME?: string; CTK_CONFIG_DIR?: string };
  let claudeAvailable = true;

  beforeEach(() => {
    ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-ac26-home-"));
    ctkConfigDir = path.join(ctkHome, ".claude");
    projectDir = mkdtempSync(path.join(tmpdir(), "ctk-ac26-project-"));
    mkdirSync(ctkConfigDir, { recursive: true });
    writeJson(path.join(ctkConfigDir, ".claude.json"), { projects: { [projectDir]: {} } });

    originalEnv = { CTK_HOME: process.env.CTK_HOME, CTK_CONFIG_DIR: process.env.CTK_CONFIG_DIR };
    process.env.CTK_HOME = ctkHome;
    process.env.CTK_CONFIG_DIR = ctkConfigDir;

    const marketplaceAdd = runRealClaude(ctkHome, ctkConfigDir, ctkHome, [
      "plugin",
      "marketplace",
      "add",
      SYNTH_MARKETPLACE_SRC,
    ]);
    claudeAvailable = marketplaceAdd.status === 0;
    if (claudeAvailable) {
      const install = runRealClaude(ctkHome, ctkConfigDir, ctkHome, ["plugin", "install", "synth@synth-mp", "-s", "user", "-y"]);
      claudeAvailable = install.status === 0;
    }
  });

  afterEach(() => {
    if (originalEnv.CTK_HOME === undefined) delete process.env.CTK_HOME;
    else process.env.CTK_HOME = originalEnv.CTK_HOME;
    if (originalEnv.CTK_CONFIG_DIR === undefined) delete process.env.CTK_CONFIG_DIR;
    else process.env.CTK_CONFIG_DIR = originalEnv.CTK_CONFIG_DIR;
    rmSync(ctkHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it(
    "✅ AC-2.6 재현 — .ctk-backups/ 에 새 백업 런이 생기는 순간 CLAUDE.md를 새로 쓰면, " +
      "ctk move가 감사에서 이를 거부하고 자동 롤백을 시도한 뒤 exit≠0으로 종료하며 그 실패 " +
      "분류 문자열이 stdout/stderr에 그대로 찍힌다",
    // 이 테스트는 실제 경쟁 조건을 재현한다 — 백업 런이 만들어지는 순간을 폴링으로 잡아
    // 그 창 안에서 변조를 주입한다. 창을 놓치면 **제품 결함이 아니라 하네스의 타이밍 실패**이고,
    // 현재 구현은 그 경우 조용히 통과하지 않고 명시적으로 실패한다(M9와 같은 원칙).
    // 다만 그대로 두면 제품과 무관한 이유로 CI가 간헐적으로 붉어지고, 그러면 "다시 돌리면 되는
    // 것"으로 학습되어 이 보안 게이트 자체가 무시된다. 재시도로 창을 놓칠 확률만 낮추고
    // **제품 단언은 그대로 엄격하게** 둔다 — 세 번 모두 놓치면 여전히 크게 실패한다.
    { retry: 2, timeout: 30_000 },
    async (ctx: { skip: () => void }) => {
      if (!claudeAvailable || !existsSync(CTK_BIN)) {
        // M9와 동일한 이유로 명시적 스킵 — claude 바이너리 부재 또는 dist 미빌드는 회귀가 아니다.
        ctx.skip();
        return;
      }

      await runInit({});
      await runScan();

      const backupsDir = path.join(ctkHome, ".ctk-backups");
      mkdirSync(backupsDir, { recursive: true });

      let tampered = false;
      // fs.watch(macOS FSEvents 백엔드)는 알림 지연이 수십ms 단위로 들쭉날쭉해 이 정도로 짧은
      // 창(실제 claude 서브프로세스 disable+enable 2회)을 놓치기 쉬웠다(실측) — 대신 아주 촘촘한
      // 폴링(1ms)으로 백업 런 디렉터리 생성을 감지한다. 폴링 주체는 이 테스트 프로세스이고
      // 자식(ctk move)의 실행을 막지 않는다(별도 프로세스).
      const pollTimer = setInterval(() => {
        if (tampered) return;
        let entries: string[];
        try {
          entries = readdirSync(backupsDir);
        } catch {
          return;
        }
        if (entries.length === 0) return;
        tampered = true;
        writeFileSync(path.join(ctkConfigDir, "CLAUDE.md"), "injected by a concurrent process\n", "utf8");
      }, 1);

      try {
        const child = spawn(
          process.execPath,
          [CTK_BIN, "move", "--asset", "synth@synth-mp", "--to", "project", "--project-index", "0"],
          {
            cwd: ctkHome,
            env: { ...process.env, CTK_HOME: ctkHome, CTK_CONFIG_DIR: ctkConfigDir },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`ctk move가 20초 안에 끝나지 않았다(stdout=${stdout}, stderr=${stderr})`)), 20_000);
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });

        // 타이밍 재확인 — 개입 자체가 아예 안 걸렸으면(watch가 안 불렸으면) 이 테스트는 아무것도
        // 증명하지 못한다. 그 경우 명확한 진단과 함께 실패시킨다(조용히 통과시키지 않는다).
        if (!tampered) {
          throw new Error("fs.watch가 백업 런 생성을 감지하지 못했다 — 타이밍 재현 실패(환경 문제일 수 있음)");
        }

        expect(exitCode).not.toBe(0);
        const combined = stdout + stderr;
        // 실측(이 테스트로 처음 확인) — CLAUDE.md는 백업 대상이 아니므로(우리가 의도적으로
        // 쓰는 파일만 백업한다) self-rollback이 플러그인 enablement는 되돌리더라도 CLAUDE.md
        // 변조까지는 되돌릴 수 없다. H4의 사후 잔존 diff 확인(verifyNoResidualDiff)이 이를
        // 잡아내 "rolled_back"이 아니라 더 보수적인 rollback_failed로 격상한다 — "일부는
        // 되돌렸지만 완전하지 않다"를 "성공적으로 롤백함"으로 거짓 보고하지 않는다는 뜻이다.
        // 원래 감사 위반(CLAUDE.md)도 원인 체인 메시지에 그대로 남아 있어야 한다(H3: 원인 소실
        // 금지).
        expect(combined).toContain("rollback_failed");
        expect(combined).toContain("CLAUDE.md");
      } finally {
        clearInterval(pollTimer);
      }
    },
  );
});

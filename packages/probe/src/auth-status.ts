import { parseAuthStatus } from "@ctk/core";
import type { HomeContext } from "./home.js";
import { spawnClaude, type SpawnClaudeResult } from "./harness/spawn-claude.js";

/**
 * probe/src/auth-status.ts — `gen/src/estimate.ts`의 "sealed-live 기준 인증 가용성" 선검사가
 * 쓰는 0원 신호(docs/harness-facts.md "claude auth status"). `claude auth status --json`은
 * 구조적 서브커맨드라 모델을 호출하지 않는다 — `sealed-live` 프로파일로 불러도 `--safe-mode`가
 * 구조적 서브커맨드를 깨지 않으므로(실측, `plugin list --json`과 동일 부류) 안전하다.
 *
 * ⚠️ 실제 출력에는 email 등 개인식별정보가 섞여 있다 — 이 함수는 `loggedIn`만 반환하고 원문을
 * 호출자에게 노출하지 않는다.
 */

export interface CheckAuthStatusOptions {
  home: HomeContext;
  cwd: string;
  timeoutSec: number;
  spawnFn?: typeof spawnClaude;
}

export async function checkSealedLiveAuthStatus(options: CheckAuthStatusOptions): Promise<{ loggedIn: boolean }> {
  const { home, cwd, timeoutSec, spawnFn = spawnClaude } = options;
  const result: SpawnClaudeResult = await spawnFn({
    profile: "sealed-live",
    subcommand: ["auth", "status", "--json"],
    home,
    cwd,
    timeoutSec,
  });
  if (result.exitCode !== 0) return { loggedIn: false };
  try {
    const parsed = parseAuthStatus(JSON.parse(result.stdout) as unknown);
    return { loggedIn: parsed.loggedIn };
  } catch {
    return { loggedIn: false };
  }
}

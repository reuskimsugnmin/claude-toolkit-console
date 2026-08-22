import { chmodSync, mkdirSync } from "node:fs";
import { resolveAgentProbeCwd, resolveFixedCwd, SEALED_LIVE_CWD_RELATIVE } from "@ctk/probe";

/**
 * cli/src/sealed-cwd.ts — iter 8 · B3(고정 cwd) 실제 생성. `probe/harness/cwd-guard.ts`는 경로만
 * 계산한다(probe는 읽기 전용 계약이라 `mkdirSync`를 쓸 수 없다, `ctk/no-fs-write-mutation`) —
 * 실제 디렉터리 생성은 `cli` 계층(쓰기 허용)의 몫이다.
 *
 * 0700 권한을 **매번** 재확인한다 — 디렉터리가 이미 다른 프로세스/과거 버전이 다른 권한으로
 * 만들어 뒀을 수 있다(`mkdirSync`의 `mode`는 최초 생성 시에만 적용되고 기존 디렉터리에는
 * 영향을 주지 않는다).
 */
function ensureCwd(absPath: string): string {
  mkdirSync(absPath, { recursive: true, mode: 0o700 });
  chmodSync(absPath, 0o700);
  return absPath;
}

export function ensureSealedLiveCwd(): string {
  return ensureCwd(resolveFixedCwd(SEALED_LIVE_CWD_RELATIVE));
}

/**
 * `agent-probe`의 cwd는 **홈 밖**(임시 루트 아래)에 만든다 — 홈 아래에 두면 `$HOME/.claude`가
 * 상위 경로에 걸려 `assertNoAncestorConfig`가 항상 발동한다(cwd-guard.ts 주석 참조).
 */
export function ensureAgentProbeCwd(): string {
  return ensureCwd(resolveAgentProbeCwd());
}

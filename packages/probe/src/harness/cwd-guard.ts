import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * probe/src/harness/cwd-guard.ts — iter 8 · B3(고정 cwd) · M2(cwd 상위 경로 검사).
 *
 * **B3 — 고정 cwd 재사용.** `sealed-live` 세션의 cwd는 실행마다 새로 만들지 않고 고정 경로 1개
 * (`~/.cache/ctk/sealed-cwd`, 0700)를 재사용한다(AC-0.11 실측 — 매번 새로 만들면
 * `.claude.json`의 `projects.*`에 죽은 경로 엔트리가 무한 누적되고, 그 경로 원문 자체가
 * 사용자 실파일에 쌓인다). 이 모듈은 그 경로를 **계산만** 한다 — 실제 `mkdirSync`(쓰기)는
 * `probe`의 읽기 전용 계약(`ctk/no-fs-write-mutation`) 밖이므로 호출자(`cli`)의 몫이다.
 *
 * **M2 — cwd 상위 경로 검사.** `agent-probe`(AC-3.3)의 `--setting-sources project`는 cwd의
 * 프로젝트 설정을 **의도적으로 로드한다.** `mktemp -d`류가 만드는 디렉터리의 상위(`/tmp`·`/`)에
 * `CLAUDE.md`나 `.claude/`가 심어져 있으면 그것이 로드될 수 있다 — 가장 약한 봉인
 * (`agent-probe` 예외 조합)이 바로 이 지점에서 노출된다. 이 검사는 읽기 전용(`existsSync`)이라
 * `probe`에 둘 수 있다.
 */

/** 실제 `$HOME` 기준 고정 상대 경로 — `sealed-live` 세션의 cwd (0700, 재사용). */
export const SEALED_LIVE_CWD_RELATIVE = ".cache/ctk/sealed-cwd";

/** 실제 `$HOME` 기준 고정 상대 경로 — `agent-probe` 세션의 cwd (0700, 재사용). */
export const AGENT_PROBE_CWD_RELATIVE = ".cache/ctk/probe-cwd";

/**
 * `homeDir`(기본값 `os.homedir()`, 테스트 주입 가능) 기준으로 고정 cwd 절대경로를 계산한다.
 * 디렉터리를 만들지 않는다 — 순수 경로 계산.
 */
export function resolveFixedCwd(relative: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, relative);
}

export class SealCwdAncestorConfigError extends Error {
  readonly failureClass = "seal_cwd_ancestor_config" as const;
  readonly offendingPath: string;
  constructor(cwdAbs: string, offendingPath: string) {
    super(
      `agent-probe cwd(${cwdAbs})의 상위 경로 ${offendingPath}에 CLAUDE.md 또는 .claude/가 존재한다 — ` +
        `--setting-sources project가 이를 의도치 않게 로드할 수 있어 실행을 거부한다`,
    );
    this.name = "SealCwdAncestorConfigError";
    this.offendingPath = offendingPath;
  }
}

/**
 * `cwdAbs`의 상위 경로를 파일시스템 루트까지 훑어 `CLAUDE.md`·`.claude/`가 존재하면
 * `SealCwdAncestorConfigError`를 던진다. `cwdAbs` 자기 자신은 검사 대상이 아니다(고정 cwd 안에
 * ctk가 둔 것은 정상이다) — 검사는 **상위**부터 시작한다.
 */
export function assertNoAncestorConfig(cwdAbs: string): void {
  let dir = path.dirname(path.resolve(cwdAbs));
  // path.dirname("/")는 "/"를 반환한다 — 루트에 도달하면 그 자신이 마지막 검사 대상이자 종료 조건.
  let previous: string | null = null;
  while (dir !== previous) {
    const claudeMd = path.join(dir, "CLAUDE.md");
    const claudeDir = path.join(dir, ".claude");
    if (existsSync(claudeMd)) throw new SealCwdAncestorConfigError(cwdAbs, claudeMd);
    if (existsSync(claudeDir)) throw new SealCwdAncestorConfigError(cwdAbs, claudeDir);
    previous = dir;
    dir = path.dirname(dir);
  }
}

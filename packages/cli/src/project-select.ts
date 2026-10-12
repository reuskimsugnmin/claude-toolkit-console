import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { buildProjectChoices, hashPath, matchHashPrefix } from "@ctk/core";
import { listKnownProjectPaths, type HomeContext } from "@ctk/probe";

/**
 * cli/src/project-select.ts — `ctk mcp`가 쓸 프로젝트 **키**를 고른다. 쓰기 대상이 `~/.claude.json`의 `projects`
 * 키 하나이므로 "무엇을 골랐는가"가 곧 "무엇을 바꾸는가"다. 추측하지 않는다 — 판정할 수 없으면 거부한다.
 */

/** 선택·적격성 거부. `guard`는 어느 검사가 발동했는지 밝힌다(같은 클래스 안에서도 처방이 다르다). */
export class McpToggleRefusedError extends Error {
  readonly failureClass = "mcp_toggle_refused" as const;
  readonly guard: string;
  constructor(guard: string, message: string) {
    super(message);
    this.name = "McpToggleRefusedError";
    this.guard = guard;
  }
}

export interface ProjectSelector {
  /** `ctk mcp`가 목록에 보여 준 해시 접두(8~16자 소문자 hex). */
  projectHash?: string;
  /** `~/.claude.json` `projects`의 키와 **정확히** 같은 경로. */
  project?: string;
}

/** `dir`부터 위로 올라가며 가장 가까운 `.git`(디렉터리든 worktree 파일이든)을 가진 디렉터리. 없으면 null. */
function nearestGitDir(dir: string): string | null {
  for (let cur = dir; ; ) {
    if (existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * 키를 지정하지 않았을 때의 기본값 — cwd의 realpath에서 가장 가까운 git 루트, git 밖이면 cwd 그대로(F3).
 * 하네스가 프로젝트 키로 쓰는 값과 같아야 쓰기가 의미를 갖는다 — 아래 `assertKeyShape`이 한 번 더 확인한다.
 */
function defaultKey(cwd: string): string {
  const real = realpathSync.native(cwd);
  return nearestGitDir(real) ?? real;
}

/**
 * 고른 키가 하네스가 실제로 쓰는 키 모양인가. 두 규칙 모두 실측 전에는 **추측하지 않고 거부**한다
 * (docs/harness-facts.md 「R7 열린 항목」):
 * - 키는 자기 realpath여야 한다. `.native`를 쓴다 — JS `realpathSync`는 대소문자를 정규화하지 않아(APFS 실측) 대소문자 규칙이 영영 안 걸린다.
 *   (심볼릭 링크·`/tmp` vs `/private/tmp`·대소문자만 다른 경우는 하네스 키와 달라질 수 있다).
 * - 키에서 위로 가장 가까운 `.git`은 키 자신이거나 없어야 한다 — `$HOME/.git`(dotfiles) 아래의 비-저장소 프로젝트처럼
 *   하네스가 키를 상위 루트로 접는지 알 수 없는 모양을 거른다.
 */
function assertKeyShape(key: string): void {
  let real: string;
  try {
    real = realpathSync.native(key);
  } catch {
    throw new McpToggleRefusedError("key_not_on_disk", "그 프로젝트 키가 디스크에 없다 — 키가 옛것이거나 이동됐다. 쓰지 않았다.");
  }
  if (real !== key) {
    throw real.toLowerCase() === key.toLowerCase()
      ? new McpToggleRefusedError("key_case_differs", "프로젝트 키와 실제 디렉터리 이름이 대소문자만 다르다 — 하네스는 디스크의 대소문자를 키로 쓰므로(실측) 이 키는 하네스가 읽지 않는다. 쓰지 않았다.")
      : new McpToggleRefusedError("key_not_realpath", "프로젝트 키가 realpath가 아니다(심볼릭 링크 등) — 하네스 키와 다를 수 있어 거부한다.");
  }
  const nearest = nearestGitDir(key);
  if (nearest !== null && nearest !== key) {
    throw new McpToggleRefusedError(
      "git_root_above_key",
      "이 프로젝트 위쪽에 .git이 있다(저장소 루트가 아님) — 하네스는 가장 가까운 .git 루트를 키로 쓰므로(실측) 이 키는 하네스가 읽지 않는다. 쓰지 않았다.",
    );
  }
}

/** 선택자 → `projects`의 기존 키. 거부는 `McpToggleRefusedError`(guard 포함)로 던진다. */
export function selectProject(home: HomeContext, selector: ProjectSelector, cwd: string = process.cwd()): string {
  if (selector.projectHash !== undefined && selector.project !== undefined) {
    throw new McpToggleRefusedError("selector_conflict", "--project-hash와 --project는 함께 줄 수 없다 — 하나만 고른다.");
  }
  const known = listKnownProjectPaths(home);
  let key: string;
  if (selector.projectHash !== undefined) {
    if (!/^[0-9a-f]{8,16}$/.test(selector.projectHash)) {
      throw new McpToggleRefusedError("hash_format", "--project-hash는 8~16자 소문자 hex여야 한다(`ctk mcp`가 보여 주는 앞 8자).");
    }
    const match = matchHashPrefix(known, selector.projectHash);
    if (match.kind === "none") {
      throw new McpToggleRefusedError("hash_stale", "그 해시의 프로젝트가 없다 — 목록이 바뀌었을 수 있다. `ctk mcp`로 다시 확인한다.");
    }
    if (match.kind === "ambiguous") {
      throw new McpToggleRefusedError("hash_ambiguous", `해시 접두가 둘 이상과 맞는다 — 더 긴 접두로 다시 고른다: ${match.prefixes.join(", ")}`);
    }
    key = match.path;
  } else if (selector.project !== undefined) {
    key = selector.project;
  } else {
    key = defaultKey(cwd);
  }
  if (!known.includes(key)) {
    throw new McpToggleRefusedError(
      "key_absent",
      "그 프로젝트는 ~/.claude.json의 projects 키가 아니다 — 하네스가 아직 만들지 않은 키를 ctk가 만들지 않는다. `ctk mcp`로 목록을 확인한다.",
    );
  }
  assertKeyShape(key);
  return key;
}

/** 신뢰할 수 없는 조각이 터미널을 조작하지 못하게 제어문자(줄바꿈·탭 제외)를 `?`로 바꾼다(표시 전용). */
export function printable(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "?");
}

/**
 * `ctk mcp` 단독 실행의 목록 — 인덱스 없이 `hash8  표시이름`. 인덱스는 목록이 바뀌면 다른 프로젝트를 가리키므로
 * 선택 수단으로 내지 않는다(해시는 `--project-hash`가 그대로 받는다). 표시 이름은 터미널 전용이다.
 */
export function listProjectLines(home: HomeContext): string[] {
  const known = listKnownProjectPaths(home);
  const choices = buildProjectChoices({ absolutePaths: known, hashPrefixOf: hashPath });
  return choices.map((c, i) => `${hashPath(known[i] ?? "").slice(0, 8)}  ${printable(c.label)}${c.parentHint !== undefined ? ` (${printable(c.parentHint)})` : ""}`);
}

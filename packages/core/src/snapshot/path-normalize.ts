import { createHash } from "node:crypto";

/**
 * 경로 원문 금지 규칙(카탈로그 결정 2 · 착수 조건 C1의 projectPath 위생 정책).
 * `node:crypto`는 순수 계산(I/O 없음)이라 core에서 허용된다 — lint는 fs/child_process만 금지한다.
 */

export function hashPath(rawAbsolutePath: string): string {
  return createHash("sha256").update(rawAbsolutePath).digest("hex").slice(0, 16);
}

export interface NormalizedPath {
  /** 홈 상대 표기 (예: "~/projects/foo"). 정규화 불가하면 null */
  home_relative: string | null;
  /** sha256 앞 16자. home_relative가 없을 때의 유일한 저장 형태 */
  path_hash: string;
}

/**
 * homeDir을 명시적으로 받는다 — core는 os.homedir()을 직접 부르지 않는다(순수 함수, I/O 없음).
 * 호출자(probe)가 실제 홈 경로를 넘긴다.
 */
export function normalizePath(rawAbsolutePath: string, homeDir: string): NormalizedPath {
  const path_hash = hashPath(rawAbsolutePath);
  if (homeDir.length > 0 && rawAbsolutePath.startsWith(homeDir)) {
    const rest = rawAbsolutePath.slice(homeDir.length);
    const home_relative = `~${rest.startsWith("/") ? rest : `/${rest}`}`;
    return { home_relative, path_hash };
  }
  return { home_relative: null, path_hash };
}

/** 스냅샷에 절대 남아서는 안 되는 홈 절대경로 원문 패턴 (AC-1.7 위생 검사, 휴리스틱). */
const RAW_ABS_HOME_PATTERNS: RegExp[] = [/\/Users\/[^"'\\\s]+/g, /\/home\/[^"'\\\s]+/g];

export interface HygieneViolation {
  pattern: string;
  match: string;
}

/** 임의의 값(스냅샷 레코드 등)을 직렬화해 원문 홈 절대경로 흔적을 찾는다. */
export function findRawPathLeaks(value: unknown): HygieneViolation[] {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const violations: HygieneViolation[] = [];
  for (const pattern of RAW_ABS_HOME_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(serialized)) !== null) {
      violations.push({ pattern: pattern.source, match: m[0] });
    }
  }
  return violations;
}

/** 위반이 있으면 던진다 — 스냅샷 append 경로에서 마지막 방어선으로 호출한다. */
export function assertNoRawPathLeaks(value: unknown): void {
  const violations = findRawPathLeaks(value);
  if (violations.length > 0) {
    throw new Error(
      `스냅샷 위생 위반 — 홈 절대경로 원문 발견: ${violations.map((v) => v.match).join(", ")}`,
    );
  }
}

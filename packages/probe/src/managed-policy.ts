import { existsSync, readFileSync } from "node:fs";

/**
 * probe/src/managed-policy.ts — iter 8 · M1. Admin/policy(managed) 설정 파일을 OS별 고정
 * 경로에서 **읽기만** 한다(I/O). 위험 키 등급화(판정)는 `core/src/guard/managed-policy.ts`의
 * `gradeManagedPolicy()`가 한다 — 이 모듈은 파싱된 JSON(들)을 그 함수에 넘길 형태로만 만든다.
 *
 * 탐지 경로는 OS별 하드코딩이다(§4.1 CLI 표면 정의 — `ctk doctor --managed-policy`). 3경로 전부
 * 부재가 정상 상태다(이 프로젝트가 개발되는 머신 실측 — R15) — 파일이 없으면 그냥 건너뛴다.
 */

export interface ManagedPolicyCandidate {
  path: string;
  platform: NodeJS.Platform;
}

/** claude 하네스의 managed-settings.json 후보 경로(플랫폼별). 실측 소스: `claude --help`가
 * 문서화하지 않는 항목이라 커뮤니티에 알려진 엔터프라이즈 배포 경로를 하드코딩한다(R15). */
export function managedPolicyCandidatePaths(platform: NodeJS.Platform = process.platform): ManagedPolicyCandidate[] {
  switch (platform) {
    case "darwin":
      return [{ path: "/Library/Application Support/ClaudeCode/managed-settings.json", platform }];
    case "linux":
      return [{ path: "/etc/claude-code/managed-settings.json", platform }];
    case "win32":
      return [{ path: "C:\\ProgramData\\ClaudeCode\\managed-settings.json", platform }];
    default:
      return [];
  }
}

/**
 * 존재하는 managed 정책 파일을 전부 읽어 파싱한다. 파일이 없으면 건너뛰고(정상), 있는데
 * 파싱이 깨지면 그 사실을 원문 없이 반환에 남긴다(안전 원칙 5 — "없음"과 "읽기 실패"를
 * 구분한다). 정책 **내용**은 이 함수의 반환값에 담기지만, 호출자(`core/guard/managed-policy.ts`
 * 판정기 이후)는 그 원문을 로그·run-log에 절대 옮기지 않는다 — 판정기가 반환하는 것은 키
 * 이름뿐이다.
 */
export interface ReadManagedPoliciesResult {
  policies: unknown[];
  parseFailures: string[];
}

export function readManagedPolicies(
  candidates: ManagedPolicyCandidate[] = managedPolicyCandidatePaths(),
): ReadManagedPoliciesResult {
  const policies: unknown[] = [];
  const parseFailures: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      policies.push(JSON.parse(readFileSync(candidate.path, "utf8")) as unknown);
    } catch {
      parseFailures.push(candidate.path);
    }
  }
  return { policies, parseFailures };
}

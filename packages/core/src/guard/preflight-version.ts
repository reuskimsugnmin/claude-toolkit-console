/**
 * core/src/guard/preflight-version.ts — iter 8 · B5 (§1.3 결정 6 `sealed-live` 명세).
 *
 * `claude`는 자동 업데이트되므로 릴리스 시점 봉인 테스트가 사용자 머신의 "현재" 버전을 보장하지
 * 않는다. 모든 `sealed-live` spawn **직전에** `claude --version`을 검증된 버전과 대조하고,
 * 다르면 (i) 0원 라우팅 신호(설치 플러그인/명령이 인식되지 않는 것)를 프리플라이트로 재현한
 * 뒤에만 진행하며 (ii) 재현 실패 시 `seal_unverified_cli`로 **실행을 거부한다(경고가 아니다)**.
 *
 * 이 파일은 판정만 한다(순수 함수, I/O 없음) — 실제 `--version` 실행과 라우팅 신호 재현
 * 시도는 `probe/src/harness/spawn-claude.ts`(claude 서브프로세스를 spawn할 수 있는 유일한
 * 지점, eslint `ctk/single-spawn-wrapper`)의 몫이다.
 */

export type PreflightVersionMatch = "match" | "mismatch_routing_reproduced" | "mismatch_rejected";

export interface PreflightVersionVerdict {
  match: PreflightVersionMatch;
  allowed: boolean;
}

/**
 * `(검증된 버전, 실제 버전, 라우팅 신호 재현 여부) → 판정` 순수 함수.
 *
 * - 버전이 같으면 그대로 허용한다("match").
 * - 버전이 다르면 라우팅 신호 재현에 성공했을 때만 허용한다("mismatch_routing_reproduced") —
 *   버전은 달라졌지만 `--safe-mode`의 핵심 행동(설치 커스터마이즈 미로드)이 여전히 유지되고
 *   있다는 최소한의 증거다.
 * - 재현하지 못하면 무조건 거부한다("mismatch_rejected") — 이것이 `seal_unverified_cli`다.
 */
export function verdictPreflightVersion(
  verifiedVersion: string,
  actualVersion: string,
  routingSignalReproduced: boolean,
): PreflightVersionVerdict {
  if (verifiedVersion === actualVersion) {
    return { match: "match", allowed: true };
  }
  if (routingSignalReproduced) {
    return { match: "mismatch_routing_reproduced", allowed: true };
  }
  return { match: "mismatch_rejected", allowed: false };
}

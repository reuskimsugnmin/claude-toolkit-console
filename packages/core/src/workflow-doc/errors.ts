import type { FailureClass } from "../failure/classes.js";

/**
 * `ctk workflow-doc`의 구조적 실패 — **"없음"이 아니라 "실패"다**(안전 원칙 7).
 *
 * ⚠️ **`failureClass`를 `string`으로 두지 않는다.** B1 심사 L-D가 정확히 그 형태였다 —
 * `FailureClass`로 좁히자 곧바로 누수 지점이 드러났고, `string`이면 미등재 클래스를 던져도
 * 컴파일이 통과한 뒤 run-log에서 조용히 `null`이 된다. **등재가 곧 배선이다.**
 *
 * ⚠️ **이 에러는 `bin/ctk.ts`의 포괄 `failureClass` 분기에 닿으면 exit 1이 된다** — 그 분기는
 * 모든 `failureClass` 보유 에러를 드리프트(1)로 만든다. `workflow-doc` 커맨드는 **던지지 않고
 * 판정 결과를 반환**해 호출부가 종료 코드를 정한다(D-3). 여기서 던지는 것은 `core` 내부 계약
 * 위반뿐이고, 커맨드 계층이 그것을 잡아 종료 코드 3으로 옮긴다.
 */
export class WorkflowDocError extends Error {
  readonly failureClass: FailureClass;

  constructor(failureClass: FailureClass, message: string) {
    super(message);
    this.name = "WorkflowDocError";
    this.failureClass = failureClass;
  }
}

/** 표 파싱이 아무것도 찾지 못했다 — **"0건 일치"로 삼키지 않는다.** */
export function parseFailed(message: string): WorkflowDocError {
  return new WorkflowDocError("workflow_doc_parse_failed", message);
}

/** 동적 화이트리스트의 상한 — 표를 손으로 고쳐 임의 규모의 조회를 유발할 수 없게 한다(D-9). */
export function whitelistOverflow(count: number, limit: number): WorkflowDocError {
  return new WorkflowDocError(
    "workflow_doc_whitelist_overflow",
    `표에서 뽑은 자산 참조가 ${count}건으로 상한 ${limit}건을 넘었다 — 표가 의도와 다르게 커졌거나 파싱이 잘못됐다`,
  );
}

/**
 * 소스 모듈 공용 오류 — 하네스 출력이 zod strict 스키마와 맞지 않을 때(R13). `core/failure/classes.ts`의
 * `parse_schema_mismatch`에 대응한다. 호출자(cli)가 이 오류를 잡아 run-log의 `failure_class`로 기록한다.
 */
export class ParseSchemaMismatchError extends Error {
  readonly failureClass = "parse_schema_mismatch" as const;
  readonly source: string;
  constructor(source: string, cause: unknown) {
    super(`${source} 출력이 예상 스키마와 맞지 않는다(R13 — 하네스 드리프트 가능성): ${String(cause)}`);
    this.name = "ParseSchemaMismatchError";
    this.source = source;
    this.cause = cause;
  }
}

/**
 * 서브프로세스 명령 자체가 실패(0이 아닌 종료 코드)했을 때 던진다. **빈 stdout을 "결과 없음"으로
 * 조용히 해석하지 않기 위한 구분이다** — 실측(Step 2, 실제 환경 검증)에서 argv 구성 실수로
 * `claude plugin list --json`이 매번 exit 1 + 빈 stdout을 냈는데, 이를 "플러그인 0개"로
 * 잘못 해석해 스냅샷이 조용히 텅 빈 채로 쌓일 뻔했다 — 그 회귀를 막는 방어선이다.
 */
export class CommandFailedError extends Error {
  readonly source: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(source: string, exitCode: number | null, stderr: string) {
    super(`${source} 명령이 실패했다(exit ${exitCode ?? "null"}): ${stderr.trim() || "(stderr 없음)"}`);
    this.name = "CommandFailedError";
    this.source = source;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

import type { RunLogEntry } from "@ctk/core";
import { writeRunLog } from "@ctk/sync";

/** run-log 기록 자체의 실패가 원본 오류를 삼키지 않도록 격리한다(H3). */
export function writeRunLogSafely(catalogPath: string, entry: RunLogEntry): void {
  try {
    writeRunLog(catalogPath, entry);
  } catch {
    // best-effort — 원본 성공/실패 결과에 영향을 주지 않는다.
  }
}

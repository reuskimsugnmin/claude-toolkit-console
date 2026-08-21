import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertNoRawPathLeaks, journalPath, toJsonlLine, type JournalEntry } from "@ctk/core";

/**
 * sync/src/journal-store.ts — `journal/<iso8601>.jsonl` append(카탈로그 결정 2). **이 단계
 * (Step 5)의 산출물이다**(M6) — journal 레코드를 실제로 남기는 첫 단계가 Step 5다.
 *
 * `actuator/src/journal.ts`는 레코드를 **반환만** 한다(P1-5) — 카탈로그 저장소에 실제로 쓰는
 * 유일한 주체는 이 모듈이며, 호출은 `cli`가 지시한다(actuator는 sync를 import할 수 없다,
 * 계층 lint). 1회 실행 = 1파일(스냅샷·run-log와 동일 규약).
 */
export function writeJournalEntry(catalogRoot: string, entry: JournalEntry): { path: string } {
  assertNoRawPathLeaks(entry);
  const relPath = journalPath(entry.timestamp.replace(/:/g, "-"));
  const absPath = path.join(catalogRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${toJsonlLine(entry)}\n`, "utf8");
  return { path: absPath };
}

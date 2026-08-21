import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalogAbsPath } from "./catalog-boundary.js";
import { assertNoRawPathLeaks, runLogPath, toJsonlLine, type RunLogEntry } from "@ctk/core";

/**
 * sync/src/run-log-store.ts — `machines/<machine_id>/runs/<iso8601>.jsonl` append(§7 관측
 * 가능성). `ctk scan`이 이미 이 파일을 남기므로 이 모듈 없이는 §7 관측 가능성이 성립하지 않는다
 * (M6, plan §4.1 Step 2 서두). 1회 실행 = 1파일(스냅샷과 동일 규약) — 파일명의 iso8601은 이
 * 실행의 시작 시각이다.
 */
export function writeRunLog(catalogRoot: string, entry: RunLogEntry): { path: string } {
  assertNoRawPathLeaks(entry);
  // 파일명은 콜론이 없는 파일시스템 안전 변형을 쓴다(core/snapshot/id.ts의 snapshotIdFsSafe와
  // 동형) — 레코드 본문의 started_at 필드 자체는 정식 ISO8601(콜론 포함)로 그대로 둔다.
  const relPath = runLogPath(entry.machine_id, entry.started_at.replace(/:/g, "-"));
  const absPath = catalogAbsPath(catalogRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${toJsonlLine(entry)}\n`, "utf8");
  return { path: absPath };
}

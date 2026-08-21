import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalogAbsPath } from "./catalog-boundary.js";
import { assertNoRawPathLeaks, snapshotPath, toJsonl, type AppendOnlyRecord } from "@ctk/core";

/**
 * sync/src/snapshot-store.ts — `machines/<machine_id>/snapshots/<iso8601>.jsonl` append(카탈로그
 * 결정 2). 스냅샷은 append-only로 쌓는다 — 한 번의 `ctk scan`이 새 파일 하나를 만든다(기존 파일에
 * 이어쓰지 않는다. §7의 `runs/*.jsonl`과 동일한 "1회 실행 = 1파일" 규약).
 *
 * 쓰기 직전 마지막 방어선으로 경로 원문 위생 검사를 돈다(AC-1.7) — `core/snapshot/path-normalize.ts`의
 * `assertNoRawPathLeaks`가 위반을 던지면 이 함수는 아무 것도 쓰지 않고 그대로 전파한다.
 */
export function writeSnapshot(
  catalogRoot: string,
  machineId: string,
  isoTimestamp: string,
  records: readonly AppendOnlyRecord[],
): { path: string } {
  assertNoRawPathLeaks(records);
  // 파일명은 콜론이 없는 파일시스템 안전 변형을 쓴다(core/snapshot/id.ts의 snapshotIdFsSafe와
  // 동형 — 기존 픽스처 `2026-08-01T00-00-00Z.jsonl`과 동일한 명명 규약).
  const relPath = snapshotPath(machineId, isoTimestamp.replace(/:/g, "-"));
  const absPath = catalogAbsPath(catalogRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${toJsonl(records)}\n`, "utf8");
  return { path: absPath };
}

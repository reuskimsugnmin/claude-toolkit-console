import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { catalogAbsPath } from "./catalog-boundary.js";
import { assertNoRawPathLeaks, parseRunLogEntry, runLogPath, toJsonlLine, type GenCost, type RunLogEntry } from "@ctk/core";

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

/**
 * 이 머신의 **가장 최근 `gen` 실행이 남긴 실측 비용**을 읽는다. 다음 실행의 견적이 이 값을
 * 근거로 범위를 보여준다 — 실측 단가를 제품 코드에 상수로 박는 대신(이 저장소는 public이며
 * 개인 사용량 수치를 담지 않는다) 머신별 영역에서 읽는다. **축이 맞는 자리다**: 자산당 실비용은
 * 그 머신에 깔린 툴의 원문 크기에 달린 머신 종속 사실이다.
 *
 * ⚠️ **못 읽으면 `null`이지 0이 아니다.** 파일이 없거나 파싱에 실패하면 "실측 없음"이고,
 * 호출자는 그때 실측 줄을 아예 띄우지 않는다(안전 원칙 7 — 없는 것을 그럴듯한 값으로 채우지 않는다).
 * 파싱 실패를 조용히 건너뛰되, 그것이 "0원"으로 흘러가지는 않는다.
 */
export function readLatestGenCost(catalogRoot: string, machineId: string): GenCost | null {
  const runsDirRel = runLogPath(machineId, "x").replace(/\/x\.jsonl$/, "");
  const runsDirAbs = catalogAbsPath(catalogRoot, runsDirRel);
  if (!existsSync(runsDirAbs)) return null;
  let names: string[];
  try {
    names = readdirSync(runsDirAbs).filter((n) => n.endsWith(".jsonl")).sort().reverse();
  } catch {
    return null;
  }
  // 파일명이 시작 시각이므로 역순이 최신순이다. 최신부터 훑어 gen_cost가 있는 첫 실행을 쓴다 —
  // scan 등 다른 커맨드의 실행 로그가 사이에 끼어 있기 때문이다.
  for (const name of names) {
    let entry: RunLogEntry;
    try {
      const line = readFileSync(path.join(runsDirAbs, name), "utf8").split("\n")[0] ?? "";
      if (line.trim().length === 0) continue;
      entry = parseRunLogEntry(JSON.parse(line));
    } catch {
      continue; // 이 파일은 못 읽었다 — 다음 것을 본다. 0으로 대체하지 않는다.
    }
    if (entry.gen_cost !== undefined) return entry.gen_cost;
  }
  return null;
}

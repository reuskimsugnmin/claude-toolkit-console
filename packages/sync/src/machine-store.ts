import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertNoRawPathLeaks, machineJsonPath, type Machine } from "@ctk/core";

/**
 * sync/src/machine-store.ts — `machines/<machine_id>/machine.json`(카탈로그 결정 2). alias만
 * 담고 실제 호스트명·홈 경로는 금지한다(Minor 8) — 호출자(cli)가 이미 정제된 `Machine` 레코드를
 * 넘긴다고 가정하고, 이 모듈은 위생 검사 후 존재하지 않을 때만 쓴다(최초 1회, 이후에는 alias를
 * 조용히 덮어쓰지 않는다 — 사용자가 명시적으로 바꾸기 전까지는 안정적이어야 한다).
 */
export function ensureMachine(catalogRoot: string, machine: Machine): { path: string; created: boolean } {
  assertNoRawPathLeaks(machine);
  const relPath = machineJsonPath(machine.id);
  const absPath = path.join(catalogRoot, relPath);
  if (existsSync(absPath)) {
    return { path: absPath, created: false };
  }
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, `${JSON.stringify(machine, null, 2)}\n`, "utf8");
  return { path: absPath, created: true };
}

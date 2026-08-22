import { readFileSync } from "node:fs";
import path from "node:path";
import { collectTree, type TreeCollectCache } from "@ctk/probe";
import {
  claudeJsonSemanticVerdict,
  SEALED_LIVE_CLAUDE_JSON_ALLOWED_CHURN_KEYS,
  TIER2_CHURN_ALLOWLIST_SEALED_LIVE,
  verdict as treeDiffVerdict,
  type ClaudeJsonSemanticVerdict,
  type FileEntry,
  type TreeDiffVerdict,
} from "@ctk/core";

/**
 * gen/src/tree-audit.ts — AC-3.7 "gen 실행 전후 config 트리 diff". `gen`은 `actuator`를 import할
 * 수 없으므로(계층 lint) `actuator/src/audit.ts`를 재사용하지 않는다 — 판정기(`core/guard/*`)와
 * 수집기(`probe/tree-collect.ts`)는 공유하되, 배선은 여기서 gen 전용으로 새로 한다(H1: "판정기가
 * core에 있어야 이 AC가 구현 가능하다"는 요구가 바로 이 상황을 가리킨다).
 *
 * `actuator`의 감사와 다른 점: gen은 config 루트 **하나**만 본다(프로젝트 루트를 건드리지
 * 않는다), Tier1(ctk 소유 정확 일치)가 없다 — gen은 config dir에 **의도적으로 쓰는 파일이
 * 하나도 없다**(전부 `claude` 서브프로세스의 부수효과일 뿐이다). 그래서 허용목록은 항상
 * `TIER2_CHURN_ALLOWLIST_SEALED_LIVE`(AC-0.11 실측) 하나뿐이다.
 */

export interface ConfigDirSnapshot {
  entries: FileEntry[];
  collectErrors: number;
  cache: TreeCollectCache;
}

export function captureConfigDirSnapshot(configDirAbs: string, cache?: TreeCollectCache): ConfigDirSnapshot {
  const result = collectTree(configDirAbs, cache);
  return { entries: result.entries, collectErrors: result.errors, cache: result.cache };
}

function fsErrorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? (err as { code?: string }).code : undefined;
}

export function readClaudeJsonRawOrNull(configDirAbs: string): string | null {
  try {
    return readFileSync(path.join(configDirAbs, ".claude.json"), "utf8");
  } catch (err) {
    if (fsErrorCode(err) === "ENOENT") return null;
    throw err;
  }
}

export interface SealedLiveAuditResult {
  verdict: TreeDiffVerdict;
  claudeJsonSemantic: ClaudeJsonSemanticVerdict | null;
  incompleteObservation: boolean;
}

function claudeJsonTouchedAsChurn(v: TreeDiffVerdict): boolean {
  const all = [...v.added, ...v.modified];
  return all.some((entry) => entry.path === ".claude.json" && entry.status === "allowed_churn");
}

function readJsonOrThrow(configDirAbs: string): unknown {
  const raw = readClaudeJsonRawOrNull(configDirAbs);
  if (raw === null) return {};
  return JSON.parse(raw) as unknown;
}

/**
 * `sealed-live` 세션 1회(또는 배치) 전후의 실제 `CLAUDE_CONFIG_DIR` 스냅샷을 판정한다.
 * baseline은 항상 `TIER2_CHURN_ALLOWLIST_SEALED_LIVE`다(C2 — "실제 홈 변경 0건"이 아니라
 * 허용목록 기준).
 */
export function auditSealedLiveConfigDir(
  configDirAbs: string,
  before: ConfigDirSnapshot,
  after: ConfigDirSnapshot,
  claudeJsonBeforeRaw: string | null,
): SealedLiveAuditResult {
  const verdict = treeDiffVerdict(before.entries, after.entries, TIER2_CHURN_ALLOWLIST_SEALED_LIVE);

  let claudeJsonSemantic: ClaudeJsonSemanticVerdict | null = null;
  if (claudeJsonTouchedAsChurn(verdict)) {
    const beforeValue = claudeJsonBeforeRaw !== null ? (JSON.parse(claudeJsonBeforeRaw) as unknown) : {};
    const afterValue = readJsonOrThrow(configDirAbs);
    claudeJsonSemantic = claudeJsonSemanticVerdict(beforeValue, afterValue, SEALED_LIVE_CLAUDE_JSON_ALLOWED_CHURN_KEYS);
  }

  const incompleteObservation = before.collectErrors > 0 || after.collectErrors > 0;
  return { verdict, claudeJsonSemantic, incompleteObservation };
}

export function sealedLiveAuditPassed(result: SealedLiveAuditResult): boolean {
  if (result.incompleteObservation) return false;
  if (result.verdict.overallStatus === "violation") return false;
  if (result.claudeJsonSemantic !== null && result.claudeJsonSemantic.overallStatus === "violation") return false;
  return true;
}

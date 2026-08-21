import type { HomeContext } from "../home.js";
import { readClaudeJsonFile } from "./known-projects.js";

/**
 * probe/src/sources/settings.ts — `~/.claude.json`의 `skillUsage`/`pluginUsage` 직독(plan §4 Step 3,
 * AC-4.9 교차검증 소스). §1.3 결정 5 "호출 실적의 교차 검증 소스" — 1차 값은 항상 트랜스크립트
 * 파싱 결과이고, 여기서 얻는 값은 `harness_usage_count`/`harness_last_used_at`로 **나란히** 저장될
 * 뿐 자동 보정에 쓰이지 않는다.
 *
 * `pluginUsage`의 키는 `name@marketplace`(Asset.id와 동형, 실측) · `skillUsage`의 키는 스킬 이름
 * 베어 형태다(실측). `lastUsedAt`은 epoch ms로 실려 있어 여기서 ISO 8601로 변환한다.
 */
export interface HarnessUsageEntry {
  usageCount: number;
  lastUsedAt: string;
}

export interface HarnessUsageResult {
  skillUsage: Record<string, HarnessUsageEntry>;
  pluginUsage: Record<string, HarnessUsageEntry>;
}

function toEntries(record: Record<string, { usageCount: number; lastUsedAt: number }> | undefined): Record<string, HarnessUsageEntry> {
  if (record === undefined) return {};
  const result: Record<string, HarnessUsageEntry> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = { usageCount: value.usageCount, lastUsedAt: new Date(value.lastUsedAt).toISOString() };
  }
  return result;
}

export function collectHarnessUsage(home: HomeContext): HarnessUsageResult {
  const claudeJson = readClaudeJsonFile(home);
  return {
    skillUsage: toEntries(claudeJson?.skillUsage),
    pluginUsage: toEntries(claudeJson?.pluginUsage),
  };
}

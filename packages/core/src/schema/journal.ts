import { z } from "zod";
import { machineDependentTag, schemaVersion } from "./common.js";

/** v1 이관 범위 — 플러그인 enablement 수정과 스킬 디렉터리 이동만 (스펙 Constraints). */
export const JournalActionSchema = z.enum(["move_plugin_enablement", "move_skill_dir", "rollback"]);
export type JournalAction = z.infer<typeof JournalActionSchema>;

export const JournalResultSchema = z.enum(["success", "failure", "rolled_back"]);
export type JournalResult = z.infer<typeof JournalResultSchema>;

/**
 * Journal — 머신 종속. actuator의 before/after 감사 레코드 (`journal/<iso8601>.jsonl`, 카탈로그 결정 2).
 * P1-5: actuator의 journal.ts는 레코드를 **반환만** 한다 — 저장소에 쓰는 주체는 sync/cli다.
 */
export const JournalEntrySchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineDependentTag,
    action: JournalActionSchema,
    asset_id: z.string().min(1),
    machine_id: z.string().min(1),
    before: z.record(z.string(), z.unknown()),
    after: z.record(z.string(), z.unknown()),
    backup_ref: z.string().min(1),
    result: JournalResultSchema,
    timestamp: z.string().datetime(),
  })
  .strict();

export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export function parseJournalEntry(data: unknown): JournalEntry {
  return JournalEntrySchema.parse(data);
}

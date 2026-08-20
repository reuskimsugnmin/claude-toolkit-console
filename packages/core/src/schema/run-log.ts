import { z } from "zod";
import { machineDependentTag, schemaVersion } from "./common.js";
import { FailureClassSchema } from "../failure/classes.js";

/**
 * RunLog — 머신 종속. §7 관측 가능성의 실행 로그(`runs/<iso8601>.jsonl`, 카탈로그 결정 2).
 * 자유 문자열·경로 원문 금지 — args는 값이 아니라 이미 정규화된 키만 담아야 한다(호출자 책임).
 */
export const RunLogEntrySchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineDependentTag,
    command: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    machine_id: z.string().min(1),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime().nullable(),
    exit_code: z.number().int().nullable(),
    failure_class: FailureClassSchema.nullable(),
    /** ctk doctor --managed-policy (R15) — Admin/policy(managed) 설정 존재 시 true */
    managed_policy_present: z.boolean().optional(),
  })
  .strict();

export type RunLogEntry = z.infer<typeof RunLogEntrySchema>;

export function parseRunLogEntry(data: unknown): RunLogEntry {
  return RunLogEntrySchema.parse(data);
}

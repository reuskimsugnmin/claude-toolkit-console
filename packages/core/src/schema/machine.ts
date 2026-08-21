import { z } from "zod";
import { machineDependentTag, schemaVersion } from "./common.js";

/**
 * Machine — 머신 종속. `machines/<machine_id>/machine.json`에 대응 (카탈로그 결정 2).
 * alias만 담고 실제 호스트명·홈 경로는 금지한다(Minor 8 — 역매핑은 카탈로그 밖 로컬 전용 파일에만 둔다).
 */
export const MachineSchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineDependentTag,
    id: z.string().min(1),
    /** 사람이 붙인 별칭. 실제 hostname/os.hostname() 원문 저장 금지 */
    alias: z.string().min(1),
    first_seen_at: z.string().datetime(),
  })
  .strict();

export type Machine = z.infer<typeof MachineSchema>;

export function parseMachine(data: unknown): Machine {
  return MachineSchema.parse(data);
}

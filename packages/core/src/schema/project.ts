import { z } from "zod";
import { machineDependentTag, schemaVersion } from "./common.js";

/**
 * Project — 머신 종속. 실제 절대경로는 카탈로그에 원문으로 저장하지 않는다
 * (카탈로그 결정 2 "경로 원문 금지 규칙"). `path_hash`만 남기고, 표시용 실경로 해석은
 * 카탈로그 밖의 로컬 전용 `~/.config/ctk/path-aliases.json`에서만 한다.
 */
export const ProjectSchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineDependentTag,
    machine_id: z.string().min(1),
    path_hash: z.string().min(1),
    /** 홈 상대 표기 시도값. 정규화 불가하면 null (snapshot/path-normalize.ts 참조) */
    home_relative_path: z.string().nullable(),
    first_seen_at: z.string().datetime(),
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;

export function parseProject(data: unknown): Project {
  return ProjectSchema.parse(data);
}

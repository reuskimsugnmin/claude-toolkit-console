import { z } from "zod";
import { machineDependentTag, schemaVersion } from "./common.js";

export const InstallScopeSchema = z.enum(["user", "project", "local"]);
export type InstallScope = z.infer<typeof InstallScopeSchema>;

/** OQ-7 안 C (2026-08-20 확정) — MCP 활성 상태를 읽어서 표시. 쓰기는 v1.1. */
export const McpEnabledStateSchema = z.enum(["enabled", "disabled", "unset"]);
export type McpEnabledState = z.infer<typeof McpEnabledStateSchema>;

export const McpStateSourceSchema = z.enum(["enabledMcpServers", "disabledMcpServers", "both", "none"]);
export type McpStateSource = z.infer<typeof McpStateSourceSchema>;

/**
 * Installation — 머신 종속 (P0-3, 스펙의 단일 `scope` 필드를 4개로 분해).
 *
 * - `install_scope` (읽기 전용) — `~/.claude/plugins/installed_plugins.json` 유래. 어느 레지스트리
 *   스코프로 설치되었는가. 스킬·MCP·CLI는 이 개념이 없으므로 null.
 * - `enabled_at` (쓰기 대상) — `settings.json`류의 `enabledPlugins` 유래. user/project/local 중
 *   어디에서 켜져 있는가. actuator의 `move`가 쓰는 유일한 필드.
 * - `mcp_enabled_state` / `mcp_state_source` (읽기 전용, OQ-7 안 C) — kind:"mcp" Asset에 대응하는
 *   Installation에만 채워지고 나머지 유형은 null.
 *
 * Installation은 (asset_id, machine_id, enabled_at, project_path_hash) 조합마다 1건씩 append된다
 * (P1-13 스코프 우선순위 규칙). 같은 자산이 3개 프로젝트에서 enabled면 3건이 정상 — 병합하지 않는다.
 */
export const InstallationSchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineDependentTag,
    asset_id: z.string().min(1),
    machine_id: z.string().min(1),
    install_scope: InstallScopeSchema.nullable(),
    enabled_at: InstallScopeSchema.nullable(),
    /** scope==="local" 대응 (AC-0.3 실측 — id 기준 "중복"은 실제로는 프로젝트별 local 설치). 원문 경로 금지 — path_hash만 */
    project_path_hash: z.string().nullable(),
    mcp_enabled_state: McpEnabledStateSchema.nullable(),
    mcp_state_source: McpStateSourceSchema.nullable(),
  })
  .strict();

/** zod 파싱 결과(전 필드 구조적으로 mutable). 저장/전송 형태의 참값. */
export type InstallationRecord = z.infer<typeof InstallationSchema>;

/**
 * install_scope · mcp_enabled_state · mcp_state_source는 읽기 전용이다 (P0-3, OQ-7 안 C).
 * "읽기 전용 보장을 문서가 아니라 타입으로" — actuator가 이 필드들에 대입하면 컴파일 오류가 난다.
 * enabled_at만 쓰기 대상이라 mutable로 남는다.
 */
export type Installation = Readonly<
  Omit<InstallationRecord, "enabled_at">
> & {
  enabled_at: InstallationRecord["enabled_at"];
};

export function parseInstallation(data: unknown): Installation {
  return InstallationSchema.parse(data) as Installation;
}

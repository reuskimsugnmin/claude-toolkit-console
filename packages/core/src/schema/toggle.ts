import { z } from "zod";
import { machineDependentTag, schemaVersion } from "./common.js";

/**
 * Toggle — 결정 7(claude.ai 커넥터·내장 기능 분류 정책, 착수 조건 C4)의 비-Asset 관측 레코드.
 *
 * AC-0.4ⓑ 실측: `enabledMcpServers`/`disabledMcpServers`는 "MCP 서버"만 담지 않는다 — 최소 4개
 * 기원(플러그인 제공 MCP·claude.ai 커넥터·project-local `.mcp.json`·내장 기능 토글)이 섞여 있다.
 * 이름 패턴으로 kind를 확정하지 않는다 — "로컬에서 정의를 찾을 수 있는가"로 판정하고, 이름 패턴은
 * 판정의 *근거*가 아니라 *출처 라벨*(classification_source)로만 남긴다.
 *
 * 비-Asset은 버리지 않고 원문을 보존한다 — 버리면 "언제부터 이 토글이 있었나"를 두 스냅샷 diff로
 * 복원할 수 없다(append-only 원칙).
 *
 * **`__kind: "toggle"`은 Asset과의 타입 수준 분리를 위한 판별 필드다** — Asset에는 이 필드가 없고
 * `kind`(AssetKind: plugin/skill/mcp/cli)를 요구하므로, Toggle을 Asset 타입 변수에 대입하면
 * `__kind`·`id`·`kind` 등 필수 필드 불일치로 컴파일 오류가 난다(착수 조건 C4).
 * 자리는 Step 1에서 만들고, 채우는 것(probe의 실제 관측)은 Step 2다.
 */
export const ToggleStateSchema = z.enum(["enabled", "disabled"]);

export const ToggleSourceFieldSchema = z.enum(["enabledMcpServers", "disabledMcpServers"]);

export const ToggleClassificationSourceSchema = z.enum([
  "definition_found", // 로컬에 정의를 찾음 (플러그인 제공 MCP / project-local .mcp.json)
  "name_pattern", // 이름 패턴으로만 추정 (예: "claude.ai <Name>" 커넥터)
  "unclassified", // 정의도 못 찾고 패턴도 안 맞음 (예: computer-use)
]);

export const ToggleSchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineDependentTag,
    __kind: z.literal("toggle"),
    project_path_hash: z.string().nullable(),
    name: z.string().min(1),
    state: ToggleStateSchema,
    source_field: ToggleSourceFieldSchema,
    classification_source: ToggleClassificationSourceSchema,
  })
  .strict();

export type Toggle = z.infer<typeof ToggleSchema>;

export function parseToggle(data: unknown): Toggle {
  return ToggleSchema.parse(data);
}

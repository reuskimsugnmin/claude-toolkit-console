import { z } from "zod";
import { machineIndependentTag, schemaVersion } from "./common.js";

/**
 * v1 Ontology의 4종 자산 유형. claude.ai 커넥터·내장 기능(computer-use 등)은
 * 여기 속하지 않는다 — 결정 7에 따라 비-Asset `toggles[]`로 별도 취급한다 (schema/toggle.ts).
 */
export const AssetKindSchema = z.enum(["plugin", "skill", "mcp", "cli"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/**
 * Asset — 머신 독립 (CLAUDE.md 스키마의 척추). "이 툴이 무엇인가"의 정체.
 * "이 로컬에 깔려 있나"(Installation)와 섞지 않는다.
 */
export const AssetSchema = z
  .object({
    schema_version: schemaVersion,
    _scope: machineIndependentTag,
    /** kind==="plugin"이면 `name@marketplace` 형식(AC-0.3 실측), 그 외 kind는 안정적인 고유 문자열 */
    id: z.string().min(1),
    kind: AssetKindSchema,
    name: z.string().min(1),
    /** plugin 전용 — id의 marketplace 부분과 동일해야 한다 */
    marketplace: z.string().optional(),
    description: z.string().optional(),
    /** 카탈로그 문서 생성의 원본 참조 (README/plugin.json/SKILL.md 경로 등) — 절대경로 금지, 상대 참조만 */
    source_ref: z.string().optional(),
    /**
     * 요구사항 6 — 이 툴의 출처 저장소 링크. plugin 전용이며(마켓플레이스가 있는 유형은 이것뿐),
     * `known_marketplaces.json`의 `@marketplace` 엔트리에서 유도한다.
     *
     * ⚠️ **`repo_source: "directory"`면 `repo_url`은 없다.** 로컬 디렉터리 마켓플레이스에는 원격
     * URL이 존재하지 않고, 그 자리에 있는 값은 개인 절대경로라 카탈로그에 넣을 수 없다(AC-1.7).
     * 두 필드를 함께 두는 이유가 이것이다 — "링크 없음"과 "아직 수집 안 됨"을 구분하려면
     * 출처 유형이 남아야 한다. 링크가 없다고 빈 문자열이나 추측한 URL을 넣지 않는다.
     */
    repo_url: z.string().optional(),
    repo_source: z.enum(["github", "git", "directory"]).optional(),
  })
  .strict()
  .superRefine((asset, ctx) => {
    if (asset.kind === "plugin" && asset.marketplace === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "kind=plugin인 Asset은 marketplace가 필요하다 (id의 name@marketplace 규약)",
        path: ["marketplace"],
      });
    }
  });

export type Asset = z.infer<typeof AssetSchema>;

export function parseAsset(data: unknown): Asset {
  return AssetSchema.parse(data);
}

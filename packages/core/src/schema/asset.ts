import { z } from "zod";
import { machineIndependentTag, schemaVersion } from "./common.js";
import { assertCatalogSegment, PathTraversalDetectedError } from "../catalog/layout.js";

/**
 * v1 Ontology의 자산 유형 — **B1 Step 2(2026-08-26)에서 4종 → 6종으로 넓힌다.**
 * `agent`·`command`는 플러그인이 번들한 하위 툴(B1 편입 대상, Step 5에서 실제로 채워진다).
 * **B1 Step 3(2026-08-26)에서 `Asset.parent_asset_id`를 추가한다** — 아래 `kindConstraint`를 본다.
 * claude.ai 커넥터·내장 기능(computer-use 등)은 여기 속하지 않는다 — 결정 7에 따라 비-Asset
 * `toggles[]`로 별도 취급한다 (schema/toggle.ts).
 *
 * ⚠️ **`agent`는 `usage/attribution.ts`의 `AttributionTargetKind`에도 같은 리터럴로 존재한다 —
 * 이름이 같을 뿐 다른 네임스페이스다.** 이 kind의 자산 id는 `<부모 플러그인id>:<이름>`(D2) 꼴이고,
 * `AttributionTargetKind`의 agent `ref`는 트랜스크립트가 준 맨 `subagent_type` 문자열이다.
 * 둘을 암묵적으로 대입하지 않는다 — 저 파일의 대응 주석을 함께 읽는다.
 */
export const AssetKindSchema = z.enum(["plugin", "skill", "mcp", "cli", "agent", "command"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

type FieldRule = "required" | "forbidden" | "optional";

interface KindConstraint {
  marketplace: FieldRule;
  parentAssetId: FieldRule;
}

/**
 * B1 결정 1 — `kind`에 대한 exhaustive switch로 `marketplace`·`parent_asset_id`를 **양방향**
 * 강제한다. 판별 유니온을 쓰지 않는 이유: `kind`는 판별자가 될 수 없다(`skill`은 독립·번들
 * 양쪽에 산다, D5). 새 kind 값이 추가되면 이 함수가 컴파일에서 깨진다(선례:
 * `gen/src/source-resolve.ts`의 `resolveAssetSource`).
 *
 * | kind | marketplace | parent_asset_id |
 * |---|---|---|
 * | plugin | 필수 | 금지 |
 * | agent · command | 금지 | 필수(번들로만 존재) |
 * | skill | 금지 | 선택(독립·번들 양쪽) |
 * | mcp · cli | 금지 | 금지 |
 */
function kindConstraint(kind: AssetKind): KindConstraint {
  switch (kind) {
    case "plugin":
      return { marketplace: "required", parentAssetId: "forbidden" };
    case "agent":
    case "command":
      return { marketplace: "forbidden", parentAssetId: "required" };
    case "skill":
      return { marketplace: "forbidden", parentAssetId: "optional" };
    case "mcp":
    case "cli":
      return { marketplace: "forbidden", parentAssetId: "forbidden" };
  }
}

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
    /**
     * B1 Step 3 — 이 자산을 번들한 부모 `Asset.id`(플러그인). `agent`·`command`는 필수(번들로만
     * 존재), `skill`은 선택(독립·번들 양쪽에 산다), 그 외 kind는 금지 — `kindConstraint`가 강제.
     * 있으면 `id === `${parent_asset_id}:${suffix}`` 형태여야 하고 `suffix`가
     * `assertCatalogSegment`를 통과해야 한다(아래 `superRefine`) — D2를 수집기 규약이 아니라
     * 스키마 불변식으로 올린다. 옛 `asset.json`(이 필드가 아예 없던 시절)은 `.strict()`+
     * `optional()`이므로 그대로 통과한다(AC-7).
     */
    parent_asset_id: z.string().min(1).optional(),
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
    const constraint = kindConstraint(asset.kind);

    if (constraint.marketplace === "required" && asset.marketplace === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "kind=plugin인 Asset은 marketplace가 필요하다 (id의 name@marketplace 규약)",
        path: ["marketplace"],
      });
    }
    if (constraint.marketplace === "forbidden" && asset.marketplace !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `kind=${asset.kind}인 Asset은 marketplace를 가질 수 없다 (plugin 전용)`,
        path: ["marketplace"],
      });
    }

    if (constraint.parentAssetId === "required" && asset.parent_asset_id === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `kind=${asset.kind}인 Asset은 parent_asset_id가 필요하다 (번들로만 존재)`,
        path: ["parent_asset_id"],
      });
    }
    if (constraint.parentAssetId === "forbidden" && asset.parent_asset_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `kind=${asset.kind}인 Asset은 parent_asset_id를 가질 수 없다`,
        path: ["parent_asset_id"],
      });
    }

    // 구조 불변식(D2를 스키마로 승격) — parent_asset_id가 있으면 id는
    // `${parent_asset_id}:${suffix}` 형태여야 하고 suffix가 안전한 카탈로그 세그먼트여야 한다.
    if (asset.parent_asset_id !== undefined) {
      const prefix = `${asset.parent_asset_id}:`;
      if (!asset.id.startsWith(prefix) || asset.id.length === prefix.length) {
        ctx.addIssue({
          code: "custom",
          message: `parent_asset_id가 있으면 id는 "\${parent_asset_id}:<suffix>" 형태여야 한다 (실제: ${asset.id})`,
          path: ["id"],
        });
      } else {
        const suffix = asset.id.slice(prefix.length);
        try {
          assertCatalogSegment("id의 접미사", suffix);
        } catch (err) {
          const message =
            err instanceof PathTraversalDetectedError
              ? err.message
              : "parent_asset_id가 있는 id의 접미사가 안전한 카탈로그 세그먼트가 아니다";
          ctx.addIssue({ code: "custom", message, path: ["id"] });
        }
      }
    }
  });

export type Asset = z.infer<typeof AssetSchema>;

export function parseAsset(data: unknown): Asset {
  return AssetSchema.parse(data);
}

/**
 * `parent_asset_id`를 안전하게 좁힌다 — 소비자가 각자 `!== undefined`를 재발명하면
 * 안전 원칙 5("만든 것 vs 배선한 것")가 된다. `undefined`(필드 부재)와 명시적 "부모 없음"을
 * 구분할 필요가 없는 소비자(뷰 렌더링 등)를 위한 좁힘 헬퍼.
 */
export function bundledParentId(asset: Pick<Asset, "parent_asset_id">): string | null {
  return asset.parent_asset_id ?? null;
}

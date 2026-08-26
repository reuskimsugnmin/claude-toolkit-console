import { GEN_SOURCE_TRUST_HEADER, type Asset, type GenSourceTrust } from "@ctk/core";

/**
 * gen/src/source-trust.ts — iter 8 · B1-4 (§1.3 결정 6 부속 「신뢰 경계」 통제 4).
 *
 * `gen_source_trust`(`marketplace` | `local` | `unknown`)를 판정하고, `usage.md`/`annotation.md`
 * 상단에 항상 고정 문구를 붙인다. 이 판정은 **Asset이 이미 갖고 있는, scan 시점에 이미 검증된
 * 필드만** 본다 — gen이 새로 무언가를 추정하지 않는다(P2, R18).
 *
 * 고정 문구 자체는 `core/catalog/render-markdown.ts`의 `GEN_SOURCE_TRUST_HEADER`를 그대로
 * 재노출한다(단일 관문 — 렌더러와 검사기가 같은 값을 보게 한다).
 */

export { GEN_SOURCE_TRUST_HEADER };

/**
 * exhaustive switch(B1 Step 2, 결정 2 #14) — `plugin`만 다르게 판정하고 나머지는 전부 같은
 * `source_ref` 규칙을 쓴다는 사실을 새 kind가 추가될 때마다 컴파일이 재확인하게 만든다.
 */
export function determineSourceTrust(asset: Asset): GenSourceTrust {
  switch (asset.kind) {
    case "plugin":
      // Asset 스키마 불변식(asset.ts superRefine) — kind:"plugin"은 marketplace가 항상 있다.
      return "marketplace";
    case "skill":
    case "mcp":
    case "cli":
    case "agent":
    case "command":
      if (asset.source_ref !== undefined && asset.source_ref.length > 0) {
        return "local";
      }
      return "unknown";
  }
}

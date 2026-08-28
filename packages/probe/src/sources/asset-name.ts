import { PathTraversalDetectedError, assertCatalogSegment } from "@ctk/core";

/**
 * probe/src/sources/asset-name.ts — 서드파티가 짓는 이름을 **자산 id 세그먼트로 승격시키기
 * 직전에** 검사하는 단일 관문(보안 재심 M-2·L-10, 2026-08-28).
 *
 * ⚠️ **왜 파일로 뽑았나 — `validateInstallPath`와 똑같은 형태의 결함이었다.** 이 판정은
 * `sources/bundled.ts`의 **private 함수**였고, 그래서 번들 축만 보호받았다. `sources/mcp.ts`의
 * `collectMcp`는 `.mcp.json`·`~/.claude.json`의 **최상위 키를 그대로** `Asset.id`로 썼다 —
 * 검사 없이. 방어가 한 파일에 갇혀 있으면 다른 축은 있는 줄도 모른다(M-B와 같은 교훈).
 *
 * ## 무엇을 막나
 *
 * - **`:`** — id 구분자다(`<부모id>:<kind>:<suffix>`). 접미사에 들어가면 id 인코딩이
 *   prefix-free가 아니게 되어 서로 다른 조합이 **같은 문자열로 접힌다**(재심 S-1). 더 나아가
 *   저장소에 담겨 배포되는 프로젝트 `.mcp.json`이 `"<플러그인id>:mcp:x"`를 자칭하면 번들 자산과
 *   id가 겹쳐 `mergeAssets`가 `DuplicateAssetIdError`로 **`ctk scan` 전체를 죽인다**(M-2).
 *   fail-closed지만 빠져나갈 길이 없으므로 **그 항목 하나만** 건너뛴다.
 * - **경로 순회·구분자** — `assertCatalogSegment`(`..`·`/`·`\\`·NUL·빈 문자열).
 * - **제어문자와 과길이**(L-10) — `assertCatalogSegment`는 이 둘을 보지 않는다. 이전 호출자는
 *   전부 frontmatter `name`(파서가 줄 단위로 자른다)이나 파일명이라 개행이 표현될 수 없었는데,
 *   **JSON 키는 임의 바이트를 담는다.** 개행이 든 키는 카탈로그 디렉터리 이름과 DocPage 제목에
 *   개행을 넣고, 300바이트 이름은 카탈로그 쓰기에서 `ENAMETOOLONG`을 낸다.
 */

/**
 * 카탈로그 세그먼트 길이 상한. 실제 경로는 `<name>__<id 해시8>`이라 이름 외에 10바이트가 더
 * 붙고 대부분의 파일시스템 상한은 255바이트다. **여유를 크게 두고 자른다** — 이 상한에 걸리는
 * 정상 자산은 실측상 없다(최장 실측 이름은 30바이트대).
 */
export const MAX_ASSET_NAME_BYTES = 100;

/** 제어문자(개행·탭·NUL 포함). JSON 키에는 표현 가능하지만 경로·제목에 들어가면 안 된다. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 자칭 이름이 안전한 카탈로그 세그먼트인지 **스캔 시점에** 판정한다(쓰기 시점이 아니라).
 * 통과하지 못하면 `null` — 호출자는 **그 항목 하나만 건너뛰고 부모 전체를 죽이지 않는다.**
 *
 * `context`는 예외 메시지용이며 사용자에게 노출되지 않는다(경로·원문을 담지 않는다).
 */
export function safeAssetNameSegment(candidate: string, context: string): string | null {
  if (candidate.includes(":")) return null;
  if (CONTROL_CHARS.test(candidate)) return null;
  if (Buffer.byteLength(candidate, "utf8") > MAX_ASSET_NAME_BYTES) return null;
  try {
    assertCatalogSegment(context, candidate);
    return candidate;
  } catch (err) {
    if (err instanceof PathTraversalDetectedError) return null;
    throw err;
  }
}

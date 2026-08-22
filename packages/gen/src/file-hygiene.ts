import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * gen/src/file-hygiene.ts — iter 8 · H2.
 *
 * ⓐ `lstat`으로 심볼릭 링크를 거부한다(또는 `realpath`가 자산 루트 밖이면 거부) —
 *    `SKILL.md`가 `~/.ssh/id_rsa`의 링크면 그 내용이 카탈로그 문서에 박혀 저장소로 동기화된다.
 * ⓑ 파일 크기 상한.
 * ⓒ 출력 경로는 ctk 생성 id(`asset.kind`+`asset.name`, scan 단계에서 이미 확정된 값)에서만
 *    산출한다 — frontmatter·LLM 출력의 어떤 문자열도 경로 산출에 쓰지 않는다. 이 파일은
 *    `core/catalog/layout.ts`의 경로 빌더(`usageMdPath`/`annotationMdPath`)를 그대로 재사용할
 *    뿐 별도 경로 조합 로직을 갖지 않는다(`ctk/no-adhoc-path-guard` lint 대상 회피 목적이
 *    아니라 애초에 재구현할 이유가 없다 — 단일 관문 원칙, C2와 동형).
 * ⓓ 최종 경로가 카탈로그 루트 하위인지는 `sync`(유일한 쓰기 주체)의 `catalog-boundary.ts`가
 *    쓰기 시점에 최종 확인한다(3계층 심층방어의 마지막 층) — gen은 쓰지 않으므로 이 층을 갖지
 *    않고, 대신 `usageMdPath`/`annotationMdPath`가 이미 거치는 `assertCatalogSegment()`가
 *    gen 쪽의 방어선이다.
 */

export const DEFAULT_MAX_ASSET_SOURCE_BYTES = 200_000;

/**
 * 위생 검사가 **그 자산의 원문 읽기를 거부**했음을 뜻하는 공통 기반.
 *
 * 공통 기반이 필요한 이유: 호출자(`plan.ts`)가 "이 자산만 건너뛴다"와 "실행을 중단한다"를
 * 갈라야 하는데, 에러 클래스가 각각이면 `instanceof`를 나열해야 하고 **새 위생 규칙이
 * 추가될 때 그 나열을 빠뜨린다.** 그러면 새 규칙 하나가 다시 전체 실행을 죽인다.
 */
export abstract class FileHygieneError extends Error {
  abstract readonly failureClass: string;
}

export class SymlinkAssetSourceRejectedError extends FileHygieneError {
  readonly failureClass = "path_traversal_detected" as const;
  constructor(readonly targetPath: string) {
    super(`자산 원본 파일이 심볼릭 링크다 — 링크를 따라가지 않고 거부한다: ${targetPath}`);
    this.name = "SymlinkAssetSourceRejectedError";
  }
}

export class AssetSourceTooLargeError extends FileHygieneError {
  readonly failureClass = "asset_source_too_large" as const;
  constructor(
    readonly targetPath: string,
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(`자산 원본 파일이 크기 상한을 초과한다(${sizeBytes} > ${maxBytes}): ${targetPath}`);
    this.name = "AssetSourceTooLargeError";
  }
}

/**
 * `absPath`가 심볼릭 링크가 아닌지 확인한다. `lstatSync`(링크 자체의 stat, 대상을 따라가지
 * 않음)를 쓴다 — `statSync`를 쓰면 링크를 투명하게 따라가 검사 자체가 무의미해진다.
 */
export function assertNotSymlink(absPath: string): void {
  const stat = lstatSync(absPath);
  if (stat.isSymbolicLink()) {
    throw new SymlinkAssetSourceRejectedError(absPath);
  }
}

/**
 * 심층 방어 — 심볼릭 링크가 아니어도 `absPath`의 realpath가 기대 루트(자산이 발견된 디렉터리)
 * 밖이면 거부한다. 하드 링크·bind mount 등 심볼릭 링크 검사 하나로 잡히지 않는 경로 우회에
 * 대한 두 번째 경계.
 *
 * ⚠️ 루트 쪽도 `realpathSync`로 정규화한다 — macOS의 `/tmp`·`/var/folders/...`처럼 **시스템
 * 임시 디렉터리 자체가 심볼릭 링크**인 경우, `absPath`만 realpath로 풀고 루트는 `path.resolve`
 * (심볼릭 링크를 건드리지 않음)만 쓰면 둘의 기준이 어긋나 정상 경로까지 오탐으로 거부된다.
 * 양쪽을 같은 기준(실제 파일시스템 경로)으로 맞춰야 비교가 의미 있다.
 */
export function assertRealpathWithinRoot(absPath: string, expectedRootAbs: string): void {
  const real = realpathSync(absPath);
  const root = realpathSync(expectedRootAbs);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new SymlinkAssetSourceRejectedError(absPath);
  }
}

export function assertWithinSizeLimit(absPath: string, maxBytes: number = DEFAULT_MAX_ASSET_SOURCE_BYTES): void {
  const stat = statSync(absPath);
  if (stat.size > maxBytes) {
    throw new AssetSourceTooLargeError(absPath, stat.size, maxBytes);
  }
}

/**
 * 자산 원본 파일 하나를 안전하게 읽는다 — 심볼릭 링크 거부 → realpath 루트 검사 → 크기 상한
 * → 읽기. 이 함수를 거치지 않고 `gen`이 자산 원본을 읽지 않는다(단일 관문).
 */
export function readAssetSourceFileSafely(
  absPath: string,
  expectedRootAbs: string,
  maxBytes: number = DEFAULT_MAX_ASSET_SOURCE_BYTES,
): string {
  assertNotSymlink(absPath);
  assertRealpathWithinRoot(absPath, expectedRootAbs);
  assertWithinSizeLimit(absPath, maxBytes);
  return readFileSync(absPath, "utf8");
}

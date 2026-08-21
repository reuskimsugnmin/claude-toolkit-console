import path from "node:path";

/**
 * sync/src/catalog-boundary.ts — 카탈로그 쓰기의 **최종 방어선**(심층방어 3계층 중 3층).
 *
 * 1층: `core/catalog/layout.ts`의 `assertCatalogSegment()` — 세그먼트 단위 검증
 * 2층: 각 스토어가 layout의 경로 빌더만 쓰도록 강제하는 lint(`ctk/no-adhoc-path-guard`)
 * 3층: **이 파일** — 조립이 끝난 절대경로가 카탈로그 루트 안인지 최종 확인
 *
 * 1·2층은 "세그먼트가 안전한가"를 보지만, 경로 조립 자체가 잘못되거나(`path.join` 인자 순서
 * 실수, 미래에 추가될 빌더가 관문을 안 거침) 심볼릭 링크로 루트 밖을 가리키면 잡지 못한다.
 * 이 층은 **무엇이 어떻게 조립됐든** 최종 결과가 루트 밖이면 거부한다 — Step 5 보안 심사가
 * 요구한 "심층방어 3계층"의 마지막 층이며, 앞의 두 층이 뚫려도 여기서 멈춘다.
 */
export class CatalogBoundaryViolationError extends Error {
  readonly failureClass = "forbidden_path_write" as const;
  constructor(
    readonly absPath: string,
    readonly catalogRoot: string,
  ) {
    super(
      `카탈로그 루트 밖으로의 쓰기를 거부한다 — 대상이 루트 안에 있어야 한다.\n` +
        `  대상: ${absPath}\n  루트: ${catalogRoot}`,
    );
    this.name = "CatalogBoundaryViolationError";
  }
}

/**
 * `absPath`가 `catalogRoot` 내부(또는 루트 자신)인지 확인한다. 심볼릭 링크는 해석하지 않는다 —
 * 여기서 `realpath`를 쓰면 아직 만들어지지 않은 경로(정상적인 첫 쓰기)가 실패한다. 링크를 통한
 * 탈출은 상위 계층(수집·판정)의 심볼릭 링크 정책이 담당한다.
 */
export function assertInsideCatalog(catalogRoot: string, absPath: string): void {
  const root = path.resolve(catalogRoot);
  const target = path.resolve(absPath);
  if (target === root) return;
  if (!target.startsWith(root + path.sep)) {
    throw new CatalogBoundaryViolationError(target, root);
  }
}

/** 경로를 조립하면서 최종 방어선을 함께 통과시킨다. 스토어는 `path.join` 대신 이 함수를 쓴다. */
export function catalogAbsPath(catalogRoot: string, relPath: string): string {
  const absPath = path.join(catalogRoot, relPath);
  assertInsideCatalog(catalogRoot, absPath);
  return absPath;
}

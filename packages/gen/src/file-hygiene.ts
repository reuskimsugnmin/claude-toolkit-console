import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * gen/src/file-hygiene.ts — iter 8 · H2.
 *
 * ⓐ `lstat`으로 심볼릭 링크를 거부한다(또는 `realpath`가 자산 루트 밖이면 거부) —
 *    `SKILL.md`가 `~/.ssh/id_rsa`의 링크면 그 내용이 카탈로그 문서에 박혀 저장소로 동기화된다.
 * ⓑ 파일 크기 상한.
 * ⓒ [원문: B1 Step 1(2026-08-26) 이전] 출력 경로는 ctk 생성 id(`asset.kind`+`asset.name`,
 *    scan 단계에서 이미 확정된 값)에서만 산출한다 — frontmatter·LLM 출력의 어떤 문자열도
 *    경로 산출에 쓰지 않는다.
 *    **왜 바뀌었는가**: `(kind, name)`만으로는 경로가 정해지지 않았다 — 이름이 같고 `id`가
 *    다른 자산(번들 하위 툴이 들어오면 실제로 발생)이 같은 디렉터리를 공유해 서로의 문서를
 *    조용히 덮었다(`assetDir(kind,name)` 시절의 결함, `core/catalog/layout.ts` 참조).
 *    지금은 `usageMdPath`/`annotationMdPath`가 **`asset.id`도 함께** 받아 `<name>__<id의
 *    sha256 앞 8자>`를 세그먼트로 쓴다 — id 역시 scan 단계에서 이미 확정된 값이고 원문·LLM
 *    출력에서 오지 않으므로 "경로는 frontmatter·LLM 출력에서 오지 않는다"는 원래 보장은
 *    그대로 유지된다(축이 `(kind,name)`에서 `(kind,name,id)`로 넓어졌을 뿐이다). 이 파일은
 *    여전히 `core/catalog/layout.ts`의 경로 빌더(`usageMdPath`/`annotationMdPath`)를 그대로
 *    재사용할 뿐 별도 경로 조합 로직을 갖지 않는다(`ctk/no-adhoc-path-guard` lint 대상 회피
 *    목적이 아니라 애초에 재구현할 이유가 없다 — 단일 관문 원칙, C2와 동형).
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
  /**
   * 거부된 파일의 절대경로. **메시지에는 넣지 않는다** — 이 값은 `gen_estimate`의 성공 본문을
   * 타고 브라우저까지 나가고(심사 M1), 홈 밖 프로젝트 스킬이면 홈 상대화로도 가려지지 않아
   * 디렉터리 구조가 그대로 노출된다(심사 L-b). 로컬 디버깅용으로 필드에만 둔다.
   */
  abstract readonly targetPath: string;
}

export class SymlinkAssetSourceRejectedError extends FileHygieneError {
  readonly failureClass = "path_traversal_detected" as const;
  constructor(readonly targetPath: string) {
    super("자산 원본 파일이 심볼릭 링크다 — 링크를 따라가지 않고 거부한다");
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
    // 크기는 경로가 아니므로 남긴다 — 사용자가 무엇을 줄여야 하는지 알아야 한다.
    super(`자산 원본 파일이 크기 상한을 초과한다(${sizeBytes} > ${maxBytes}바이트)`);
    this.name = "AssetSourceTooLargeError";
  }
}

/**
 * 보안 심사 M-1 — FIFO는 `statSync`에서 size가 0으로 보고되므로 크기 상한 검사를 그냥
 * 통과하고, 그 뒤 `readFileSync`가 영구 블록된다(EXIT=124로 실증). 심볼릭 링크 검사와
 * 별개의 축이다 — FIFO는 링크가 아니다. 열기 전에 일반 파일인지 확인한다.
 */
export class AssetSourceNotAFileError extends FileHygieneError {
  readonly failureClass = "asset_source_not_a_file" as const;
  constructor(readonly targetPath: string) {
    super("자산 원본 경로가 일반 파일이 아니다(FIFO·소켓·디바이스 등) — 열지 않는다");
    this.name = "AssetSourceNotAFileError";
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
  // FIFO를 여기서 먼저 거부한다 — size 0으로 아래 상한 검사를 통과시켜 놓고 `readFileSync`가
  // 영구 블록되게 두지 않는다(M-1).
  if (!stat.isFile()) {
    throw new AssetSourceNotAFileError(absPath);
  }
  if (stat.size > maxBytes) {
    throw new AssetSourceTooLargeError(absPath, stat.size, maxBytes);
  }
}

/**
 * 자산 원본 파일 하나를 안전하게 읽는다 — 심볼릭 링크 거부 → realpath 루트 검사 → 크기 상한
 * → 읽기. 이 함수를 거치지 않고 `gen`이 자산 원본을 읽지 않는다(단일 관문).
 */
/**
 * `existsSync` 확인과 실제 읽기 사이에 파일이 사라졌다 — 경합·마운트 변경·깨진 링크.
 *
 * ⚠️ **위생 계층 안에서 분류한다.** 예전에는 `plan.ts`가 `resolveAssetSource` **전체**의
 * ENOENT를 잡았는데, 그러면 설정 디렉터리 읽기 실패 같은 진짜 결함까지 "자산 1건 건너뜀"으로
 * 묻힌다(심사 L-c) — 바로 그 파일의 주석이 경계한 broadening이다. 여기서 던지면 이미 만든
 * `FileHygieneError` 계층이 그 일을 대신하고 포획 범위가 이 함수로 좁혀진다.
 */
export class AssetSourceMissingError extends FileHygieneError {
  readonly failureClass = "asset_source_missing" as const;
  constructor(readonly targetPath: string) {
    super("원문 파일이 읽는 시점에 사라졌다");
    this.name = "AssetSourceMissingError";
  }
}

/**
 * 심볼릭 링크를 **조건부로** 허용하기 위한 봉쇄 루트.
 *
 * ⚠️ **화이트리스트가 아니라 봉쇄 조건이다.** `realpathSync`가 `..`·중첩 링크를 모두 해소한
 * **뒤에** 판정하므로 그 축의 경로 조작으로는 빠져나갈 수 없다. 루트를 지정하지 않으면
 * 심볼릭 링크는 **전부 거부**된다(기존 동작).
 *
 * ⚠️ **막지 못하는 것을 정확히 적는다**(보안 심사 M-1·M-3):
 * - **TOCTOU** — 검사(`lstat`·`realpath`·`stat`)와 `readFileSync`가 경로를 각각 해소하므로
 *   그 사이에 링크가 바뀌면 검사와 다른 파일을 읽는다. 실측 우회율 **11%**(선재 결함이지만
 *   링크를 허용하면서 창이 넓어졌다). 닫으려면 fd를 한 번 열어 `fstat`+`fd 읽기`로 묶어야 한다.
 * - **하드 링크** — `realpathSync`는 하드 링크를 되짚지 않는다. 봉쇄 안에 만든 하드 링크는
 *   대상이 밖이어도 통과한다. 이것은 봉쇄 도입 **이전에도** 통과하던 경로다.
 *
 * 즉 "원래 우려가 완전히 막힌다"는 **심볼릭 링크에 한해서만** 참이다.
 *
 * **왜 필요한가**(2026-08-24 실측). 이 환경의 위생 거부 54건이 전부 스킬이었고, 링크 대상이
 * **100% `<configDir>/skills/` 안**이었다 — 툴 하나가 자기 스킬 81개를 한 디렉터리에 두고 각각을
 * 최상위로 링크하는 설치 방식이었다. 링크를 일률 거부하니 **자산의 30%가 영영 문서를 못 만들었다.**
 *
 * ⚠️ **봉쇄 루트를 넓히지 마라.** `<configDir>` 전체로 넓히면 `.credentials.json`·`settings.json`
 * 이 사정권에 들어온다. 실측상 필요도 없다 — 54건 전부 `skills/` 안이다.
 */
export interface AssetSourceHygieneOptions {
  /**
   * 지정하면 realpath가 **이 루트들 중 하나** 안에 있고 **파일명이 같은** 심볼릭 링크만 따라간다.
   * 미지정이거나 빈 배열이면 링크는 전부 거부된다(fail-closed).
   *
   * ⚠️ **목록이어야 한다**(심사 M-2). 스킬 발견 루트는 user 스코프 하나가 아니라 프로젝트마다
   * 하나씩 더 있다. 처음엔 user 루트 하나만 넘겨 **프로젝트 스코프 스킬의 링크가 전부 거부**됐다.
   */
  symlinkContainmentRoots?: readonly string[];
}

/**
 * 심볼릭 링크를 봉쇄 루트 안으로 한정해 허용한다. **두 축을 함께 본다.**
 *
 * ① **위치** — 해소된 realpath가 봉쇄 루트 중 하나 안이어야 한다.
 * ② **이름** — 해소된 대상의 파일명이 링크 자신의 파일명과 같아야 한다(심사 H-1).
 *
 * ⚠️ **②가 없으면 봉쇄 루트 안의 아무 파일이나 읽힌다.** 실증: `skills/evil/SKILL.md`를
 * `skills/victim/.env`나 `skills/.git/config`로 링크하면 그 내용이 카탈로그 문서에 박혀 저장소로
 * 동기화됐다. 도트파일 관리자가 `skills/`를 git 저장소로 심는 배치는 흔하고, 그 `.git/config`의
 * remote URL에는 토큰이 들어 있을 수 있다. 링크를 허용하기 **전에는 공집합**이던 위험이다.
 *
 * ②의 대가는 실측으로 0이다 — 이 환경의 심볼릭 링크 SKILL.md **55건의 대상 basename이 100%
 * `SKILL.md`**였다. 허용하려는 설치 방식은 "같은 이름의 파일을 다른 자리에 심는" 것뿐이다.
 *
 * ⚠️ **봉쇄 루트가 없으면 거부한다(fail-closed).** 루트의 ENOENT를 원문의 ENOENT와 섞으면
 * 가드 실패가 "원문이 사라졌다"로 오분류돼 사용자가 있지도 않은 드리프트를 조사하게 된다
 * (심사 M-2b, 안전 원칙 7).
 */
function assertSymlinkWithinContainment(absPath: string, roots: readonly string[]): void {
  if (path.basename(realpathSync(absPath)) !== path.basename(absPath)) {
    throw new SymlinkAssetSourceRejectedError(absPath);
  }
  const real = realpathSync(absPath);
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue; // 그 루트는 이 머신에 없다 — 판정 재료가 아니지 "원문 없음"이 아니다.
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return;
  }
  throw new SymlinkAssetSourceRejectedError(absPath);
}

export function readAssetSourceFileSafely(
  absPath: string,
  expectedRootAbs: string,
  maxBytes: number = DEFAULT_MAX_ASSET_SOURCE_BYTES,
  options: AssetSourceHygieneOptions = {},
): string {
  try {
    const containment = options.symlinkContainmentRoots;
    // ⚠️ **봉쇄는 교체가 아니라 추가다.** 처음엔 봉쇄 모드에서 판정 기준을 자산 루트 대신 봉쇄
    // 루트로 **바꿨는데**, 그러자 프로젝트 스코프 스킬(`<프로젝트>/.claude/skills/...`)이 전부
    // 걸렸다 — 그것들은 `<configDir>/skills/` 안에 있지 않다. 이미 문서가 있던 **22건이 새로
    // 차단**되는 회귀였고, 단위 테스트 1085개가 전부 통과하는 동안 **실환경 dry-run이 잡았다**
    // (픽스처가 전부 `skills/` 안이라 그 축이 표본에 없었다).
    //
    // 링크가 아닌 파일은 스코프와 무관하게 **원래 규칙 그대로**(자산 루트 안)이고, 봉쇄 루트는
    // **링크일 때만** 추가로 열어주는 문이다.
    if (lstatSync(absPath).isSymbolicLink()) {
      if (containment === undefined || containment.length === 0) {
        throw new SymlinkAssetSourceRejectedError(absPath);
      }
      assertSymlinkWithinContainment(absPath, containment);
    } else {
      assertRealpathWithinRoot(absPath, expectedRootAbs);
    }
    assertWithinSizeLimit(absPath, maxBytes);
    return readFileSync(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new AssetSourceMissingError(absPath);
    throw err;
  }
}

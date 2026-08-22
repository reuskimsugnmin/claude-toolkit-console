import { z } from "zod";

/**
 * `<config>/plugins/known_marketplaces.json` 스키마 — Step 6a 실측(read-only, 2026-08-22).
 *
 * **요구사항 6("GitHub 링크")의 유일한 데이터 소스다.** `installed_plugins.json`에도
 * `plugin list --json`에도 저장소 URL은 없다 — 플러그인 id의 `@marketplace` 부분을 이 파일에서
 * 찾아야 출처가 나온다.
 *
 * 실측 형태(엔트리 16건 전수): `{ "<marketplace>": { source, installLocation, lastUpdated,
 * autoUpdate? } }`. `source.source`는 세 값이 관측됐다 — `github`(12) · `git`(3) · `directory`(1).
 *
 * ⚠️ **`directory` 출처에는 URL이 없고, 대신 개인 절대경로가 있다.** 그 `path`를 카탈로그에
 * 넣으면 AC-1.7(경로 원문 금지)을 정면으로 위반한다. 이 모듈은 경로를 **파싱은 하되 밖으로
 * 내보내지 않는다** — `toRepoUrl()`이 `directory`에 대해 `null`을 반환하는 이유다.
 * "링크 없음"을 빈 문자열이나 추측한 URL로 메우지 않는다(안전 원칙 7).
 *
 * `installed_plugins.json`과 같은 이유로 `.passthrough()`를 쓴다 — 하네스 내부 레지스트리라
 * 드리프트 위험이 크고, 모르는 키로 파싱이 깨져 링크가 통째로 비는 편이 더 나쁘다.
 */

const GithubSourceSchema = z.object({ source: z.literal("github"), repo: z.string().min(1) }).passthrough();
const GitSourceSchema = z.object({ source: z.literal("git"), url: z.string().min(1) }).passthrough();
/** `path`를 스키마에 두는 것은 파싱을 통과시키기 위함이며, 값을 밖으로 내보내지는 않는다. */
const DirectorySourceSchema = z.object({ source: z.literal("directory"), path: z.string().min(1) }).passthrough();

export const MarketplaceSourceSchema = z.union([GithubSourceSchema, GitSourceSchema, DirectorySourceSchema]);
export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;

export const KnownMarketplaceEntrySchema = z
  .object({
    source: MarketplaceSourceSchema,
    installLocation: z.string().optional(),
    lastUpdated: z.string().optional(),
    autoUpdate: z.boolean().optional(),
  })
  .passthrough();

export type KnownMarketplaceEntry = z.infer<typeof KnownMarketplaceEntrySchema>;

export const KnownMarketplacesFileSchema = z.record(z.string(), KnownMarketplaceEntrySchema);
export type KnownMarketplacesFile = z.infer<typeof KnownMarketplacesFileSchema>;

export function parseKnownMarketplacesFile(data: unknown): KnownMarketplacesFile {
  return KnownMarketplacesFileSchema.parse(data);
}

/** 출처 유형 — 링크가 없는 경우에도 **왜 없는지**가 남아야 화면이 "미수집"과 "로컬 출처"를 구분한다. */
export type RepoSourceKind = MarketplaceSource["source"];

export interface RepoLink {
  kind: RepoSourceKind;
  /** `directory` 출처는 항상 `null`이다 — 원격 URL이 존재하지 않는다. */
  url: string | null;
}

/**
 * 마켓플레이스 출처를 표시용 링크로 바꾼다. **경로는 절대 반환하지 않는다.**
 *
 * `git` 출처의 URL은 `.git` 접미사를 떼어 브라우저에서 열리는 형태로 만든다(실측값 예:
 * `https://github.com/openai/codex-plugin-cc.git`). 호스트를 가정하지 않으므로 GitHub가 아닌
 * git 원격도 그대로 통과한다 — 우리가 URL을 만들어내지 않고 원문을 정규화만 한다.
 */
export function toRepoLink(source: MarketplaceSource): RepoLink {
  switch (source.source) {
    case "github":
      // repo 슬러그에 `..`·`/`가 섞여도 결과는 https 출처를 벗어나지 못하므로 스킴 검증으로 충분하다.
      return { kind: "github", url: safeHttpUrlOrNull(`https://github.com/${source.repo}`) };
    case "git":
      return { kind: "git", url: safeHttpUrlOrNull(source.url.replace(/\.git$/, "")) };
    case "directory":
      return { kind: "directory", url: null };
  }
}

/** 링크로 렌더해도 되는 스킴. `javascript:`·`data:`·`file:`은 여기 없다. */
const SAFE_REPO_SCHEMES = new Set(["https:", "http:"]);

/**
 * 원문 URL이 **브라우저에서 링크로 만들어도 안전한 스킴**인지 확인한다. 아니면 `null`이다.
 *
 * ⚠️ **이 검사가 없으면 저장소 링크가 XSS가 된다**(보안 심사 H3). `known_marketplaces.json`은
 * 같은 머신의 다른 프로세스가 쓸 수 있는 파일이고(위협 모델 ⓒ), 거기에
 * `{"source":"git","url":"javascript:fetch(...)"}`를 넣으면 그 문자열이 `repo_url`로 카탈로그에
 * 들어가 콘솔 페이지의 `a.href`가 된다. CSP `script-src 'unsafe-inline'`은 `javascript:` URI를
 * 막지 못하므로 클릭 한 번에 페이지 출처에서 스크립트가 실행된다 — 액션 모드에서는 그것이
 * 곧 세션 토큰 탈취다.
 *
 * `git@host:path` 같은 scp 형식은 URL로 파싱되지 않으므로 링크로 만들지 않는다(값 자체는
 * `repo_source`로 남아 "링크 없음"과 "미수집"이 여전히 구분된다).
 */
function safeHttpUrlOrNull(raw: string): string | null {
  try {
    const url = new URL(raw);
    return SAFE_REPO_SCHEMES.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

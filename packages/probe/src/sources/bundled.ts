import { type Dirent, closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  PathTraversalDetectedError,
  assertCatalogSegment,
  normalizePath,
  type Asset,
  type AssetKind,
} from "@ctk/core";
import type { HomeContext } from "../home.js";
import { parseSimpleFrontmatter } from "../frontmatter.js";
import { listPluginInstallPaths } from "./plugins.js";
import {
  isRealPathWithinRealRoot,
  validateInstallPath,
  type InstallPathState,
  type ValidatedInstallPath,
} from "./install-path.js";

/**
 * probe/src/sources/bundled.ts — B1 Step 5. 플러그인이 번들한 스킬·커맨드·에이전트를 부모
 * 참조를 가진 Asset으로 편입한다.
 *
 * ⚠️ **`skills.ts`를 확장하지 않고 새 파일로 만든 이유(결정적)** — `skills.ts:101-110`의
 * `skillsRoots()`는 발견 루트인 동시에 `gen`의 심볼릭 링크 봉쇄 루트다
 * (`gen/src/source-resolve.ts:16-18`이 조립하지 않고 받아쓴다, 보안 심사 M-2·M-4). 여기에
 * 플러그인 캐시 루트를 넣으면 `gen`이 캐시 트리 안 심볼릭 링크를 허용하게 된다. 또
 * `collectSkills`는 `Installation`을 만드는데(`skills.ts:153-163`) 이 파일의 자식은 만들면
 * 안 된다(D6) — 나누면 AC-4가 런타임 성질이 아니라 **반환 타입의 성질**이 된다(아래
 * `BundledSourceResult`에 `installations` 필드가 없다).
 *
 * ⚠️ **경로 출처는 `installed_plugins.json`의 `installPath`를 그대로 읽는다.** 캐시 트리
 * 순회 금지, `<cache>/<mkt>/<name>/<ver>` 조립 금지 — 실측(architect): `installPath` 실재율
 * 100% · 캐시에는 버전 디렉터리가 둘 이상인 부모가 있고 semver가 아닌 버전 이름도 있으며 그중
 * `installed_plugins.json`이 참조하는 것은 0건(전부 고아)이다. 조립하면 고아를 설치된 것처럼
 * 세어 AC-1을 과대 계상한다.
 */

/**
 * ⚠️ `install-path.ts`의 `InstallPathState`를 그대로 쓴다(M-B). 두 곳에 같은 문자열 유니온을
 * 적어 두면 한쪽에 축이 늘 때 다른 쪽이 조용히 뒤처진다 — 판정과 표시가 같은 목록을 본다.
 */
export type BundledParentState = InstallPathState;

export interface BundledParentReport {
  parentId: string;
  state: BundledParentState;
  /** `number` = 읽었다(0이면 진짜 없음). `null` = 읽지 못했다(state가 "ok"가 아닐 때만). */
  skills: number | null;
  commands: number | null;
  agents: number | null;
  /** 건너뛴 심볼릭 링크 건수(3종 리프 합산) — 따라가지 않는다(보안 심사 항목 4). kind 디렉터리
   * 자체의 심볼릭 링크는 여기 섞지 않는다 — `kindDirSymlinksSkipped`를 본다. */
  symlinksSkipped: number;
  /** 자칭 name이 안전한 카탈로그 세그먼트가 아니어서 건너뛴 건수(경로 순회 방어). */
  unsafeNamesSkipped: number;
  /**
   * 보안 심사 H-1 — 같은 kind 안에서 자칭 name이 충돌해(예: 두 스킬이 frontmatter `name`을
   * 동일하게 자칭) 건너뛴 건수(3종 합산). **어느 쪽도 승자로 고르지 않는다** — 충돌한 이름은
   * 전부 제외한다(안전 원칙 6, CLAUDE.md: "충돌을 없애는 게 옳고 고르는 건 틀렸다"). 상세는
   * `reasons`.
   */
  duplicateNamesSkipped: number;
  /**
   * 보안 심사 M-1 — `skills`/`commands`/`agents` 디렉터리 **자체**가 심볼릭 링크이거나 realpath가
   * installPath 경계 밖이라 그 kind 전체를 건너뛴 횟수(0~3). `symlinksSkipped`(리프 단위)와
   * 섞지 않는다 — 섞으면 "없음"(진짜 0건)과 "거부"(열지 못해서 0건)가 뭉개진다.
   */
  kindDirSymlinksSkipped: number;
  /** commands/agents의 중첩 디렉터리 아래 발견된 .md 건수 — 이름 규약이 미실측이라 자산으로
   * 편입하지 않고 개수만 센다("미측정은 통과가 아니다" — CLAUDE.md). */
  nestedUnmeasured: number;
  /**
   * 보안 심사 M-2 — frontmatter 스캔 상한(64KB)을 넘어 앞부분만 잘라 읽은 건수(3종 합산).
   * 조용히 삼키지 않는다 — 대형 형제 파일이 있었다는 사실을 사용자가 볼 수 있어야 한다.
   */
  oversizeTruncated: number;
  /** 사람이 읽을 사유 로그. state가 "ok"가 아니면 그 사유가, "ok"여도 위 카운트가 0보다 크면
   * 각각의 상세가 담긴다. */
  reasons: string[];
}

export interface BundledSourceResult {
  assets: Asset[];
  // ⚠️ installations 필드가 아예 없다 — D6/AC-4를 반환 타입으로 고정한다. 자식은
  // `Installation`을 만들지 않는다(부모의 Installation이 이미 "이 로컬에 깔려 있나"를 말한다).
  perParent: BundledParentReport[];
}

export interface CollectBundledOptions {
  home: HomeContext;
  /** 편입 대상 부모 id 목록 — `collectPlugins()`가 이미 정체성을 확정한 플러그인 id만 받는다
   * (installed_plugins.json에만 있고 plugin-list 출력엔 없는 고아 id는 처리하지 않는다,
   * `plugins.ts`의 `knownAssetIds` 교차검증과 동형). */
  pluginIds: readonly string[];
}

/**
 * ⚠️ `installPath` 검증(`validateInstallPath`)과 그 보조 함수들은 **이 파일에 없다** —
 * `./install-path.ts`로 옮겼다(보안 심사 M-B). private으로 두었더니 플러그인 축
 * (`findPluginInstallPath` → `gen`의 `pluginSource`)이 같은 값을 **검증 없이** 읽기 루트로
 * 쓰고 있었다. 판정을 한 파일에 모아 두 축이 같은 함수를 부르게 한다.
 */

/**
 * 보안 심사 M-1 — kind 디렉터리(`skills`/`commands`/`agents`) **자체**가 심볼릭 링크이거나
 * realpath가 부모 installPath 경계 밖이면 그 kind 전체를 건너뛴다. 리프(SKILL.md·개별 .md)는
 * 각자 lstat으로 이미 방어돼 있지만(`scanBundledSkills`·`scanFlatMdKind`), kind 디렉터리
 * **자체**가 링크면 `readdirSync`가 그 링크를 투명하게 따라가 경계 밖 트리를 그대로
 * 열거·등재하고 `source_ref`가 경계 안처럼 정규화되어 유출이 감사에서 가려진다.
 *
 * 경계는 `<config>/plugins` 전체가 아니라 **이 부모의 검증된 installPath 자체**로 좁힌다 —
 * 그래야 kind 디렉터리 링크가 같은 `<config>/plugins` 경계 안의 **다른 플러그인** 캐시 디렉터리를
 * 가리키는 경우도 잡는다(넓은 경계만 쓰면 그 경우를 통과시킨다).
 */
function isKindDirRejected(kindDirAbs: string, installPathAbs: string): boolean {
  let stat;
  try {
    stat = lstatSync(kindDirAbs);
  } catch {
    return false; // 디렉터리 자체가 없다 — "없음"(readDirSafe가 뒤에서 처리), 거부 대상이 아니다.
  }
  if (stat.isSymbolicLink()) return true;
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = realpathSync(kindDirAbs);
    realRoot = realpathSync(installPathAbs);
  } catch {
    return false; // realpath 해석 실패는 여기서 "거부"로 승격하지 않는다(과잉 차단 방지) —
    // installPath 자체는 이미 validateInstallPath가 검증했으므로 이 실패는 사실상 도달하지 않는다.
  }
  return !isRealPathWithinRealRoot(realTarget, realRoot);
}

/** 자칭 name(frontmatter)이 안전한 카탈로그 세그먼트인지 **스캔 시점에** 강제한다(쓰기 시점이
 * 아니라) — 통과하지 못하면 그 하위 툴 하나만 건너뛰고 부모 전체를 죽이지 않는다. */
function safeSuffix(candidate: string): string | null {
  // ⚠️ `:`는 **id 구분자**다(`<부모id>:<kind>:<suffix>`) — 경로 안전과는 다른 축이라
  // `assertCatalogSegment`가 막아주지 않는다. 접미사에 `:`가 들어가면 id 인코딩이 prefix-free가
  // 아니게 되어, 부모 id에 `:`가 있는 경우 서로 다른 (부모,kind,이름) 조합이 **같은 문자열로
  // 접힌다**(재심 S-1). 오늘 이 머신의 플러그인 id에는 `:`가 없지만 **하네스가 그것을 금지한다는
  // 실측이 없다** — 미측정 전제에 id 유일성을 매달지 않는다.
  if (candidate.includes(":")) return null;
  try {
    assertCatalogSegment("번들 하위 툴의 자칭 name", candidate);
    return candidate;
  } catch (err) {
    if (err instanceof PathTraversalDetectedError) return null;
    throw err;
  }
}

function readDirSafe(dirAbs: string): Dirent[] {
  try {
    return readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return []; // 디렉터리 자체가 없다 — 진짜 "없음"(AC-8 네 번째 상태).
  }
}

interface DiscoveredBundledTool {
  suffix: string;
  absPath: string;
  description: string | undefined;
}

interface DirScanResult {
  found: DiscoveredBundledTool[];
  symlinksSkipped: number;
  unsafeNamesSkipped: number;
  /** 보안 심사 M-2 — frontmatter 스캔 상한(아래 `FRONTMATTER_SCAN_MAX_BYTES`)을 넘어 앞부분만
   * 잘라 읽은 건수. 파일 자체를 배제하지 않는다(뒤에 frontmatter가 없다고 가정할 근거가
   * 없다) — 다만 읽는 바이트 수를 상한으로 묶어 대형 형제 파일의 RSS 증폭을 막는다. */
  oversizeTruncated: number;
}

/** 보안 심사 M-2 — frontmatter 파싱용 스캔 읽기의 상한. `DEFAULT_MAX_ASSET_SOURCE_BYTES`
 * (200KB, gen이 최종 매칭된 파일 전체를 읽을 때 쓰는 상한)와는 **다른 축**이다 — 이 상한은
 * "매칭 전, 후보 전원"에 적용되므로 훨씬 작게 잡는다. frontmatter는 파일 앞부분에만 있으므로
 * 잘라 읽어도 정보 손실이 없다(닫는 `---`가 상한 밖에 있는 비정상 frontmatter만 예외이고,
 * 그건 `parseSimpleFrontmatter`가 빈 결과로 자연히 처리한다). */
const FRONTMATTER_SCAN_MAX_BYTES = 64 * 1024;

/**
 * 보안 심사 M-2 — `readFileSync`로 파일 전체를 통째 읽지 않고, 상한을 넘는 파일은 앞부분만
 * `readSync`로 잘라 읽는다. 실증: 27바이트 매칭 대상을 찾으면서 형제 60MB 파일이 상한 없이
 * 함께 읽혀 RSS +95MB였다 — 이 함수를 거치면 그 형제는 최대 64KB만 읽힌다.
 *
 * 매칭된 파일의 **전체** 내용은 이 함수가 아니라 `gen/file-hygiene.ts`의
 * `readAssetSourceFileSafely`가 별도로 다시 읽는다(200KB 상한) — 이 64KB는 스캔 전용이고
 * 최종 산출물에 쓰이지 않는다.
 */
function readHeadForFrontmatter(absPath: string, sizeBytes: number): { content: string; truncated: boolean } {
  if (sizeBytes <= FRONTMATTER_SCAN_MAX_BYTES) {
    return { content: readFileSync(absPath, "utf8"), truncated: false };
  }
  const fd = openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(FRONTMATTER_SCAN_MAX_BYTES);
    const bytesRead = readSync(fd, buf, 0, FRONTMATTER_SCAN_MAX_BYTES, 0);
    return { content: buf.subarray(0, bytesRead).toString("utf8"), truncated: true };
  } finally {
    closeSync(fd);
  }
}

/**
 * 스킬 — `<installPath>/skills/<dirName>/SKILL.md`(디렉터리). `skills.ts:26-38`의
 * `DiscoveredSkill` 계약을 복제한다: 경로에는 `dirent.name`(OS값)만 쓰고, 자칭 `name`
 * (frontmatter)은 정체(id 접미사)에만 쓴다 — 실측 사례(라우터 스킬이 다른 스킬 이름을 자칭)가
 * 이 분리가 필요한 이유다.
 */
function scanBundledSkills(pluginDirAbs: string): DirScanResult {
  const skillsDirAbs = path.join(pluginDirAbs, "skills");
  const found: DiscoveredBundledTool[] = [];
  let symlinksSkipped = 0;
  let unsafeNamesSkipped = 0;
  let oversizeTruncated = 0;

  for (const dirent of readDirSafe(skillsDirAbs)) {
    if (dirent.isSymbolicLink()) {
      symlinksSkipped++;
      continue;
    }
    if (!dirent.isDirectory()) continue;
    const skillDirAbs = path.join(skillsDirAbs, dirent.name);
    const skillMdAbs = path.join(skillDirAbs, "SKILL.md");
    let skillMdStat;
    try {
      skillMdStat = lstatSync(skillMdAbs);
    } catch {
      continue; // SKILL.md 없음 — 유효한 스킬 디렉터리가 아니다(skills.ts와 동일 판정).
    }
    if (skillMdStat.isSymbolicLink()) {
      // 디렉터리 자체는 심볼릭 링크가 아니어도 그 안의 SKILL.md만 링크일 수 있다 — 따로 검사한다.
      symlinksSkipped++;
      continue;
    }
    // 보안 심사 M-1 — `scanFlatMdKind`는 top-level `Dirent.isFile()`을 이미 보는데(아래) 이
    // 스캐너는 SKILL.md가 하위 디렉터리에 있어 `lstatSync`로 따로 얻은 stat에 대해 `isFile()`을
    // 본 적이 없었다 — 한 파일 안에서 두 스캐너의 축이 갈려 있었다. `SKILL.md`가 FIFO면
    // `readFileSync`가 영구 블록된다(EXIT=124로 실증) — 열기 전에 일반 파일인지 확인한다.
    if (!skillMdStat.isFile()) continue;
    let content: string;
    let truncated: boolean;
    try {
      ({ content, truncated } = readHeadForFrontmatter(skillMdAbs, skillMdStat.size));
    } catch {
      continue;
    }
    if (truncated) oversizeTruncated++;
    const frontmatter = parseSimpleFrontmatter(content);
    const claimedName = frontmatter.name && frontmatter.name.length > 0 ? frontmatter.name : dirent.name;
    const suffix = safeSuffix(claimedName);
    if (suffix === null) {
      unsafeNamesSkipped++;
      continue;
    }
    found.push({ suffix, absPath: skillDirAbs, description: frontmatter.description });
  }

  return { found, symlinksSkipped, unsafeNamesSkipped, oversizeTruncated };
}

interface FlatMdScanResult extends DirScanResult {
  nestedUnmeasured: number;
}

/**
 * 커맨드·에이전트 공용 저수준 스캐너 — 둘 다 `<installPath>/<kindDir>/*.md`(평면 파일)라는
 * 동일한 구조를 갖는다(스킬만 디렉터리 구조라 다르다). 이 함수 자체를 "3종 공용 워커"로 쓰지
 * 않는다 — 호출부(`collectBundled`)에서 "commands"/"agents"를 각각 별도로 호출하고 각자의
 * `kind`로 Asset을 만든다.
 *
 * ⚠️ **중첩 디렉터리(`commands/<subdir>/*.md`)는 자산으로 편입하지 않는다.** 실측(architect):
 * 이런 구조가 존재하지만 하네스가 중첩 커맨드를 어떤 이름으로 부르는지는 **미실측**이다(이
 * 머신 세션 기록에 호출 흔적 0건). 추측으로 채우지 않고 개수만 `nestedUnmeasured`로 센다.
 */
function scanFlatMdKind(kindDirAbs: string): FlatMdScanResult {
  const found: DiscoveredBundledTool[] = [];
  let symlinksSkipped = 0;
  let unsafeNamesSkipped = 0;
  let nestedUnmeasured = 0;
  let oversizeTruncated = 0;

  for (const dirent of readDirSafe(kindDirAbs)) {
    if (dirent.isSymbolicLink()) {
      symlinksSkipped++;
      continue;
    }
    if (dirent.isDirectory()) {
      // 중첩 디렉터리 — 이름 규약 미실측. 더 깊은 중첩은 내려가지 않는다(실측 범위 밖).
      for (const nested of readDirSafe(path.join(kindDirAbs, dirent.name))) {
        if (nested.isFile() && nested.name.endsWith(".md")) nestedUnmeasured++;
      }
      continue;
    }
    if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
    const fileAbs = path.join(kindDirAbs, dirent.name);
    // 보안 심사 M-1과 같은 축 — top-level Dirent.isFile()이 이미 참이지만, 읽기 직전에 한 번 더
    // lstat으로 확인한다(TOCTOU 창을 줄인다·크기도 이 호출로 함께 얻는다).
    let stat;
    try {
      stat = lstatSync(fileAbs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let content: string;
    let truncated: boolean;
    try {
      ({ content, truncated } = readHeadForFrontmatter(fileAbs, stat.size));
    } catch {
      continue;
    }
    if (truncated) oversizeTruncated++;
    const frontmatter = parseSimpleFrontmatter(content);
    const baseName = dirent.name.slice(0, -".md".length);
    const claimedName = frontmatter.name && frontmatter.name.length > 0 ? frontmatter.name : baseName;
    const suffix = safeSuffix(claimedName);
    if (suffix === null) {
      unsafeNamesSkipped++;
      continue;
    }
    found.push({ suffix, absPath: fileAbs, description: frontmatter.description });
  }

  return { found, symlinksSkipped, unsafeNamesSkipped, nestedUnmeasured, oversizeTruncated };
}

/** M-1 — kind 디렉터리 자체가 거부되면 리프를 아예 열지 않는다(readdirSync 자체를 안 부른다). */
function emptyDirScanResult(): DirScanResult {
  return { found: [], symlinksSkipped: 0, unsafeNamesSkipped: 0, oversizeTruncated: 0 };
}

function emptyFlatMdScanResult(): FlatMdScanResult {
  return { found: [], symlinksSkipped: 0, unsafeNamesSkipped: 0, nestedUnmeasured: 0, oversizeTruncated: 0 };
}

interface DedupedKindResult {
  kept: DiscoveredBundledTool[];
  duplicateNamesSkipped: number;
}

/**
 * 보안 심사 H-1 — 같은 kind 안에서 자칭 name(=suffix, 이미 `safeSuffix`를 통과한 값)이 충돌하면
 * **하나를 골라 승자로 삼지 않는다**(안전 원칙 6, CLAUDE.md: "충돌을 없애는 게 옳고 고르는 건
 * 틀렸다"). first-wins로 고르면 디렉터리 열거 순서(파일시스템 구현에 달렸다) 하나로 어느 쪽이
 * "진짜"인지가 결정되고, 공격자는 그 순서를 노려 다른 자식의 정체성을 가로챌 수 있다 — 이 함수는
 * 애초에 어느 쪽이 진짜인지 판정할 근거가 없다. 충돌한 이름은 **전부** 제외하고 개수만 센다
 * (부모도 스캔도 죽이지 않는다 — 안전 원칙 6·7).
 */
function dedupeSameKindNames(found: readonly DiscoveredBundledTool[]): DedupedKindResult {
  const counts = new Map<string, number>();
  for (const tool of found) counts.set(tool.suffix, (counts.get(tool.suffix) ?? 0) + 1);
  const kept = found.filter((tool) => counts.get(tool.suffix) === 1);
  return { kept, duplicateNamesSkipped: found.length - kept.length };
}

/**
 * 보안 심사 H-1 — id 축에 `kind`를 넣는다. 이전에는 `${parentId}:${suffix}`뿐이었는데, 한 부모가
 * 같은 이름을 다른 kind로 번들하면(예: `skills/ask/SKILL.md`(name: ask) + `commands/ask.md`)
 * kind가 다른 두 자산이 같은 id를 가졌다(실측: 이 머신에서 부모 66개 중 8개·64건). id에
 * `kind`를 넣으면 그 축의 충돌은 구조적으로 사라진다 — 중복 제거(dedup)가 아니라 축을 넓힌
 * 것이다(같은 kind 안의 진짜 이름 충돌은 여전히 `dedupeSameKindNames`가 별도로 막는다).
 *
 * ⚠️ `Asset.name`은 `kind`를 넣지 않은 평범한 이름(`tool.suffix`)을 그대로 유지한다 — 카탈로그
 * 경로(`catalog/assets/<kind>/<name>__<id해시8>`)의 세그먼트가 되므로 `:`가 들어가면 Windows에서
 * 불법이다. `id`의 접미사(`${kind}:${tool.suffix}`)는 `assertCatalogSegment`가 `:`를 막지 않으므로
 * 그대로 통과한다(`asset.ts`의 부모 참조 불변식은 수정하지 않는다 — 이 형태를 이미 받는다).
 */
function buildBundledAsset(home: HomeContext, parentId: string, kind: AssetKind, tool: DiscoveredBundledTool): Asset {
  const normalized = normalizePath(tool.absPath, home.ctkHome);
  return {
    schema_version: 1,
    _scope: "machine_independent",
    id: `${parentId}:${kind}:${tool.suffix}`,
    kind,
    name: tool.suffix,
    parent_asset_id: parentId,
    description: tool.description,
    source_ref: normalized.home_relative ?? `path_hash:${normalized.path_hash}`,
  };
}

/** `findBundledToolPath`가 다루는 kind — 번들로만 존재하는 셋(plugin·mcp·cli는 대상이 아니다). */
export type BundledChildKind = "skill" | "agent" | "command";

function kindDirName(kind: BundledChildKind): "skills" | "commands" | "agents" {
  switch (kind) {
    case "skill":
      return "skills";
    case "agent":
      return "agents";
    case "command":
      return "commands";
  }
}

export interface BundledToolLocation {
  /** 원문 파일의 실제 절대경로. 스킬은 **디렉터리**(SKILL.md의 부모) — `collectBundled`의
   * `DiscoveredBundledTool.absPath`와 같은 관용구다. agent·command는 `.md` 파일 자체. */
  absPath: string;
  /** 이 부모의 검증된 installPath 자체 — 읽기 봉쇄 루트로 쓴다. 전역 `<config>/plugins`가
   * 아니다(플러그인 A의 자식이 플러그인 B의 캐시를 읽지 못하게 경계를 좁힌다, M-1과 동형). */
  containmentRoot: string;
}

/** 부모 하나의 검증·스캔 결과 — `BundledToolLocationCache`가 부모 id로 메모이즈하는 단위. */
interface ParentScanCacheEntry {
  validated: ValidatedInstallPath;
  scans: Partial<Record<BundledChildKind, DirScanResult | FlatMdScanResult>>;
}

/**
 * 보안 심사 M-3 — `findBundledToolPath`가 자산마다(=호출마다) `installed_plugins.json`을 다시
 * 읽고 kind 디렉터리를 다시 순회·재읽기하던 것을 없앤다. 실측: 200자식 = `readFileSync` 40,000회
 * ·160MB를 읽어 산출은 0.8MB뿐이었다(O(N²)). `listPluginInstallPaths`를 도입한 원래 취지(주석
 * `plugins.ts:246-251`)가 바로 이 낭비를 없애는 것이었는데, `findBundledToolPath`가 그 절약을
 * 되돌렸다.
 *
 * 호출자가 이 캐시를 **직접 만들어 여러 호출에 걸쳐 재사용해야** 절약 효과가 난다 — 캐시
 * 인스턴스 하나가 "한 배치(예: `ctk gen` 1회 실행)" 단위다. 캐시를 매 호출마다 새로 만들면
 * (`findBundledToolPath`의 기본 인자처럼) 캐시가 없는 것과 동작이 같다 — 그것이 기본값의
 * 의도다: 캐시를 넘기지 않는 기존 호출부는 이전과 동일하게 매번 다시 읽는다(회귀 없음).
 */
export interface BundledToolLocationCache {
  installPaths: Map<string, string> | null;
  parents: Map<string, ParentScanCacheEntry>;
}

export function createBundledToolLocationCache(): BundledToolLocationCache {
  return { installPaths: null, parents: new Map() };
}

/**
 * `gen/src/source-resolve.ts`가 번들 자식(agent·command, 그리고 `parent_asset_id`가 있는
 * skill)의 실제 원문 경로를 되찾을 때 쓴다(보안 재심 L-3).
 *
 * ⚠️ **새로 구현하지 않는다** — `collectBundled`가 이미 만든 방어를 그대로 재사용한다:
 * `validateInstallPath`(절대성·존재·realpath 경계), `isKindDirRejected`(M-1, kind 디렉터리
 * 자체의 경계), `scanBundledSkills`/`scanFlatMdKind`(H6 — 경로는 `dirent.name`으로만 짓고
 * 자칭 name은 매칭에만 쓴다).
 *
 * `name`은 `Asset.name`(= 자칭 name, `buildBundledAsset`의 `tool.suffix`)과 비교한다 — 경로
 * 세그먼트로는 쓰지 않는다(H6).
 *
 * 반환은 배열이다 — `findSkillDirsById`와 같은 관용구. 0건이면 못 찾은 것(호출자가
 * `source_missing`으로), 1건이면 확정, **2건 이상이면 판정 불가**(호출자가 `ambiguous_source`로
 * — 어느 쪽이 진짜인지 이 함수는 판정하지 않는다, H-1과 같은 태도). `collectBundled`의
 * `dedupeSameKindNames`(승자를 고르지 않고 충돌을 전부 제외)는 여기서 쓰지 않는다 — 그러면
 * 호출자가 건수를 볼 수 없게 된다.
 *
 * `cache`(M-3) — 부모 단위 검증·스캔 결과를 메모이즈한다. 생략하면 매 호출 전용 캐시가 새로
 * 만들어져 이전과 동일하게 동작한다(캐시 없음과 동형) — 여러 호출에 걸쳐 절약하려면 호출자가
 * 하나의 캐시를 만들어 반복 호출에 넘겨야 한다(`planGenTargets`가 이렇게 쓴다).
 */
export function findBundledToolPath(
  home: HomeContext,
  parentAssetId: string,
  kind: BundledChildKind,
  name: string,
  cache: BundledToolLocationCache = createBundledToolLocationCache(),
): BundledToolLocation[] {
  if (cache.installPaths === null) {
    cache.installPaths = listPluginInstallPaths(home);
  }

  let parentEntry = cache.parents.get(parentAssetId);
  if (parentEntry === undefined) {
    const validated = validateInstallPath(home, cache.installPaths.get(parentAssetId));
    parentEntry = { validated, scans: {} };
    cache.parents.set(parentAssetId, parentEntry);
  }
  if (!parentEntry.validated.ok) return [];
  const containmentRoot = parentEntry.validated.absPath;

  let scan = parentEntry.scans[kind];
  if (scan === undefined) {
    const kindDirAbs = path.join(containmentRoot, kindDirName(kind));
    scan = isKindDirRejected(kindDirAbs, containmentRoot)
      ? kind === "skill"
        ? emptyDirScanResult()
        : emptyFlatMdScanResult()
      : kind === "skill"
        ? scanBundledSkills(containmentRoot)
        : scanFlatMdKind(kindDirAbs);
    parentEntry.scans[kind] = scan;
  }

  return scan.found.filter((tool) => tool.suffix === name).map((tool) => ({ absPath: tool.absPath, containmentRoot }));
}

export function collectBundled(options: CollectBundledOptions): BundledSourceResult {
  const { home, pluginIds } = options;
  const installPaths = listPluginInstallPaths(home);
  const assets: Asset[] = [];
  const perParent: BundledParentReport[] = [];

  for (const parentId of pluginIds) {
    const validated = validateInstallPath(home, installPaths.get(parentId));
    if (!validated.ok) {
      perParent.push({
        parentId,
        state: validated.state,
        skills: null,
        commands: null,
        agents: null,
        symlinksSkipped: 0,
        unsafeNamesSkipped: 0,
        duplicateNamesSkipped: 0,
        kindDirSymlinksSkipped: 0,
        nestedUnmeasured: 0,
        oversizeTruncated: 0,
        reasons: [validated.reason],
      });
      continue;
    }

    // 보안 심사 M-1 — 리프를 열기 전에 kind 디렉터리 자체의 경계를 먼저 확인한다. 거부되면
    // 그 kind는 아예 readdirSync하지 않는다(빈 결과로 대체) — 경계 밖 트리를 열거·등재하지 않는다.
    const skillsDirAbs = path.join(validated.absPath, "skills");
    const commandsDirAbs = path.join(validated.absPath, "commands");
    const agentsDirAbs = path.join(validated.absPath, "agents");
    const skillsKindDirRejected = isKindDirRejected(skillsDirAbs, validated.absPath);
    const commandsKindDirRejected = isKindDirRejected(commandsDirAbs, validated.absPath);
    const agentsKindDirRejected = isKindDirRejected(agentsDirAbs, validated.absPath);

    // AC-8 — 부모가 비활성이어도 그대로 수집한다(D6). 활성 여부는 여기서 아예 조회하지 않는다 —
    // 정체성(이 함수의 관심사)과 활성(부모의 Installation이 이미 말한다)을 섞지 않는다.
    const skillsScan = skillsKindDirRejected ? emptyDirScanResult() : scanBundledSkills(validated.absPath);
    const commandsScan = commandsKindDirRejected ? emptyFlatMdScanResult() : scanFlatMdKind(commandsDirAbs);
    const agentsScan = agentsKindDirRejected ? emptyFlatMdScanResult() : scanFlatMdKind(agentsDirAbs);

    // 보안 심사 H-1 — 같은 kind 안의 자칭 name 충돌을 자산화 직전에 제거한다(승자를 고르지 않고
    // 전부 제외). kind가 다른 동명 충돌은 `buildBundledAsset`의 id 축 확장만으로 이미 해소된다.
    const skillsDeduped = dedupeSameKindNames(skillsScan.found);
    const commandsDeduped = dedupeSameKindNames(commandsScan.found);
    const agentsDeduped = dedupeSameKindNames(agentsScan.found);

    for (const tool of skillsDeduped.kept) assets.push(buildBundledAsset(home, parentId, "skill", tool));
    for (const tool of commandsDeduped.kept) assets.push(buildBundledAsset(home, parentId, "command", tool));
    for (const tool of agentsDeduped.kept) assets.push(buildBundledAsset(home, parentId, "agent", tool));

    const reasons: string[] = [];
    if (skillsKindDirRejected)
      reasons.push("skills/: kind 디렉터리 자체가 심볼릭 링크이거나 realpath가 경계 밖이라 전체를 건너뜀");
    if (skillsScan.symlinksSkipped > 0) reasons.push(`skills/: 심볼릭 링크 ${skillsScan.symlinksSkipped}건 건너뜀`);
    if (skillsScan.unsafeNamesSkipped > 0)
      reasons.push(`skills/: 안전하지 않은 자칭 name ${skillsScan.unsafeNamesSkipped}건 건너뜀`);
    if (skillsDeduped.duplicateNamesSkipped > 0)
      reasons.push(`skills/: 같은 kind 안에서 자칭 name이 충돌해 ${skillsDeduped.duplicateNamesSkipped}건 건너뜀(어느 쪽도 승자로 고르지 않는다)`);
    if (commandsKindDirRejected)
      reasons.push("commands/: kind 디렉터리 자체가 심볼릭 링크이거나 realpath가 경계 밖이라 전체를 건너뜀");
    if (commandsScan.symlinksSkipped > 0) reasons.push(`commands/: 심볼릭 링크 ${commandsScan.symlinksSkipped}건 건너뜀`);
    if (commandsScan.unsafeNamesSkipped > 0)
      reasons.push(`commands/: 안전하지 않은 자칭 name ${commandsScan.unsafeNamesSkipped}건 건너뜀`);
    if (commandsDeduped.duplicateNamesSkipped > 0)
      reasons.push(`commands/: 같은 kind 안에서 자칭 name이 충돌해 ${commandsDeduped.duplicateNamesSkipped}건 건너뜀(어느 쪽도 승자로 고르지 않는다)`);
    if (commandsScan.nestedUnmeasured > 0)
      reasons.push(`commands/: 중첩 디렉터리의 .md ${commandsScan.nestedUnmeasured}건 — 이름 규약 미실측, 편입하지 않음(unmeasured)`);
    if (agentsKindDirRejected)
      reasons.push("agents/: kind 디렉터리 자체가 심볼릭 링크이거나 realpath가 경계 밖이라 전체를 건너뜀");
    if (agentsScan.symlinksSkipped > 0) reasons.push(`agents/: 심볼릭 링크 ${agentsScan.symlinksSkipped}건 건너뜀`);
    if (agentsScan.unsafeNamesSkipped > 0)
      reasons.push(`agents/: 안전하지 않은 자칭 name ${agentsScan.unsafeNamesSkipped}건 건너뜀`);
    if (agentsDeduped.duplicateNamesSkipped > 0)
      reasons.push(`agents/: 같은 kind 안에서 자칭 name이 충돌해 ${agentsDeduped.duplicateNamesSkipped}건 건너뜀(어느 쪽도 승자로 고르지 않는다)`);
    if (agentsScan.nestedUnmeasured > 0)
      reasons.push(`agents/: 중첩 디렉터리의 .md ${agentsScan.nestedUnmeasured}건 — 이름 규약 미실측, 편입하지 않음(unmeasured)`);
    if (skillsScan.oversizeTruncated > 0)
      reasons.push(`skills/: frontmatter 스캔 상한(${FRONTMATTER_SCAN_MAX_BYTES}바이트) 초과 ${skillsScan.oversizeTruncated}건 — 앞부분만 읽음`);
    if (commandsScan.oversizeTruncated > 0)
      reasons.push(`commands/: frontmatter 스캔 상한(${FRONTMATTER_SCAN_MAX_BYTES}바이트) 초과 ${commandsScan.oversizeTruncated}건 — 앞부분만 읽음`);
    if (agentsScan.oversizeTruncated > 0)
      reasons.push(`agents/: frontmatter 스캔 상한(${FRONTMATTER_SCAN_MAX_BYTES}바이트) 초과 ${agentsScan.oversizeTruncated}건 — 앞부분만 읽음`);

    perParent.push({
      parentId,
      state: "ok",
      skills: skillsDeduped.kept.length,
      commands: commandsDeduped.kept.length,
      agents: agentsDeduped.kept.length,
      symlinksSkipped: skillsScan.symlinksSkipped + commandsScan.symlinksSkipped + agentsScan.symlinksSkipped,
      unsafeNamesSkipped: skillsScan.unsafeNamesSkipped + commandsScan.unsafeNamesSkipped + agentsScan.unsafeNamesSkipped,
      duplicateNamesSkipped:
        skillsDeduped.duplicateNamesSkipped + commandsDeduped.duplicateNamesSkipped + agentsDeduped.duplicateNamesSkipped,
      kindDirSymlinksSkipped:
        (skillsKindDirRejected ? 1 : 0) + (commandsKindDirRejected ? 1 : 0) + (agentsKindDirRejected ? 1 : 0),
      nestedUnmeasured: commandsScan.nestedUnmeasured + agentsScan.nestedUnmeasured,
      oversizeTruncated: skillsScan.oversizeTruncated + commandsScan.oversizeTruncated + agentsScan.oversizeTruncated,
      reasons,
    });
  }

  return { assets, perParent };
}

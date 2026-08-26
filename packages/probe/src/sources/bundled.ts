import { type Dirent, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
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

export type BundledParentState = "ok" | "install_path_missing" | "install_path_rejected";

export interface BundledParentReport {
  parentId: string;
  state: BundledParentState;
  /** `number` = 읽었다(0이면 진짜 없음). `null` = 읽지 못했다(state가 "ok"가 아닐 때만). */
  skills: number | null;
  commands: number | null;
  agents: number | null;
  /** 건너뛴 심볼릭 링크 건수(3종 합산) — 따라가지 않는다(보안 심사 항목 4). */
  symlinksSkipped: number;
  /** 자칭 name이 안전한 카탈로그 세그먼트가 아니어서 건너뛴 건수(경로 순회 방어). */
  unsafeNamesSkipped: number;
  /** commands/agents의 중첩 디렉터리 아래 발견된 .md 건수 — 이름 규약이 미실측이라 자산으로
   * 편입하지 않고 개수만 센다("미측정은 통과가 아니다" — CLAUDE.md). */
  nestedUnmeasured: number;
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

function pluginsBoundaryRootAbs(home: HomeContext): string {
  return path.join(home.ctkConfigDir, "plugins");
}

type ValidatedInstallPath = { ok: true; absPath: string } | { ok: false; state: BundledParentState; reason: string };

/**
 * `installed_plugins.json`의 `installPath`는 `z.string()` + `.passthrough()`로만 검증돼 있다
 * (`core/harness/installed-plugins.schema.ts:21,30`) — 절대경로인지도 `..`를 담는지도 스키마
 * 단계에서 보지 않는다. 여기가 그 값을 `readdirSync`의 순회 루트로 승격시키기 **직전**이므로,
 * 순회를 시작하기 전에 ⓐ 절대경로인지 ⓑ `realpath` 해소 후에도 `<config>/plugins` 아래인지
 * 확인한다 — B1이 새로 여는 유일한 공격면(architect 심사 항목 1).
 */
function validateInstallPath(home: HomeContext, installPath: string | undefined): ValidatedInstallPath {
  if (installPath === undefined) {
    return { ok: false, state: "install_path_missing", reason: "installed_plugins.json에 installPath 항목이 없다" };
  }
  if (!path.isAbsolute(installPath)) {
    return { ok: false, state: "install_path_rejected", reason: `installPath가 절대경로가 아니다: ${installPath}` };
  }
  if (!existsSync(installPath)) {
    // 오늘 실재율 100%(architect 실측)이므로 부재는 드리프트 신호다 — "없음"이 아니라 "실패".
    return { ok: false, state: "install_path_missing", reason: `installPath가 디스크에 없다: ${installPath}` };
  }
  const boundaryRootAbs = pluginsBoundaryRootAbs(home);
  let realInstallPath: string;
  let realBoundaryRoot: string;
  try {
    realInstallPath = realpathSync(installPath);
    realBoundaryRoot = realpathSync(boundaryRootAbs);
  } catch {
    return { ok: false, state: "install_path_missing", reason: `installPath realpath 해석 실패: ${installPath}` };
  }
  if (realInstallPath !== realBoundaryRoot && !realInstallPath.startsWith(realBoundaryRoot + path.sep)) {
    return {
      ok: false,
      state: "install_path_rejected",
      reason: `installPath가 <config>/plugins 밖을 가리킨다(realpath 기준): ${installPath}`,
    };
  }
  // ⚠️ 이후 순회·`source_ref` 정규화는 realpath가 아니라 **원문 `installPath`**를 쓴다(검증에만
  // realpath를 쓰고, 값은 바꾸지 않는다). macOS는 시스템 임시 디렉터리 자체가 심볼릭 링크라
  // (`/tmp` → `/private/tmp`), realpath 결과를 그대로 쓰면 `home.ctkHome`(realpath를 거치지
  // 않는 원문)과 접두사가 어긋나 `normalizePath`의 홈 상대화가 깨진다(실측, 이 파일 테스트에서
  // 발견). 보안 검증과 이후 값의 기준을 분리한다 — `gen/file-hygiene.ts`의 `readAssetSourceFileSafely`도
  // 같은 원칙(검증은 realpath로, 실제 읽기는 원래 경로로)을 따른다.
  return { ok: true, absPath: installPath };
}

/** 자칭 name(frontmatter)이 안전한 카탈로그 세그먼트인지 **스캔 시점에** 강제한다(쓰기 시점이
 * 아니라) — 통과하지 못하면 그 하위 툴 하나만 건너뛰고 부모 전체를 죽이지 않는다. */
function safeSuffix(candidate: string): string | null {
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
    let content: string;
    try {
      content = readFileSync(skillMdAbs, "utf8");
    } catch {
      continue;
    }
    const frontmatter = parseSimpleFrontmatter(content);
    const claimedName = frontmatter.name && frontmatter.name.length > 0 ? frontmatter.name : dirent.name;
    const suffix = safeSuffix(claimedName);
    if (suffix === null) {
      unsafeNamesSkipped++;
      continue;
    }
    found.push({ suffix, absPath: skillDirAbs, description: frontmatter.description });
  }

  return { found, symlinksSkipped, unsafeNamesSkipped };
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
    let content: string;
    try {
      content = readFileSync(fileAbs, "utf8");
    } catch {
      continue;
    }
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

  return { found, symlinksSkipped, unsafeNamesSkipped, nestedUnmeasured };
}

function buildBundledAsset(home: HomeContext, parentId: string, kind: AssetKind, tool: DiscoveredBundledTool): Asset {
  const normalized = normalizePath(tool.absPath, home.ctkHome);
  return {
    schema_version: 1,
    _scope: "machine_independent",
    id: `${parentId}:${tool.suffix}`,
    kind,
    name: tool.suffix,
    parent_asset_id: parentId,
    description: tool.description,
    source_ref: normalized.home_relative ?? `path_hash:${normalized.path_hash}`,
  };
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
        nestedUnmeasured: 0,
        reasons: [validated.reason],
      });
      continue;
    }

    // AC-8 — 부모가 비활성이어도 그대로 수집한다(D6). 활성 여부는 여기서 아예 조회하지 않는다 —
    // 정체성(이 함수의 관심사)과 활성(부모의 Installation이 이미 말한다)을 섞지 않는다.
    const skillsScan = scanBundledSkills(validated.absPath);
    const commandsScan = scanFlatMdKind(path.join(validated.absPath, "commands"));
    const agentsScan = scanFlatMdKind(path.join(validated.absPath, "agents"));

    for (const tool of skillsScan.found) assets.push(buildBundledAsset(home, parentId, "skill", tool));
    for (const tool of commandsScan.found) assets.push(buildBundledAsset(home, parentId, "command", tool));
    for (const tool of agentsScan.found) assets.push(buildBundledAsset(home, parentId, "agent", tool));

    const reasons: string[] = [];
    if (skillsScan.symlinksSkipped > 0) reasons.push(`skills/: 심볼릭 링크 ${skillsScan.symlinksSkipped}건 건너뜀`);
    if (skillsScan.unsafeNamesSkipped > 0)
      reasons.push(`skills/: 안전하지 않은 자칭 name ${skillsScan.unsafeNamesSkipped}건 건너뜀`);
    if (commandsScan.symlinksSkipped > 0) reasons.push(`commands/: 심볼릭 링크 ${commandsScan.symlinksSkipped}건 건너뜀`);
    if (commandsScan.unsafeNamesSkipped > 0)
      reasons.push(`commands/: 안전하지 않은 자칭 name ${commandsScan.unsafeNamesSkipped}건 건너뜀`);
    if (commandsScan.nestedUnmeasured > 0)
      reasons.push(`commands/: 중첩 디렉터리의 .md ${commandsScan.nestedUnmeasured}건 — 이름 규약 미실측, 편입하지 않음(unmeasured)`);
    if (agentsScan.symlinksSkipped > 0) reasons.push(`agents/: 심볼릭 링크 ${agentsScan.symlinksSkipped}건 건너뜀`);
    if (agentsScan.unsafeNamesSkipped > 0)
      reasons.push(`agents/: 안전하지 않은 자칭 name ${agentsScan.unsafeNamesSkipped}건 건너뜀`);
    if (agentsScan.nestedUnmeasured > 0)
      reasons.push(`agents/: 중첩 디렉터리의 .md ${agentsScan.nestedUnmeasured}건 — 이름 규약 미실측, 편입하지 않음(unmeasured)`);

    perParent.push({
      parentId,
      state: "ok",
      skills: skillsScan.found.length,
      commands: commandsScan.found.length,
      agents: agentsScan.found.length,
      symlinksSkipped: skillsScan.symlinksSkipped + commandsScan.symlinksSkipped + agentsScan.symlinksSkipped,
      unsafeNamesSkipped: skillsScan.unsafeNamesSkipped + commandsScan.unsafeNamesSkipped + agentsScan.unsafeNamesSkipped,
      nestedUnmeasured: commandsScan.nestedUnmeasured + agentsScan.nestedUnmeasured,
      reasons,
    });
  }

  return { assets, perParent };
}

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { normalizePath, type Asset, type Installation } from "@ctk/core";
import type { HomeContext } from "../home.js";
import { scanFrontmatter } from "../frontmatter-scan.js";
import { listKnownProjectPaths } from "./known-projects.js";

/**
 * probe/src/sources/skills.ts — plan §4.1 Step 2.
 *
 * `<config>/skills/<name>/`와 `<project>/.claude/skills/<name>/`를 열거한다. `SKILL.md` 유무로
 * 유효한 스킬 디렉터리를 가리고, `.claude-plugin/plugin.json` 유무로 스킬과 플러그인을
 * 분기한다(P2-6) — 마켓플레이스 소스 트리 조각이 실수로 `skills/` 아래 놓여도 플러그인으로
 * 오분류하지 않고 건너뛴다.
 *
 * 스킬에는 `installed_plugins.json` 같은 별도 설치 레지스트리가 없다 — 디렉터리 존재 자체가
 * 곧 "그 스코프에서 활성"이므로 `enabled_at`을 발견 스코프로 채우고 `install_scope`는 null로
 * 둔다(Installation 스키마 주석과 일치: "스킬·MCP·CLI는 이 개념이 없으므로 null").
 */

export interface SkillSourceResult {
  assets: Asset[];
  installations: Installation[];
  /**
   * 3차 심사 L-A·L-B(2026-08-28) — frontmatter가 스캔 상한 안에서 **닫히지 않아** 판정할 수
   * 없었던 스킬 건수. 그 스킬들은 자칭 `name`·`description`을 쓰지 않고 디렉터리 이름으로
   * 떨어졌다(fail-closed).
   *
   * ⚠️ **이 필드가 없어서 이 축은 읽는 자리가 0이었다.** 번들 축은 `BundledParentReport`로
   * 건수를 올려 `scan.ts`가 경고로 옮기는데, **독립 스킬은 `truncated`를 읽지도 않았다** —
   * 그런데 실측상 독립 스킬이 번들보다 모집단이 더 크다. **신호를 만들면 읽는 자리를 함께
   * 만든다**(CLAUDE.md 안전 원칙 5). `scan.ts`가 이 값을 warnings로 옮긴다.
   */
  frontmatterUnmeasured: number;
  /**
   * 보안 재심 L-3 — `SKILL.md`가 일반 파일이 아니어서(FIFO·소켓·디바이스) 열지 않은 건수.
   * M-1 방어가 막는 바로 그 공격인데 **막히기만 하고 보고되지 않았다.**
   */
  notRegularFileSkipped: number;
  /** 보안 재심 L-4 — id 후보에 `:`가 있어 건너뛴 건수(번들 자식 id 참칭 · scan 전체 중단 방지). */
  unsafeIdSkipped: number;
}

interface DiscoveredSkill {
  id: string;
  /** 실제 디렉터리 이름(`dirent.name`) — OS가 반환한 값이라 경로 순회 세그먼트가 될 수 없다
   * (H6). `id`(frontmatter `name`)는 서드파티 저자가 자칭하는 값이라 실제 디렉터리와 다를 수
   * 있다 — 경로를 지을 때는 항상 `dirName`을 쓰고 `id`를 쓰지 않는다. */
  dirName: string;
  /** 이 스킬 디렉터리의 실제 절대경로 — `move`가 이동시킬 대상은 이 값이어야 한다(id로 경로를
   * 지어내지 않는다, H6). */
  absPath: string;
  description: string | undefined;
  scope: "user" | "project";
  projectPath: string | null;
}

function isPluginDirectory(skillDirAbs: string): boolean {
  return existsSync(path.join(skillDirAbs, ".claude-plugin", "plugin.json"));
}

interface SkillDirScan {
  found: DiscoveredSkill[];
  /** 판정 불가 건수 — 호출자가 합산해 사용자에게 드러낸다(L-B). */
  frontmatterUnmeasured: number;
  /** 보안 재심 L-3 — `SKILL.md`가 일반 파일이 아니어서(FIFO·소켓·디바이스) 열지 않은 건수. */
  notRegularFileSkipped: number;
  /** 보안 재심 L-4 — id 후보가 `:`를 담아 건너뛴 건수(번들 자식 id 참칭 방지). */
  unsafeIdSkipped: number;
}

function readSkillDir(skillsRootAbs: string, scope: "user" | "project", projectPath: string | null): SkillDirScan {
  let dirents;
  try {
    dirents = readdirSync(skillsRootAbs, { withFileTypes: true });
  } catch {
    return { found: [], frontmatterUnmeasured: 0, notRegularFileSkipped: 0, unsafeIdSkipped: 0 };
  }
  const found: DiscoveredSkill[] = [];
  let frontmatterUnmeasured = 0;
  let notRegularFileSkipped = 0;
  let unsafeIdSkipped = 0;
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const skillDirAbs = path.join(skillsRootAbs, dirent.name);
    if (isPluginDirectory(skillDirAbs)) continue; // P2-6 — 플러그인 디렉터리를 스킬로 오분류하지 않는다.
    const skillMdAbs = path.join(skillDirAbs, "SKILL.md");
    // ⚠️ 보안 3차 심사 M-A — `readFileSync`를 직접 부르지 않는다. 이 스캐너는 M-1을 고칠 때
    // **세지 않은 세 번째 스캐너**였고(번들 쪽 둘만 고쳤다), FIFO를 `SKILL.md`로 심으면
    // `ctk scan`·`ctk gen`·`ctk web`의 자산 상세 조회가 전부 영구 정지했다(EXIT=137로 실증).
    // 독립 스킬은 번들보다 모집단이 더 크다. 판정은 `frontmatter-scan.ts` 한 곳에 모여 있다.
    // ⚠️ 3차 심사 L-A — `readForFrontmatterScan` + `parseSimpleFrontmatter`를 각자 부르지 않는다.
    // 예전에는 그렇게 했고 `read.truncated`를 **읽지도 않았다**: 닫는 `---`가 상한 밖에 있으면
    // 파서가 끝까지 소비하며 last-write-wins를 적용하므로 상한 밖의 두 번째 `name:`이 판정을
    // 뒤집는다. `scanFrontmatter`는 판정 불가일 때 **빈 객체**를 주므로(fail-closed) 아래
    // `claimedName`이 자연히 `dirent.name`(OS 값)으로 떨어진다.
    const scan = scanFrontmatter(skillMdAbs);
    if (!scan.ok) {
      // 보안 재심 L-3 — "일반 파일 아님"은 M-1 방어가 막는 **공격 신호**인데, 예전에는
      // "SKILL.md 없음"(정상)과 똑같이 조용히 버려졌다. **막는 것과 보이는 것은 다른 축이다.**
      if (scan.reason === "not_a_regular_file") notRegularFileSkipped++;
      continue; // 유효한 스킬 디렉터리가 아니다.
    }
    if (scan.unmeasured !== null) frontmatterUnmeasured++;
    const frontmatter = scan.frontmatter;
    // ⚠️ 자칭 `name`에 `:`가 있으면 기각하고 실제 디렉터리명을 쓴다(재심 S-2). `:`는 번들 자식
    // id의 구분자이므로(`<부모id>:<kind>:<suffix>`, B1 Step 5), 독립 스킬이 그 형태를 자칭하면
    // 번들 자식과 id가 겹친다. 그때 `findSkillDirsById`는 **이 공격자 디렉터리 하나만** 후보로
    // 내놓는다 — 번들 스킬의 진짜 원본은 `skillsRoots()` 밖(플러그인 캐시)이라 후보에 오르지
    // 않기 때문이다. 모호성 신호 없이 `resolved: true`가 되어 `gen`이 그 파일을 읽는다.
    const claimedName = frontmatter.name ?? "";
    // ⚠️ **보안 재심 L-4(2026-08-28) — 폴백에도 같은 축을 적용한다.** 자칭 name에는 `:` 기각이
    // 있었는데 폴백값 `dirent.name`에는 없었다. `~/.claude/skills/omc:skill:ask/` 디렉터리를
    // 만들면 id가 번들 자식(`<부모id>:<kind>:<suffix>`)과 충돌하고 `mergeAssets`의
    // `DuplicateAssetIdError`가 **`ctk scan` 전체를 죽인다** — 빠져나갈 길 없는 fail-closed
    // DoS다(안전 원칙 6). 덮어쓰기는 일어나지 않지만(경로 세그먼트가 `<name>__<id해시8>`라
    // 갈린다) 스캔이 아예 못 돈다. 번들 축의 `safeSuffix`가 이미 쓰는 규칙을 여기에도 준다:
    // **그 스킬 하나만 건너뛰고 전체를 죽이지 않는다.**
    //
    // ⚠️ 선재 결함이다(`main`에도 있다). 다만 frontmatter fail-closed가 이 폴백에 도달하는
    // 경로를 하나 늘렸으므로 같은 변경에서 닫는다.
    const id = claimedName.length > 0 && !claimedName.includes(":") ? claimedName : dirent.name;
    if (id.includes(":")) {
      unsafeIdSkipped++;
      continue;
    }
    found.push({ id, dirName: dirent.name, absPath: skillDirAbs, description: frontmatter.description, scope, projectPath });
  }
  return { found, frontmatterUnmeasured, notRegularFileSkipped, unsafeIdSkipped };
}

/**
 * H6 — 스킬 자산 id(frontmatter `name`)에 대응하는 **실제 디렉터리**를 되찾는다. `id`를 곧바로
 * `path.join(root, "skills", id)`의 세그먼트로 쓰면(과거 `cli/move.ts`), frontmatter `name`이
 * 실제 디렉터리명과 다를 때(실측: 라우터 스킬이 다른 스킬의 이름을 자칭 — Step 2 커밋 7c069ab)
 * **엉뚱한 디렉터리를 이동시킨다.** 호출자는 이 함수가 돌려주는 항목 수로 판정한다 — 0건이면
 * 카탈로그가 드리프트됐다는 뜻이고, 2건 이상이면 어느 것이 진짜인지 판정 불가이므로 항상 거부한다
 * (추정으로 채우지 않는다, CLAUDE.md 안전 원칙과 동형).
 */
export function findSkillDirsById(home: HomeContext, assetId: string): DiscoveredSkill[] {
  const discovered: DiscoveredSkill[] = [];
  for (const root of skillsRoots(home)) {
    // ⚠️ 여기서는 `frontmatterUnmeasured`를 세지 않는다 — 이 함수는 **자산 하나를 되찾는**
    // 조회 경로이고 건수를 보고할 채널이 없다. 판정 불가의 결과(자칭 name 대신 디렉터리 이름)는
    // `readSkillDir`이 이미 적용했으므로 여기서 다시 판단할 것이 없고, 건수는 전수 수집
    // 경로(`collectSkills` → `scan.ts` warnings)가 보고한다. **한 신호를 두 곳에서 세지 않는다.**
    discovered.push(...readSkillDir(root.path, root.scope, root.projectPath).found);
  }
  return discovered.filter((d) => d.id === assetId);
}

/**
 * 스킬을 **발견하는 루트 전부**. 이 목록이 유일한 출처다.
 *
 * ⚠️ **발견 루트와 봉쇄 루트는 같은 목록에서 나와야 한다**(보안 심사 M-4). `gen`이 심볼릭 링크를
 * 조건부로 허용할 때 쓰는 봉쇄 루트가 이 목록과 어긋나면 두 결과 중 하나가 난다 — 발견은 되는데
 * 링크가 거부되거나(가용성 손실), 봉쇄가 발견 범위를 넘어선다(경계 손실). 실제로 봉쇄를 처음
 * 넣을 때 user 스코프 하나만 배선해 **프로젝트 스코프 스킬의 링크가 전부 거부됐다.**
 * 여기서 루트를 늘리면 봉쇄도 자동으로 따라온다.
 */
export interface SkillsRoot {
  path: string;
  scope: "user" | "project";
  projectPath: string | null;
}

export function skillsRoots(home: HomeContext): SkillsRoot[] {
  return [
    { path: path.join(home.ctkConfigDir, "skills"), scope: "user", projectPath: null },
    ...listKnownProjectPaths(home).map((projectPath) => ({
      path: path.join(projectPath, ".claude", "skills"),
      scope: "project" as const,
      projectPath,
    })),
  ];
}

export interface CollectSkillsOptions {
  home: HomeContext;
  machineId: string;
}

export function collectSkills(options: CollectSkillsOptions): SkillSourceResult {
  const { home, machineId } = options;

  const discovered: DiscoveredSkill[] = [];
  let frontmatterUnmeasured = 0;
  let notRegularFileSkipped = 0;
  let unsafeIdSkipped = 0;
  for (const root of skillsRoots(home)) {
    const scan = readSkillDir(root.path, root.scope, root.projectPath);
    discovered.push(...scan.found);
    frontmatterUnmeasured += scan.frontmatterUnmeasured;
    notRegularFileSkipped += scan.notRegularFileSkipped;
    unsafeIdSkipped += scan.unsafeIdSkipped;
  }

  const assetById = new Map<string, Asset>();
  const installations: Installation[] = [];
  // (asset_id, enabled_at, project_path_hash) 조합당 1건만 유지한다(installation.ts의 문서화된
  // 불변식). 실측(Step 2, 실환경 검증)으로 발견: 서로 다른 두 스킬 디렉터리가 SKILL.md 프론트매터
  // `name`을 동일하게 선언하면(예: 라우터 스킬이 실제 스킬과 같은 이름을 자칭) 같은 스코프에
  // 대해 동일 키의 Installation이 2건 생기고, 이는 diffById()가 판정 불가로 거부하는 대상이다
  // (packages/core/src/snapshot/diff.ts의 DuplicateKeyDiffError). 여기서는 첫 발견분을 채택해
  // 애초에 그런 입력이 스냅샷에 실리지 않게 막는다 — Asset 쪽 `assetById`가 이미 쓰는 것과 동일한
  // first-wins 정책이다. ⚠️ 이름 충돌 자체(두 디렉터리가 같은 이름을 자칭하는 것)는 여전히 사용자가
  // 알아야 할 신호이지만, v1 Installation 스키마에는 이를 표현할 필드가 없다 — 조용히 사라지지 않게
  // 최소한 판정 거부(diffById)로 드러나긴 하나, 근본 신호는 v1.1에서 스키마 확장으로 다뤄야 한다.
  const seenInstallationKeys = new Set<string>();

  for (const skill of discovered) {
    if (!assetById.has(skill.id)) {
      assetById.set(skill.id, {
        schema_version: 1,
        _scope: "machine_independent",
        id: skill.id,
        kind: "skill",
        name: skill.id,
        description: skill.description,
      });
    }
    const projectPathHash = skill.projectPath !== null ? normalizePath(skill.projectPath, home.ctkHome).path_hash : null;
    const installationKey = `${skill.id}|${skill.scope}|${projectPathHash ?? ""}`;
    if (seenInstallationKeys.has(installationKey)) continue;
    seenInstallationKeys.add(installationKey);
    installations.push({
      schema_version: 1,
      _scope: "machine_dependent",
      asset_id: skill.id,
      machine_id: machineId,
      install_scope: null,
      enabled_at: skill.scope,
      project_path_hash: projectPathHash,
      mcp_enabled_state: null,
      mcp_state_source: null,
    });
  }

  return { assets: [...assetById.values()], installations, frontmatterUnmeasured, notRegularFileSkipped, unsafeIdSkipped };
}

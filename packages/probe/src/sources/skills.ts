import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { normalizePath, type Asset, type Installation } from "@ctk/core";
import type { HomeContext } from "../home.js";
import { parseSimpleFrontmatter } from "../frontmatter.js";
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
}

interface DiscoveredSkill {
  id: string;
  description: string | undefined;
  scope: "user" | "project";
  projectPath: string | null;
}

function isPluginDirectory(skillDirAbs: string): boolean {
  return existsSync(path.join(skillDirAbs, ".claude-plugin", "plugin.json"));
}

function readSkillDir(skillsRootAbs: string, scope: "user" | "project", projectPath: string | null): DiscoveredSkill[] {
  let dirents;
  try {
    dirents = readdirSync(skillsRootAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: DiscoveredSkill[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const skillDirAbs = path.join(skillsRootAbs, dirent.name);
    if (isPluginDirectory(skillDirAbs)) continue; // P2-6 — 플러그인 디렉터리를 스킬로 오분류하지 않는다.
    const skillMdAbs = path.join(skillDirAbs, "SKILL.md");
    let content: string;
    try {
      content = readFileSync(skillMdAbs, "utf8");
    } catch {
      continue; // SKILL.md 없음 — 유효한 스킬 디렉터리가 아니다.
    }
    const frontmatter = parseSimpleFrontmatter(content);
    const id = frontmatter.name && frontmatter.name.length > 0 ? frontmatter.name : dirent.name;
    found.push({ id, description: frontmatter.description, scope, projectPath });
  }
  return found;
}

export interface CollectSkillsOptions {
  home: HomeContext;
  machineId: string;
}

export function collectSkills(options: CollectSkillsOptions): SkillSourceResult {
  const { home, machineId } = options;

  const discovered: DiscoveredSkill[] = [
    ...readSkillDir(path.join(home.ctkConfigDir, "skills"), "user", null),
  ];
  for (const projectPath of listKnownProjectPaths(home)) {
    discovered.push(...readSkillDir(path.join(projectPath, ".claude", "skills"), "project", projectPath));
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

  return { assets: [...assetById.values()], installations };
}

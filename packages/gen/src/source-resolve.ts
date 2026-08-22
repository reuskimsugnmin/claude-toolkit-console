import { existsSync } from "node:fs";
import path from "node:path";
import type { Asset } from "@ctk/core";
import { findPluginInstallPath, findSkillDirsById, type HomeContext } from "@ctk/probe";
import { readAssetSourceFileSafely } from "./file-hygiene.js";
import { type PromptEnvelopeSection } from "./prompt-envelope.js";

/**
 * gen/src/source-resolve.ts — 자산의 서드파티 원문(SKILL.md·README·plugin.json)이 **이 머신
 * 위 어디에 있는지**를 찾고, `file-hygiene.ts`의 안전한 읽기 경로로만 읽는다.
 *
 * ⚠️ 이 결과(절대경로)는 카탈로그에 **저장하지 않는다** — `Asset.source_ref`는 이미 scan
 * 단계(probe/sources/*)에서 홈 상대화·해시화된 값만 담는다(AC-1.7). 여기서 구한 절대경로는
 * **이번 gen 실행 안에서만** 파일을 읽는 데 쓰이고 버려진다.
 *
 * `kind: "mcp" | "cli"`는 로컬에 읽을 만한 정형 원문 파일이 없다(설정 파일 직독으로만 존재를
 * 확인하는 자산) — `Asset.description`(이미 카탈로그에 있는, scan이 검증한 값)만 원문 섹션으로
 * 쓴다.
 */

export interface ResolvedAssetSource {
  sections: PromptEnvelopeSection[];
  /** 픽스처/부재 등으로 원문을 하나도 못 찾았으면 true — 호출자는 이 자산을 rule_extract조차
   * 못 채우는 "빈 자산"으로 처리해야 한다. */
  empty: boolean;
}

function skillSource(home: HomeContext, asset: Asset): ResolvedAssetSource {
  const dirs = findSkillDirsById(home, asset.id);
  if (dirs.length !== 1) {
    // 0건(드리프트) 또는 2건 이상(모호) — 추정으로 채우지 않는다(H6과 동일 원칙).
    return { sections: [], empty: true };
  }
  const dir = dirs[0];
  if (dir === undefined) return { sections: [], empty: true };
  const skillMdAbs = path.join(dir.absPath, "SKILL.md");
  if (!existsSync(skillMdAbs)) return { sections: [], empty: true };
  const content = readAssetSourceFileSafely(skillMdAbs, dir.absPath);
  return { sections: [{ label: "SKILL.md", content }], empty: false };
}

function pluginSource(home: HomeContext, asset: Asset): ResolvedAssetSource {
  const installPath = findPluginInstallPath(home, asset.id);
  if (installPath === null || !existsSync(installPath)) {
    return { sections: [], empty: true };
  }
  const sections: PromptEnvelopeSection[] = [];
  const pluginJsonAbs = path.join(installPath, ".claude-plugin", "plugin.json");
  if (existsSync(pluginJsonAbs)) {
    sections.push({ label: "plugin.json", content: readAssetSourceFileSafely(pluginJsonAbs, installPath) });
  }
  for (const readmeName of ["README.md", "readme.md", "Readme.md"]) {
    const readmeAbs = path.join(installPath, readmeName);
    if (existsSync(readmeAbs)) {
      sections.push({ label: readmeName, content: readAssetSourceFileSafely(readmeAbs, installPath) });
      break; // 하나만 있으면 충분하다 — 대소문자 변형은 대개 같은 파일의 중복 존재가 아니다.
    }
  }
  return { sections, empty: sections.length === 0 };
}

function descriptionOnlySource(asset: Asset): ResolvedAssetSource {
  if (asset.description === undefined || asset.description.length === 0) {
    return { sections: [], empty: true };
  }
  return { sections: [{ label: "asset.description", content: asset.description }], empty: false };
}

export function resolveAssetSource(home: HomeContext, asset: Asset): ResolvedAssetSource {
  switch (asset.kind) {
    case "skill":
      return skillSource(home, asset);
    case "plugin":
      return pluginSource(home, asset);
    case "mcp":
    case "cli":
      return descriptionOnlySource(asset);
  }
}

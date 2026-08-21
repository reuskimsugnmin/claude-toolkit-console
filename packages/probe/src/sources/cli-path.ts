import { existsSync } from "node:fs";
import path from "node:path";
import { normalizePath, type Asset, type Installation } from "@ctk/core";
import type { HomeContext } from "../home.js";

/**
 * probe/src/sources/cli-path.ts — plan §4.1 Step 2 ("PATH 상 도구, occupancy 상시 0").
 *
 * ⚠️ 문서화된 설계 선택(Step 2 범위, 근거 부족 항목 — 실행 단계 보고에 남긴다): plan 원문은
 * "PATH 상 도구"라고만 적었을 뿐 탐지 범위를 구체화하지 않았고, 이를 검증하는 Step 0 스파이크도
 * 없었다. `PATH`의 모든 디렉터리를 무제한으로 열거하면 시스템에 설치된 임의 실행 파일 수천 개가
 * 전부 "자산"으로 잡혀 ⓐ 이 제품의 스코프(Claude Code 툴 환경)를 벗어나고 ⓑ 사용자 머신의
 * 소프트웨어 인벤토리를 카탈로그에 흘리는 프라이버시 위험이 생긴다(CLAUDE.md "⚠️ 이 저장소는
 * 공개다"와 같은 정신을 사용자 카탈로그에도 적용). 그래서 **PATH 전수 열거가 아니라, 이 제품이
 * 다루는 "에이전틱 CLI 도구" 알려진 이름 목록만 PATH에서 찾는다.** 목록은 좁게 시작하고
 * 필요해지면 늘린다 — 넓게 시작해서 나중에 좁히는 것보다 안전한 방향이다.
 */
export const KNOWN_CLI_TOOL_NAMES: readonly string[] = ["claude", "codex", "gemini"];

export interface CliSourceResult {
  assets: Asset[];
  installations: Installation[];
}

export interface CollectCliToolsOptions {
  home: HomeContext;
  machineId: string;
  pathEnv?: string;
  knownNames?: readonly string[];
}

export function collectCliTools(options: CollectCliToolsOptions): CliSourceResult {
  const { home, machineId } = options;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const knownNames = options.knownNames ?? KNOWN_CLI_TOOL_NAMES;
  const dirs = pathEnv.split(path.delimiter).filter((d) => d.length > 0);

  const assets: Asset[] = [];
  const installations: Installation[] = [];
  const found = new Set<string>();

  for (const name of knownNames) {
    if (found.has(name)) continue;
    const dirWithMatch = dirs.find((dir) => existsSync(path.join(dir, name)));
    if (dirWithMatch === undefined) continue;
    found.add(name);
    const normalized = normalizePath(path.join(dirWithMatch, name), home.ctkHome);
    assets.push({
      schema_version: 1,
      _scope: "machine_independent",
      id: name,
      kind: "cli",
      name,
      source_ref: normalized.home_relative ?? `path_hash:${normalized.path_hash}`,
    });
    installations.push({
      schema_version: 1,
      _scope: "machine_dependent",
      asset_id: name,
      machine_id: machineId,
      install_scope: null,
      enabled_at: null,
      project_path_hash: null,
      mcp_enabled_state: null,
      mcp_state_source: null,
    });
  }

  return { assets, installations };
}

import { readFileSync } from "node:fs";
import { parseClaudeJsonFile } from "@ctk/core";
import type { HomeContext } from "../home.js";
import { claudeJsonPath } from "../home.js";

/**
 * `~/.claude.json`의 `projects` 키 집합 — AC-1.1 직독 경로 목록의 "~/.claude.json(루트+projects.*)"에
 * 해당하는 "알려진 프로젝트" 레지스트리. plugins/skills/mcp 세 소스 모듈이 공유한다(프로젝트별
 * `.claude/settings.json` 등을 순회할 때 동일한 프로젝트 집합을 써야 AC-1.1 대조가 일관된다).
 */
export function listKnownProjectPaths(home: HomeContext): string[] {
  let raw: string;
  try {
    raw = readFileSync(claudeJsonPath(home), "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = parseClaudeJsonFile(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
  return Object.keys(parsed.projects ?? {});
}

/** 프로젝트 경로별 `~/.claude.json` 엔트리(mcpServers·enabledMcpServers 등)를 함께 얻고 싶을 때. */
export function readClaudeJsonFile(home: HomeContext): ReturnType<typeof parseClaudeJsonFile> | null {
  let raw: string;
  try {
    raw = readFileSync(claudeJsonPath(home), "utf8");
  } catch {
    return null;
  }
  try {
    return parseClaudeJsonFile(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

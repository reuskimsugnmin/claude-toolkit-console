import { readFileSync } from "node:fs";
import { parseClaudeJsonFile } from "@ctk/core";
import type { HomeContext } from "../home.js";
import { claudeJsonPath } from "../home.js";
import { ParseSchemaMismatchError } from "./errors.js";

/**
 * `~/.claude.json`의 `projects` 키 집합 — AC-1.1 직독 경로 목록의 "~/.claude.json(루트+projects.*)"에
 * 해당하는 "알려진 프로젝트" 레지스트리. plugins/skills/mcp 세 소스 모듈이 공유한다(프로젝트별
 * `.claude/settings.json` 등을 순회할 때 동일한 프로젝트 집합을 써야 AC-1.1 대조가 일관된다).
 *
 * ⚠️ 회귀 수정(Step 2, test-engineer 실측 발견) — 이전 구현은 "파일이 없다"(정상 — 아직 어떤
 * 프로젝트도 등록 안 됐을 수 있다)와 "파일은 있는데 JSON이 깨졌거나 스키마가 안 맞는다"(R13 —
 * 하네스 드리프트 가능성, `plugins.ts`가 `claude plugin list --json`에 대해 이미 `parse_schema_mismatch`로
 * 다루는 것과 동일한 위험군)를 구분하지 않고 둘 다 "빈 배열"로 조용히 삼켰다. `~/.claude.json`은
 * 프로젝트·MCP·프로젝트스코프 스킬 세 소스 전부가 공유하는 유일한 프로젝트 레지스트리이므로,
 * 이 파일 하나가 파싱 실패하면 이 세 소스의 프로젝트 스코프 데이터가 전부 "프로젝트 0개"로
 * 조용히 사라질 뻔했다 — `errors.ts`의 `CommandFailedError` 주석이 경고하는 "빈 stdout = 결과
 * 없음"과 같은 계열의 함정이다. ENOENT(파일이 진짜 없음)만 정상 경로로 취급하고, 그 밖의 모든
 * 오류(권한 거부·JSON 구문 오류·zod 스키마 불일치)는 `ParseSchemaMismatchError`로 던져
 * 호출부(scan.ts)가 `failure_class: "parse_schema_mismatch"`로 기록하게 한다.
 */
function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

function readAndParseClaudeJson(home: HomeContext): ReturnType<typeof parseClaudeJsonFile> | null {
  let raw: string;
  try {
    raw = readFileSync(claudeJsonPath(home), "utf8");
  } catch (err) {
    if (isEnoent(err)) return null; // 정상 — ~/.claude.json이 아직 없을 수 있다.
    throw new ParseSchemaMismatchError("~/.claude.json (읽기 실패)", err);
  }
  try {
    return parseClaudeJsonFile(JSON.parse(raw) as unknown);
  } catch (cause) {
    throw new ParseSchemaMismatchError("~/.claude.json (invalid JSON 또는 zod strict 불일치)", cause);
  }
}

export function listKnownProjectPaths(home: HomeContext): string[] {
  const parsed = readAndParseClaudeJson(home);
  return Object.keys(parsed?.projects ?? {});
}

/** 프로젝트 경로별 `~/.claude.json` 엔트리(mcpServers·enabledMcpServers 등)를 함께 얻고 싶을 때. */
export function readClaudeJsonFile(home: HomeContext): ReturnType<typeof parseClaudeJsonFile> | null {
  return readAndParseClaudeJson(home);
}

import type { Toggle } from "../schema/toggle.js";

/**
 * core/src/mcp/names.ts — MCP 서버 **하네스 이름**의 형식·분류. probe(스냅샷 분류)와 mcp-toggle(쓰기 대상
 * 이름 조립)이 같은 규칙을 쓰도록 한 곳에 둔다 — 사본이 생기면 읽는 쪽과 쓰는 쪽의 이름이 어긋난다.
 */

/** 하네스가 `enabledMcpServers`를 상태 신호로 읽는 유일한 이름(내장, 기본 꺼짐). */
export const COMPUTER_USE = "computer-use";

/** claude.ai 커넥터 토글 이름의 접두사. */
export const CLAUDE_AI_CONNECTOR_PREFIX = "claude.ai ";

/** 플러그인이 번들한 MCP 서버의 하네스 이름 — `plugin:<플러그인이름>:<서버이름>`. */
export function formatPluginMcpName(pluginName: string, serverName: string): string {
  return `plugin:${pluginName}:${serverName}`;
}

export function classifyToggleName(
  name: string,
  installedPluginNames: ReadonlySet<string>,
): Toggle["classification_source"] {
  if (name.startsWith("plugin:")) {
    const pluginName = name.split(":")[1];
    return pluginName !== undefined && installedPluginNames.has(pluginName) ? "definition_found" : "unclassified";
  }
  if (name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX)) {
    return "name_pattern";
  }
  return "unclassified";
}

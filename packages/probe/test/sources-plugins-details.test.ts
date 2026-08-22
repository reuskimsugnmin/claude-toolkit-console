import { describe, expect, it } from "vitest";
import { fetchPluginDetails, parsePluginDetailsText } from "../src/sources/plugins.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-plugins-details.test.ts — Step 3, AC-4.8 5D 교차검증 파서. 실측 원문 구조를
 * 그대로 재현한 **합성** 텍스트로 검증한다(CLAUDE.md — 실제 환경 데이터를 픽스처에 넣지 않는다).
 * 구조(들여쓰기·"~"·쉼표 천단위·괄호 안 주석 문구)는 2026-08-21 실측(이 세션에서 직접 실행한
 * `claude plugin details`, 공개 마켓플레이스 플러그인 3건 대상)과 동일하게 맞췄다.
 */
const SYNTHETIC_NO_VERSION = `demo-mcp-plugin
  A synthetic MCP-only plugin for testing.
  Source: demo-mcp-plugin@demo-marketplace

Component inventory
  Skills (0)
  Agents (0)
  Hooks (0)
  MCP servers (1)  demo-server  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~0 tok   added to every session
`;

const SYNTHETIC_WITH_VERSION = `demo-suite 1.2.3
  A synthetic multi-component plugin for testing.
  Source: demo-suite@demo-marketplace

Component inventory
  Skills (2)  demo-skill-a, demo-skill-b
  Agents (1)  demo-agent
  Hooks (1)  SessionStart  (harness-only — no model context cost)
  MCP servers (1)  demo-server  (tool schemas resolved at runtime; not counted)
  LSP servers (0)

Projected token cost
  Always-on:   ~3,169 tok   added to every session
`;

describe("probe/sources/plugins — claude plugin details 텍스트 파서 (AC-4.8 5D)", () => {
  it("버전이 없는 경우(실측 정정 — version은 optional)에도 파싱된다", () => {
    const parsed = parsePluginDetailsText(SYNTHETIC_NO_VERSION);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBeUndefined();
    expect(parsed?.id).toBe("demo-mcp-plugin@demo-marketplace");
    expect(parsed?.components).toEqual({ skills: 0, agents: 0, hooks: 0, mcp_servers: 1, lsp_servers: 0 });
    expect(parsed?.projected_token_cost.always_on_tokens).toBe(0);
  });

  it("버전이 있고 천단위 쉼표가 섞인 큰 토큰 수도 정확히 파싱한다", () => {
    const parsed = parsePluginDetailsText(SYNTHETIC_WITH_VERSION);
    expect(parsed?.version).toBe("1.2.3");
    expect(parsed?.description).toBe("A synthetic multi-component plugin for testing.");
    expect(parsed?.components).toEqual({ skills: 2, agents: 1, hooks: 1, mcp_servers: 1, lsp_servers: 0 });
    expect(parsed?.projected_token_cost.always_on_tokens).toBe(3169);
  });

  it("Always-on 줄이 없으면 null(파싱 실패)을 반환한다 — 조용히 0으로 채우지 않는다", () => {
    const broken = SYNTHETIC_NO_VERSION.replace(/Always-on:.*\n/, "");
    expect(parsePluginDetailsText(broken)).toBeNull();
  });

  it("Component inventory 섹션이 없으면 null을 반환한다", () => {
    const broken = "demo\n  Source: demo@mp\n\nProjected token cost\n  Always-on:   ~0 tok   added to every session\n";
    expect(parsePluginDetailsText(broken)).toBeNull();
  });

  it("fetchPluginDetails — 명령 실패(exitCode!=0)는 command_failed로 구분된다", async () => {
    const home: HomeContext = { ctkHome: "/tmp/x", ctkConfigDir: "/tmp/x/.claude", configDirExplicit: false };
    const result = await fetchPluginDetails("demo@mp", {
      home,
      cwd: "/tmp",
      timeoutSec: 5,
      spawnFn: async () => ({ exitCode: 1, stdout: "", stderr: "not found", timedOut: false }),
    });
    expect(result).toEqual({ error: "command_failed" });
  });

  it("fetchPluginDetails — exitCode 0인데 파싱이 안 되면 parse_failed로 구분된다", async () => {
    const home: HomeContext = { ctkHome: "/tmp/x", ctkConfigDir: "/tmp/x/.claude", configDirExplicit: false };
    const result = await fetchPluginDetails("demo@mp", {
      home,
      cwd: "/tmp",
      timeoutSec: 5,
      spawnFn: async () => ({ exitCode: 0, stdout: "totally unexpected output format", stderr: "", timedOut: false }),
    });
    expect(result).toEqual({ error: "parse_failed" });
  });

  it("fetchPluginDetails — 성공 시 파싱된 details를 반환한다", async () => {
    const home: HomeContext = { ctkHome: "/tmp/x", ctkConfigDir: "/tmp/x/.claude", configDirExplicit: false };
    const result = await fetchPluginDetails("demo-mcp-plugin@demo-marketplace", {
      home,
      cwd: "/tmp",
      timeoutSec: 5,
      spawnFn: async () => ({ exitCode: 0, stdout: SYNTHETIC_NO_VERSION, stderr: "", timedOut: false }),
    });
    expect("details" in result && result.details.id).toBe("demo-mcp-plugin@demo-marketplace");
  });
});

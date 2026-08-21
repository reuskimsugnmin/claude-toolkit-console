import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HomeContext } from "../../src/home.js";

/**
 * probe/test/support/fixture-home.ts — Step 2 통합 테스트용 합성 홈 트리 빌더. 정적 JSON
 * 픽스처 대신 테스트 시점에 프로그램적으로 만든다 — 프로젝트 경로가 `mkdtempSync`로 매 실행마다
 * 달라지므로(placeholder 치환 없이) 실제 절대경로를 그대로 써서 파일을 배치할 수 있다.
 * CLAUDE.md "테스트 픽스처는 익명화된 합성 데이터로 만든다"를 만족한다 — 전부 합성 문자열이다.
 */

export interface FixtureHome {
  home: HomeContext;
  projectAlpha: string;
  projectBeta: string;
  cleanup(): void;
}

function writeJson(absPath: string, value: unknown): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(value, null, 2), "utf8");
}

/**
 * 합성 홈을 만든다 — 플러그인(user/local 2프로젝트) · 전역/프로젝트 스킬 · MCP(user/local/project
 * 정의 + 프로젝트별 토글 + 비-Asset 커넥터/미분류 토글)를 전부 담는다.
 */
export function buildFixtureHome(): FixtureHome {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-probe-fixture-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  const projectAlpha = path.join(ctkHome, "projects", "alpha");
  const projectBeta = path.join(ctkHome, "projects", "beta");

  mkdirSync(ctkConfigDir, { recursive: true });
  mkdirSync(projectAlpha, { recursive: true });
  mkdirSync(projectBeta, { recursive: true });

  // installed_plugins.json — user 스코프 1건 + local 스코프 2건(같은 id, 서로 다른 프로젝트,
  // AC-0.3 실측 형과 동일한 "중복처럼 보이지만 실은 프로젝트별 설치" 패턴).
  writeJson(path.join(ctkConfigDir, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "demo-plugin@demo-marketplace": [
        {
          scope: "user",
          installPath: path.join(ctkConfigDir, "plugins", "cache", "demo-marketplace", "demo-plugin", "1.0.0"),
          version: "1.0.0",
          installedAt: "2026-08-01T00:00:00.000Z",
          lastUpdated: "2026-08-01T00:00:00.000Z",
        },
      ],
      "demo-local@demo-marketplace": [
        {
          scope: "local",
          installPath: path.join(ctkConfigDir, "plugins", "cache", "demo-marketplace", "demo-local", "2.0.0"),
          version: "2.0.0",
          installedAt: "2026-08-02T00:00:00.000Z",
          lastUpdated: "2026-08-02T00:00:00.000Z",
          projectPath: projectAlpha,
        },
        {
          scope: "local",
          installPath: path.join(ctkConfigDir, "plugins", "cache", "demo-marketplace", "demo-local", "2.0.0"),
          version: "2.0.0",
          installedAt: "2026-08-02T00:00:00.000Z",
          lastUpdated: "2026-08-02T00:00:00.000Z",
          projectPath: projectBeta,
        },
      ],
    },
  });

  // 전역 settings.json — user 스코프 활성 표시.
  writeJson(path.join(ctkConfigDir, "settings.json"), {
    enabledPlugins: { "demo-plugin@demo-marketplace": true },
  });

  // 전역 스킬 1건.
  mkdirSync(path.join(ctkConfigDir, "skills", "global-skill"), { recursive: true });
  writeFileSync(
    path.join(ctkConfigDir, "skills", "global-skill", "SKILL.md"),
    "---\nname: global-skill\ndescription: 전역 스킬 픽스처\n---\n\n# global-skill\n",
    "utf8",
  );

  // 프로젝트 alpha — demo-local 활성 + 프로젝트 스킬 + .mcp.json + MCP 토글(등록된 서버·비-Asset 양쪽).
  writeJson(path.join(projectAlpha, ".claude", "settings.json"), {
    enabledPlugins: { "demo-local@demo-marketplace": true },
  });
  mkdirSync(path.join(projectAlpha, ".claude", "skills", "project-skill"), { recursive: true });
  writeFileSync(
    path.join(projectAlpha, ".claude", "skills", "project-skill", "SKILL.md"),
    "---\nname: project-skill\n---\n\n# project-skill\n",
    "utf8",
  );
  writeJson(path.join(projectAlpha, ".mcp.json"), {
    mcpServers: { "alpha-mcp": { command: "true" } },
  });

  // 프로젝트 beta — demo-local 비활성.
  writeJson(path.join(projectBeta, ".claude", "settings.json"), {
    enabledPlugins: { "demo-local@demo-marketplace": false },
  });

  // ~/.claude.json — root mcpServers(user) + 두 프로젝트 엔트리(mcpServers·토글).
  writeJson(path.join(ctkHome, ".claude.json"), {
    mcpServers: { "user-mcp": { command: "true" } },
    projects: {
      [projectAlpha]: {
        mcpServers: { "local-mcp": { command: "true" } },
        enabledMcpServers: ["computer-use", "alpha-mcp"],
        disabledMcpServers: ["claude.ai Demo Connector", "plugin:demo-plugin:sub"],
      },
      [projectBeta]: {
        enabledMcpServers: ["user-mcp"],
        disabledMcpServers: [],
      },
    },
  });

  return {
    home: { ctkHome, ctkConfigDir, configDirExplicit: false },
    projectAlpha,
    projectBeta,
    cleanup: () => rmSync(ctkHome, { recursive: true, force: true }),
  };
}

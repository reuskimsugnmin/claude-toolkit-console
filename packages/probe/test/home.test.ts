import { describe, expect, it } from "vitest";
import { resolveHomeContext, claudeJsonPath } from "../src/home.js";

describe("probe/home — 모든 경로 접근의 단일 관문 (P0-2)", () => {
  it("CTK_HOME/CTK_CONFIG_DIR이 설정되지 않으면 실제 홈으로 귀결된다", () => {
    const ctx = resolveHomeContext({});
    expect(ctx.ctkHome.length).toBeGreaterThan(0);
    expect(ctx.ctkConfigDir).toBe(`${ctx.ctkHome}/.claude`);
  });

  it("CTK_HOME이 설정되면 그 값을 쓰고, CTK_CONFIG_DIR 미설정 시 $CTK_HOME/.claude로 기본값이 잡힌다", () => {
    const ctx = resolveHomeContext({ CTK_HOME: "/tmp/fake-home" });
    expect(ctx.ctkHome).toBe("/tmp/fake-home");
    expect(ctx.ctkConfigDir).toBe("/tmp/fake-home/.claude");
  });

  it("CTK_CONFIG_DIR을 독립적으로 지정하면 CTK_HOME과 별개로 반영된다(2축 격리)", () => {
    const ctx = resolveHomeContext({ CTK_HOME: "/tmp/fake-home", CTK_CONFIG_DIR: "/tmp/other-config" });
    expect(ctx.ctkHome).toBe("/tmp/fake-home");
    expect(ctx.ctkConfigDir).toBe("/tmp/other-config");
  });

  it(
    "✅ H5 수정 — CTK_CONFIG_DIR이 명시되지 않으면(프로덕션 기본 경로) claudeJsonPath는 " +
      "CTK_HOME 바로 아래를 가리킨다(실측: 자식 claude 서브프로세스도 CLAUDE_CONFIG_DIR 없이 " +
      "떠서 같은 위치를 본다)",
    () => {
      const ctx = resolveHomeContext({ CTK_HOME: "/tmp/fake-home" });
      expect(ctx.configDirExplicit).toBe(false);
      expect(claudeJsonPath(ctx)).toBe("/tmp/fake-home/.claude.json");
    },
  );

  it(
    "✅ H5 수정 — CTK_CONFIG_DIR이 명시되면(격리 테스트 전용) claudeJsonPath는 그 안을 " +
      "가리킨다(실측: CLAUDE_CONFIG_DIR을 명시한 claude는 .claude.json을 그 디렉터리 안에 만든다)",
    () => {
      const ctx = resolveHomeContext({ CTK_HOME: "/tmp/fake-home", CTK_CONFIG_DIR: "/tmp/other-config" });
      expect(ctx.configDirExplicit).toBe(true);
      expect(claudeJsonPath(ctx)).toBe("/tmp/other-config/.claude.json");
    },
  );
});

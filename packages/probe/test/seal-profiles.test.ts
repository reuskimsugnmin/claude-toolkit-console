import { describe, expect, it } from "vitest";
import { assertEnvWhitelist, assertForbiddenArgv } from "@ctk/core";
import {
  buildArgvPrefix,
  buildChildEnv,
  buildFullArgv,
  isSealProfile,
  SEAL_PROFILES,
} from "../src/harness/seal-profiles.js";

describe("probe/harness/seal-profiles — §1.3 결정 6 프로파일 조합 (순수 함수)", () => {
  it("허용 프로파일은 정확히 둘이다", () => {
    expect(SEAL_PROFILES).toEqual(["test-isolated", "sealed-live"]);
    expect(isSealProfile("test-isolated")).toBe(true);
    expect(isSealProfile("sealed-live")).toBe(true);
    expect(isSealProfile("--bare")).toBe(false);
    expect(isSealProfile(undefined)).toBe(false);
  });

  it("구조적 서브커맨드(-p 아님)에는 --strict-mcp-config/--mcp-config를 붙이지 않는다(실측 정정)", () => {
    // 실측(Step 2, 실제 환경 검증): 이 두 플래그를 `plugin list --json`에 붙이면 위치와 무관하게
    // `error: unknown option`으로 명령 자체가 실패한다 — plugin 서브커맨드는 이 플래그들을 모르는
    // 별도 파서를 쓴다. 모델(-p) 세션에만 적용해야 한다.
    const prefix = buildArgvPrefix("test-isolated", ["plugin", "list", "--json"]);
    expect(prefix).toEqual([]);
  });

  it("-p 모델 세션에는 --strict-mcp-config + 빈 --mcp-config를 붙인다", () => {
    const prefix = buildArgvPrefix("test-isolated", ["-p", "--tools", ""]);
    expect(prefix).toEqual(["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']);
  });

  it("sealed-live는 구조적 서브커맨드에도 --safe-mode를 붙인다(실측: plugin list --json을 깨지 않는다)", () => {
    const prefix = buildArgvPrefix("sealed-live", ["plugin", "list", "--json"]);
    expect(prefix).toEqual(["--safe-mode"]);
  });

  it("sealed-live + -p 모델 세션은 --safe-mode와 MCP 차단 플래그를 모두 붙인다", () => {
    const prefix = buildArgvPrefix("sealed-live", ["-p"]);
    expect(prefix[0]).toBe("--safe-mode");
    expect(prefix).toContain("--strict-mcp-config");
  });

  it("buildFullArgv는 프리픽스 뒤에 subcommand를 그대로 이어붙인다", () => {
    const argv = buildFullArgv("test-isolated", ["plugin", "list", "--json"]);
    expect(argv.slice(-3)).toEqual(["plugin", "list", "--json"]);
  });

  it("구성된 전체 argv는 forbidden-argv의 금지 플래그 검사를 항상 통과한다(H1 마지막 방어선의 전제)", () => {
    // 위치인자 0개 단언은 -p 모델 세션 전제다 — "plugin"/"list"는 구조적 서브커맨드 단어이므로
    // (spawn-claude.ts와 동일하게) 그 검사는 끈 채로 "금지 플래그가 섞여 들어가지 않았는가"만 본다.
    for (const profile of SEAL_PROFILES) {
      const argv = buildFullArgv(profile, ["plugin", "list", "--json"]);
      expect(assertForbiddenArgv(argv, undefined, undefined, { checkPositionalArguments: false }).status).toBe(
        "clean",
      );
    }
  });

  it("-p 모델 세션 서브커맨드는 위치인자 0개 단언이 여전히 적용된다(기본값 유지)", () => {
    const argv = buildFullArgv("sealed-live", ["-p", "--tools", ""]);
    expect(assertForbiddenArgv(argv).status).toBe("clean");
    const withStrayPositional = buildFullArgv("sealed-live", ["-p", "stray prompt text"]);
    expect(assertForbiddenArgv(withStrayPositional).status).toBe("violation");
  });

  it("buildChildEnv는 HOME을 항상 인자값으로 덮어쓴다(부모 env 무관)", () => {
    const env = buildChildEnv("test-isolated", "/isolated/home", "/isolated/home/.claude", true, {
      HOME: "/real/home",
      CLAUDE_CONFIG_DIR: "/real/home/.claude",
      PATH: "/usr/bin",
    });
    expect(env.HOME).toBe("/isolated/home");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/isolated/home/.claude");
    expect(env.PATH).toBe("/usr/bin");
  });

  it(
    "✅ H5 수정 — configDirExplicit=false(프로덕션 기본 경로)면 CLAUDE_CONFIG_DIR을 자식 env에 " +
      "아예 넣지 않는다(부모에 있어도 마찬가지) — 재현: 수정 전에는 이 값이 항상 주입돼 자식과 " +
      "probe가 서로 다른 .claude.json을 보는 사고(H5)로 이어졌다",
    () => {
      const env = buildChildEnv("test-isolated", "/real/home", "/real/home/.claude", false, {
        HOME: "/real/home",
        CLAUDE_CONFIG_DIR: "/real/home/.claude",
        PATH: "/usr/bin",
      });
      expect(env.HOME).toBe("/real/home");
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
    },
  );

  it("buildChildEnv는 허용 목록 밖 변수를 전혀 담지 않는다(env -i 규약)", () => {
    const env = buildChildEnv("test-isolated", "/h", "/h/.claude", true, {
      HOME: "/real",
      ANTHROPIC_API_KEY: "secret",
      NODE_OPTIONS: "--require evil.js",
      HTTPS_PROXY: "http://evil",
      PATH: "/usr/bin",
    });
    expect(assertEnvWhitelist(env).status).toBe("clean");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("sealed-live만 CLAUDE_CODE_SAFE_MODE=1을 자기 선언으로 심는다", () => {
    const isolated = buildChildEnv("test-isolated", "/h", "/h/.claude", true, {});
    const sealed = buildChildEnv("sealed-live", "/h", "/h/.claude", true, {});
    expect(isolated.CLAUDE_CODE_SAFE_MODE).toBeUndefined();
    expect(sealed.CLAUDE_CODE_SAFE_MODE).toBe("1");
  });

  it("TERM/SHELL/TMPDIR이 부모 env에 없으면 안전한 기본값으로 보강되고, 그래도 화이트리스트 안에 머문다", () => {
    const env = buildChildEnv("test-isolated", "/h", "/h/.claude", true, {});
    expect(env.TERM).toBe("xterm");
    expect(env.SHELL).toBe("/bin/bash");
    expect(env.TMPDIR).toBe("/tmp");
    expect(assertEnvWhitelist(env).status).toBe("clean");
  });
});

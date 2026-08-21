import { describe, expect, it } from "vitest";
import { resolveRegistryScope } from "../src/commands/move.js";

/**
 * cli/test/move-registry-scope.test.ts — L7 재현. `--asset __proto__`처럼 프로토타입
 * 체인상의 예약어를 자산 id로 넘겨도 TypeError로 죽지 않는다(Object.hasOwn 가드).
 */
describe("cli/move — resolveRegistryScope (L7: 프로토타입 오염 방어)", () => {
  it(
    "✅ L7 재현 — assetId가 '__proto__'여도 TypeError 없이 null을 반환한다(수정 전에는 " +
      "plugins['__proto__']가 Object.prototype을 반환해 .find() 호출이 TypeError로 죽었다)",
    () => {
      const plugins = { "demo@demo-mp": [{ scope: "user" as const, installPath: "/x", version: "1.0.0", installedAt: "t", lastUpdated: "t" }] };
      expect(() => resolveRegistryScope(plugins, "__proto__", "user")).not.toThrow();
      expect(resolveRegistryScope(plugins, "__proto__", "user")).toBeNull();
    },
  );

  it("assetId가 'constructor'여도 안전하다(다른 프로토타입 체인 예약어)", () => {
    const plugins = { "demo@demo-mp": [{ scope: "user" as const, installPath: "/x", version: "1.0.0", installedAt: "t", lastUpdated: "t" }] };
    expect(() => resolveRegistryScope(plugins, "constructor", "user")).not.toThrow();
    expect(resolveRegistryScope(plugins, "constructor", "user")).toBeNull();
  });

  it("정상 케이스 — fromScope와 일치하는 엔트리의 scope를 반환한다", () => {
    const plugins = {
      "demo@demo-mp": [
        { scope: "project" as const, installPath: "/x", version: "1.0.0", installedAt: "t", lastUpdated: "t" },
        { scope: "user" as const, installPath: "/y", version: "1.0.0", installedAt: "t", lastUpdated: "t" },
      ],
    };
    expect(resolveRegistryScope(plugins, "demo@demo-mp", "user")).toBe("user");
  });

  it("등록 자체가 없는 자산은 null을 반환한다", () => {
    expect(resolveRegistryScope({}, "unknown@mp", "user")).toBeNull();
  });
});

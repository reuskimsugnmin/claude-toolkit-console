import { describe, expect, it } from "vitest";
import { findExternalRuntimeDeps } from "../assert-zero-runtime-deps.mjs";

// pnpm ls -r --json 실제 출력 형태를 축약 재현한 합성 픽스처. 워크스페이스 내부 참조는
// version이 "link:..."로 표시되고, npm registry에서 내려받은 외부 패키지는 실제 semver
// 버전과 resolved URL을 갖는다 — 이 둘을 구분하는 것이 판정의 핵심이다.
function pkg(name, dependencies) {
  return { name, version: "0.0.1", path: `/repo/packages/${name}`, private: true, dependencies };
}

describe("scripts/assert-zero-runtime-deps — C5(iter 8) 런타임 의존성 0개 검증", () => {
  it("워크스페이스 내부 link: 의존성만 있는 패키지는 위반이 아니다", () => {
    const entries = [
      pkg("@ctk/actuator", {
        "@ctk/core": { from: "@ctk/core", version: "link:../core", path: "/repo/packages/core" },
      }),
    ];
    expect(findExternalRuntimeDeps(entries)).toHaveLength(0);
  });

  it("승인 목록에 없는 외부 패키지가 있으면 위반으로 검출된다", () => {
    const entries = [
      pkg("@ctk/core", {
        "left-pad": {
          from: "left-pad",
          version: "1.3.0",
          resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
          path: "/repo/node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad",
        },
      }),
    ];
    const violations = findExternalRuntimeDeps(entries);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({ package: "@ctk/core", deps: ["left-pad"] });
  });

  it("workspace link와 외부 패키지가 섞여 있으면 외부 패키지만 위반으로 보고한다", () => {
    const entries = [
      pkg("@ctk/gen", {
        "@ctk/core": { from: "@ctk/core", version: "link:../core", path: "/repo/packages/core" },
        "left-pad": { from: "left-pad", version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad" },
      }),
    ];
    const violations = findExternalRuntimeDeps(entries);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.deps).toEqual(["left-pad"]);
  });

  it("dependencies 필드가 없는(루트 워크스페이스 등) 항목은 위반 없이 통과한다", () => {
    const entries = [{ name: "claude-toolkit-console", path: "/repo", private: true }];
    expect(findExternalRuntimeDeps(entries)).toHaveLength(0);
  });

  it("빈 배열 입력은 위반 0건이다", () => {
    expect(findExternalRuntimeDeps([])).toHaveLength(0);
  });

  it(
    "zod는 승인된 런타임 의존성이므로 위반이 아니다 " +
      "(Step 1에서 '런타임 의존성 0개'와 결정 1의 zod 채택이 충돌함이 드러나, " +
      "정책을 '승인 목록 외 0개'로 확정했다. 스키마 검증은 런타임에 실행되므로 dev로 둘 수 없다)",
    () => {
      const entries = [
        pkg("@ctk/core", {
          zod: { from: "zod", version: "3.23.8", resolved: "https://registry.npmjs.org/zod" },
        }),
      ];
      expect(findExternalRuntimeDeps(entries)).toHaveLength(0);
    },
  );

  it("승인 목록은 주입 가능하다 — 목록에서 빼면 같은 입력이 위반이 된다", () => {
    const entries = [
      pkg("@ctk/core", {
        zod: { from: "zod", version: "3.23.8", resolved: "https://registry.npmjs.org/zod" },
      }),
    ];
    const violations = findExternalRuntimeDeps(entries, new Set());
    expect(violations).toHaveLength(1);
    expect(violations[0]?.deps).toEqual(["zod"]);
  });
});

// 계층 경계 강제 (plan §4.1 "계층 경계는 lint로 강제한다" — 예외 없는 절대 규칙).
import tseslint from "typescript-eslint";
import { ctkPlugin } from "./eslint-rules/ctk-plugin.js";

const NODE_IO_MODULES = [
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
];

function restrictedImports(patterns) {
  return {
    "no-restricted-imports": [
      "error",
      {
        patterns: patterns.map((p) => ({ ...p })),
      },
    ],
    // A1 — no-restricted-imports는 ImportDeclaration/Export*Declaration만 보고 동적 import()
    // (ImportExpression)는 보지 않는다(layer-lint.test.ts 실증). 같은 group으로 동적 import도 막는다.
    "ctk/no-restricted-dynamic-import": [
      "error",
      { patterns: patterns.map((p) => ({ ...p })) },
    ],
  };
}

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.d.ts",
      "spikes/**",
      ".omc/**",
      "fixtures/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { ctk: ctkPlugin },
  },

  // ── core: 어떤 패키지도 import 금지. node:fs / node:child_process import 금지.
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      ...restrictedImports([
        {
          group: [...NODE_IO_MODULES, "@ctk/*"],
          message: "core는 순수 로직 계층이다 — I/O도 다른 패키지 import도 금지",
        },
      ]),
    },
  },
  // core/guard/*: 판정기는 "어느 홈이냐"를 몰라야 한다 (착수 조건 C2).
  // env-whitelist.ts는 예외다 — "CLAUDE_CONFIG_DIR"이 여기 등장하는 건 홈 경로를 식별해서가
  // 아니라, 그 이름 자체가 자식 프로세스에 전달을 허용할 **환경변수 키**이기 때문이다(iter 8 · B2).
  // 값(어느 홈인지)은 여전히 호출자(probe/harness/seal-profiles.ts)가 넘긴다 — 이 파일은 키
  // 이름만 알 뿐 경로 리터럴은 담지 않는다.
  {
    files: ["packages/core/src/guard/**/*.ts"],
    ignores: ["packages/core/src/guard/env-whitelist.ts"],
    rules: {
      "ctk/no-home-literals": "error",
    },
  },

  // ── probe: core만 import 가능. fs 쓰기 계열 금지. child_process 직접 사용 금지(래퍼 내부만 허용).
  {
    files: ["packages/probe/src/**/*.ts"],
    ignores: ["packages/probe/src/harness/spawn-claude.ts"],
    rules: {
      ...restrictedImports([
        {
          group: ["@ctk/probe", "@ctk/actuator", "@ctk/sync", "@ctk/gen", "@ctk/cli", "@ctk/web"],
          message: "probe는 core만 import할 수 있다",
        },
      ]),
      "ctk/no-fs-write-mutation": "error",
      "ctk/no-direct-child-process": "error",
    },
  },
  {
    files: ["packages/probe/src/**/*.ts"],
    rules: {
      "ctk/single-spawn-wrapper": "error",
      "ctk/no-bare-flag": "error",
    },
  },

  // ── actuator: core, probe만 import 가능. guard 판정 로직 재구현 금지.
  {
    files: ["packages/actuator/src/**/*.ts"],
    rules: {
      ...restrictedImports([
        {
          group: ["@ctk/actuator", "@ctk/sync", "@ctk/gen", "@ctk/cli", "@ctk/web"],
          message: "actuator는 core, probe만 import할 수 있다",
        },
      ]),
      "ctk/no-guard-duplication": "error",
    },
  },

  // ── sync: core만 import 가능. 카탈로그 저장소 쓰기의 유일한 주체.
  {
    files: ["packages/sync/src/**/*.ts"],
    rules: {
      ...restrictedImports([
        {
          group: ["@ctk/probe", "@ctk/actuator", "@ctk/sync", "@ctk/gen", "@ctk/cli", "@ctk/web"],
          message: "sync는 core만 import할 수 있다",
        },
      ]),
    },
  },

  // ── gen: core, probe, sync만 import 가능. 직접 쓰지 않는다(fs 쓰기 금지). 홈 경로 리터럴 금지.
  {
    files: ["packages/gen/src/**/*.ts"],
    rules: {
      ...restrictedImports([
        {
          group: ["@ctk/gen", "@ctk/actuator", "@ctk/cli", "@ctk/web"],
          message: "gen은 core, probe, sync만 import할 수 있다",
        },
      ]),
      "ctk/no-fs-write-mutation": "error",
      "ctk/no-direct-child-process": "error",
      "ctk/single-spawn-wrapper": "error",
      "ctk/no-bare-flag": "error",
      // A2 — gen은 frontmatter를 읽으려면 node:fs 읽기 함수 import가 필요하다(그래서 위
      // restrictedImports group에 node:fs를 넣지 않는다). 하지만 `export * from "node:fs"` 같은
      // 재노출은 쓰기 함수까지 흘려보내므로 "gen이 직접 쓰지 않으므로 쓰기 금지는 lint로 자명하다"는
      // 전제를 깬다(layer-lint.test.ts 실증) — 재노출 자체를 별도로 금지한다.
      "ctk/no-io-reexport": ["error", { modules: NODE_IO_MODULES }],
    },
  },

  // ── 전역: claude 서브프로세스는 spawn-claude.ts 래퍼만 호출할 수 있다.
  {
    files: ["packages/**/src/**/*.ts"],
    ignores: ["packages/probe/src/harness/spawn-claude.ts"],
    rules: {
      "ctk/single-spawn-wrapper": "error",
    },
  },

  // ── 전역: 카탈로그 경로 세그먼트 검증은 core/catalog/layout.ts 단일 관문만 쓴다(Step 5 보안
  // 심사 수정 — 호출부 중복 가드가 두 벌로 발산했던 문제의 재발 방지).
  {
    files: ["packages/**/src/**/*.ts"],
    rules: {
      "ctk/no-adhoc-path-guard": "error",
    },
  },

  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
);

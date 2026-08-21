// 계층 경계를 강제하는 프로젝트 전용 ESLint 규칙 모음 (CLAUDE.md / plan §4.1).
// 표준 규칙(no-restricted-imports)으로 표현할 수 없는 것만 여기에 둔다.

/** guard/* 판정기 소스에 등장하면 안 되는 "어느 홈이냐" 식별 리터럴 (착수 조건 C2). */
const HOME_LITERAL_PATTERN =
  /\bCTK_HOME\b|\bCLAUDE_CONFIG_DIR\b|실제\s*홈|actual[-_ ]?home|real[-_ ]?home/i;

const noHomeLiterals = {
  meta: {
    type: "problem",
    docs: {
      description:
        "core/guard 판정기는 순수 함수여야 하고 '어느 홈이냐'를 알아서는 안 된다 (착수 조건 C2)",
    },
    schema: [],
    messages: {
      forbidden:
        "guard 판정기 소스에 홈 식별 리터럴/식별자 금지: \"{{text}}\" — baseline은 호출자가 allowlist로 넘긴다",
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string" && HOME_LITERAL_PATTERN.test(node.value)) {
          context.report({ node, messageId: "forbidden", data: { text: node.value } });
        }
      },
      TemplateElement(node) {
        if (HOME_LITERAL_PATTERN.test(node.value.raw)) {
          context.report({ node, messageId: "forbidden", data: { text: node.value.raw } });
        }
      },
      Identifier(node) {
        if (HOME_LITERAL_PATTERN.test(node.name)) {
          context.report({ node, messageId: "forbidden", data: { text: node.name } });
        }
      },
    };
  },
};

/** probe/gen이 직접 호출하면 안 되는 fs 변형(mutation) 메서드 이름. 휴리스틱 — 프로퍼티명 기준. */
const BANNED_FS_METHODS = new Set([
  "writeFile",
  "writeFileSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "mkdir",
  "mkdirSync",
  "unlink",
  "unlinkSync",
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "truncate",
  "truncateSync",
]);

const noFsWriteMutation = {
  meta: {
    type: "problem",
    docs: { description: "이 계층은 읽기 전용이다 — fs 쓰기/이동/삭제 계열 호출 금지" },
    schema: [],
    messages: {
      forbidden: "쓰기 함수 호출 금지: {{name}}() — 이 패키지는 읽기 전용이다",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        let name = null;
        if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
          name = callee.property.name;
        } else if (callee.type === "Identifier") {
          name = callee.name;
        }
        if (name && BANNED_FS_METHODS.has(name)) {
          context.report({ node, messageId: "forbidden", data: { name } });
        }
      },
    };
  },
};

const noDirectChildProcess = {
  meta: {
    type: "problem",
    docs: {
      description:
        "claude 서브프로세스는 probe/src/harness/spawn-claude.ts 래퍼를 통해서만 호출한다",
    },
    schema: [],
    messages: {
      forbidden: "child_process 직접 사용 금지 — spawn-claude.ts 래퍼를 통해서만 호출한다",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value === "child_process" || node.source.value === "node:child_process") {
          context.report({ node, messageId: "forbidden" });
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments[0]?.type === "Literal" &&
          (node.arguments[0].value === "child_process" ||
            node.arguments[0].value === "node:child_process")
        ) {
          context.report({ node, messageId: "forbidden" });
        }
      },
    };
  },
};

const noBareFlag = {
  meta: {
    type: "problem",
    docs: { description: "--bare는 전 경로에서 폐기됐다 (Step 0 실측, AC-0.10ⓑ)" },
    schema: [],
    messages: { forbidden: "'--bare' 리터럴 사용 금지 — 전 경로에서 폐기된 플래그다" },
  },
  create(context) {
    return {
      Literal(node) {
        if (node.value === "--bare") {
          context.report({ node, messageId: "forbidden" });
        }
      },
    };
  },
};

/** actuator가 core/guard의 판정 로직을 중복 구현하지 못하게 파일명 재등장을 막는다. */
const GUARD_FILE_BASENAMES = new Set(["tree-diff.ts", "whitelist.ts", "forbidden.ts"]);

const noGuardDuplication = {
  meta: {
    type: "problem",
    docs: {
      description:
        "actuator는 core/guard의 판정 로직을 재구현하지 않는다 — guard/ 파일명 재등장 금지",
    },
    schema: [],
    messages: {
      forbidden:
        "'{{name}}'은 core/src/guard/의 판정기 파일명이다. actuator는 판정을 재구현하지 않고 core를 import한다",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const base = filename.split("/").pop() ?? "";
    if (GUARD_FILE_BASENAMES.has(base) && filename.includes("/actuator/")) {
      return {
        Program(node) {
          context.report({ node, messageId: "forbidden", data: { name: base } });
        },
      };
    }
    return {};
  },
};

/** claude 서브프로세스는 spawn-claude.ts 래퍼만 spawn/exec 계열을 호출할 수 있다. */
const SPAWN_LIKE = new Set(["spawn", "exec", "execFile", "execSync", "spawnSync", "execFileSync"]);

const singleSpawnWrapper = {
  meta: {
    type: "problem",
    docs: {
      description:
        "claude를 spawn/exec로 직접 호출하는 코드 금지 — probe/src/harness/spawn-claude.ts만 예외",
    },
    schema: [],
    messages: {
      forbidden: "claude를 직접 spawn/exec 하지 않는다 — spawn-claude.ts 래퍼를 통해서만 호출한다",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (filename.endsWith("/probe/src/harness/spawn-claude.ts")) {
      return {};
    }
    return {
      CallExpression(node) {
        const callee = node.callee;
        const name =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" && callee.property.type === "Identifier"
              ? callee.property.name
              : null;
        if (!name || !SPAWN_LIKE.has(name)) return;
        const firstArg = node.arguments[0];
        const literalText =
          firstArg?.type === "Literal" && typeof firstArg.value === "string"
            ? firstArg.value
            : firstArg?.type === "TemplateLiteral"
              ? firstArg.quasis.map((q) => q.value.raw).join("")
              : "";
        if (/\bclaude\b/.test(literalText)) {
          context.report({ node, messageId: "forbidden" });
        }
      },
    };
  },
};

/**
 * `group` 패턴(리터럴 또는 트레일링 `*` 와일드카드, 예: "@ctk/*")을 소스 문자열에 매칭한다.
 * no-restricted-imports의 group 옵션과 동일한 표현력만 지원한다 — 이 프로젝트가 실제로 쓰는
 * 패턴은 정확한 모듈명과 트레일링 와일드카드뿐이다.
 */
function matchesGroupPattern(source, groupPattern) {
  if (!groupPattern.includes("*")) return source === groupPattern;
  const escaped = groupPattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(source);
}

function extractStaticImportSource(node) {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.raw).join("");
  }
  return null;
}

/**
 * A1 우회 수정 — `no-restricted-imports`는 정적 `ImportDeclaration`/`Export*Declaration`만 보고
 * 동적 `import()`(`ImportExpression`)는 보지 않는다(layer-lint.test.ts가 실증한 갭). 이 규칙은
 * 같은 `patterns`(group + message) 옵션으로 `ImportExpression`의 소스 리터럴도 동일하게 제한한다.
 */
const noRestrictedDynamicImport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "동적 import()도 no-restricted-imports와 동일한 group 규칙으로 제한한다 (A1 — 계층 lint 우회 수정)",
    },
    schema: [
      {
        type: "object",
        properties: {
          patterns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                group: { type: "array", items: { type: "string" } },
                message: { type: "string" },
              },
              required: ["group"],
            },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden: "동적 import(\"{{source}}\") 금지 — {{message}}",
    },
  },
  create(context) {
    const patterns = context.options[0]?.patterns ?? [];
    return {
      ImportExpression(node) {
        const source = extractStaticImportSource(node.source);
        if (source === null) return;
        for (const p of patterns) {
          if ((p.group ?? []).some((g) => matchesGroupPattern(source, g))) {
            context.report({
              node,
              messageId: "forbidden",
              data: { source, message: p.message ?? "" },
            });
            return;
          }
        }
      },
    };
  },
};

/**
 * A2 우회 수정 — 읽기 용도로만 import가 허용된 계층(예: gen의 node:fs)이 `export * from`/
 * `export { x } from`으로 같은 모듈을 재노출하면, 재노출된 심볼을 통해 쓰기 함수까지 흘러나갈 수
 * 있다(layer-lint.test.ts가 실증한 갭). 이 규칙은 지정된 모듈의 재노출(re-export) 자체를 금지한다
 * — 일반 `import`(직접 호출부에서 no-fs-write-mutation이 잡는 읽기 용도)는 그대로 허용된다.
 */
const noIoReexport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "I/O 모듈의 재노출(export * from / export {...} from) 금지 (A2 — 계층 lint 우회 수정)",
    },
    schema: [
      {
        type: "object",
        properties: { modules: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        "'{{source}}' 재노출 금지 — 이 계층은 이 모듈을 읽기 용도로 import할 수 있을 뿐 재노출(re-export)할 수 없다",
    },
  },
  create(context) {
    const modules = new Set(context.options[0]?.modules ?? []);
    function check(node) {
      const source = node.source?.value;
      if (typeof source === "string" && modules.has(source)) {
        context.report({ node, messageId: "forbidden", data: { source } });
      }
    }
    return {
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
    };
  },
};

export const ctkPlugin = {
  meta: { name: "ctk-layer-rules" },
  rules: {
    "no-home-literals": noHomeLiterals,
    "no-fs-write-mutation": noFsWriteMutation,
    "no-direct-child-process": noDirectChildProcess,
    "no-bare-flag": noBareFlag,
    "no-guard-duplication": noGuardDuplication,
    "single-spawn-wrapper": singleSpawnWrapper,
    "no-restricted-dynamic-import": noRestrictedDynamicImport,
    "no-io-reexport": noIoReexport,
  },
};

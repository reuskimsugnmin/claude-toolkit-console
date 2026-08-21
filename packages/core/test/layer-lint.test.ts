import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// this file: packages/core/test/layer-lint.test.ts → 3 levels up to repo root
const repoRoot = path.resolve(here, "../../..");

async function lintVirtual(code: string, virtualRelPath: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintText(code, {
    filePath: path.join(repoRoot, virtualRelPath),
  });
  const result = results[0];
  if (result === undefined) {
    throw new Error(`lintText returned no result for ${virtualRelPath}`);
  }
  return result;
}

/**
 * 계층 lint가 의도적 위반 코드에서 실패하는지 검증한다 (Step 1 수용 기준 · plan §4.1).
 * `ESLint#lintText`의 virtual filePath로 실제 파일을 만들지 않고도 각 계층의 glob override가
 * 적용되는지 확인한다.
 */
describe("계층 lint — 의도적 위반 코드에서 실패한다", () => {
  it("core/guard/*에 홈 식별 리터럴이 있으면 실패한다 (착수 조건 C2)", async () => {
    const result = await lintVirtual(
      `export const BAD = "CTK_HOME";\n`,
      "packages/core/src/guard/violation-fixture.ts",
    );
    expect(result.messages.some((m) => m.ruleId === "ctk/no-home-literals")).toBe(true);
  });

  it("core/guard/*의 실제 소스는 홈 식별 리터럴이 0건이다 (C2 양성 확인 — lint로 확인)", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const results = await eslint.lintFiles(["packages/core/src/guard/**/*.ts"]);
    const homeLiteralErrors = results.flatMap((r) =>
      r.messages.filter((m) => m.ruleId === "ctk/no-home-literals"),
    );
    expect(homeLiteralErrors).toHaveLength(0);
  });

  it("core가 node:fs를 import하면 실패한다", async () => {
    const result = await lintVirtual(
      `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`,
      "packages/core/src/violation-fixture-fs.ts",
    );
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("core가 다른 워크스페이스 패키지(@ctk/probe)를 import하면 실패한다", async () => {
    const result = await lintVirtual(
      `import { x } from "@ctk/probe";\nexport const y = x;\n`,
      "packages/core/src/violation-fixture-import.ts",
    );
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("probe가 fs 쓰기 함수를 호출하면 실패한다", async () => {
    const result = await lintVirtual(
      `import { writeFileSync } from "node:fs";\nwriteFileSync("x", "y");\n`,
      "packages/probe/src/violation-fixture-write.ts",
    );
    expect(result.messages.some((m) => m.ruleId === "ctk/no-fs-write-mutation")).toBe(true);
  });

  it("probe/src/harness/spawn-claude.ts는 fs 쓰기 규칙 예외다 (ignores 정확성 확인)", async () => {
    const result = await lintVirtual(
      `import { writeFileSync } from "node:fs";\nwriteFileSync("x", "y");\n`,
      "packages/probe/src/harness/spawn-claude.ts",
    );
    expect(result.messages.some((m) => m.ruleId === "ctk/no-fs-write-mutation")).toBe(false);
  });

  it("probe가 actuator를 import하면 실패한다", async () => {
    const result = await lintVirtual(
      `import { x } from "@ctk/actuator";\nexport const y = x;\n`,
      "packages/probe/src/violation-fixture-import.ts",
    );
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("actuator가 core/guard 판정기 파일명(tree-diff.ts)을 재구현하면 실패한다", async () => {
    const result = await lintVirtual(
      `export function verdict(): string { return "reimplemented"; }\n`,
      "packages/actuator/src/guard/tree-diff.ts",
    );
    expect(result.messages.some((m) => m.ruleId === "ctk/no-guard-duplication")).toBe(true);
  });

  it("--bare 리터럴 사용은 실패한다 (Step 0 실측, AC-0.10ⓑ)", async () => {
    const result = await lintVirtual(
      `export const FLAG = "--bare";\n`,
      "packages/probe/src/violation-fixture-bare.ts",
    );
    expect(result.messages.some((m) => m.ruleId === "ctk/no-bare-flag")).toBe(true);
  });

  it("claude를 spawn으로 직접 호출하면 실패한다 (spawn-claude.ts 래퍼 밖)", async () => {
    const result = await lintVirtual(
      `import { spawn } from "node:child_process";\nspawn("claude", ["--version"]);\n`,
      "packages/gen/src/violation-fixture-spawn.ts",
    );
    expect(result.messages.some((m) => m.ruleId === "ctk/single-spawn-wrapper")).toBe(true);
  });

  it("core/src 전체가 lint 오류 0건이다 (I/O import 0건 포함 — 수용 기준 'core에 I/O import 0건')", async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const results = await eslint.lintFiles(["packages/core/src/**/*.ts"]);
    const errors = results.flatMap((r) => r.messages.filter((m) => m.severity === 2));
    expect(errors).toHaveLength(0);
  });

  it("정상적인 core 코드는 통과한다 (오탐 없음)", async () => {
    const result = await lintVirtual(
      `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
      "packages/core/src/valid-fixture.ts",
    );
    expect(result.errorCount).toBe(0);
  });
});

describe(
  "계층 lint — 과거 우회 경로가 이제 막혔는가 (test-engineer 실측 발견 A1/A2 회귀 방지). " +
    "`no-restricted-imports`는 정적 ImportDeclaration/Export*Declaration만 검사하고 동적 " +
    "`import()` 표현식(ImportExpression)은 검사하지 않았다 — `ctk/no-restricted-dynamic-import`가 " +
    "같은 group 규칙으로 ImportExpression도 검사하도록 승격됐다(A1). 마찬가지로 gen의 " +
    "`export * from \"node:fs\"` 재노출은 no-fs-write-mutation(호출식만 봄)에 뚫렸는데, " +
    "`ctk/no-io-reexport`가 재노출 자체를 별도로 금지한다(A2)",
  () => {
    it("✅ 수정됨(A1) — core가 동적 import(\"node:fs\")를 쓰면 이제 lint가 잡는다 (정적 import와 동일하게)", async () => {
      const dynamic = await lintVirtual(
        `export async function bad() {\n  const fs = await import("node:fs");\n  return fs;\n}\n`,
        "packages/core/src/dyn-import-fixture.ts",
      );
      expect(dynamic.messages.some((m) => m.ruleId === "ctk/no-restricted-dynamic-import")).toBe(true);

      const static_ = await lintVirtual(
        `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`,
        "packages/core/src/static-import-fixture.ts",
      );
      // 대조군 — 정적 import도 여전히 정상적으로 잡힌다.
      expect(static_.errorCount).toBeGreaterThan(0);
    });

    it("✅ 수정됨(A1) — core가 동적 import(\"@ctk/probe\")를 쓰면 이제 lint가 잡는다 (워크스페이스 패키지 경계도 동일 보호)", async () => {
      const result = await lintVirtual(
        `export async function bad() {\n  const probe = await import("@ctk/probe");\n  return probe;\n}\n`,
        "packages/core/src/dyn-import-workspace-fixture.ts",
      );
      expect(result.messages.some((m) => m.ruleId === "ctk/no-restricted-dynamic-import")).toBe(true);
    });

    it("✅ 수정됨(A2) — gen이 `export * from \"node:fs\"`로 쓰기 함수를 재노출하면 이제 lint가 잡는다", async () => {
      const result = await lintVirtual(
        `export * from "node:fs";\n`,
        "packages/gen/src/reexport-fs-fixture.ts",
      );
      expect(result.messages.some((m) => m.ruleId === "ctk/no-io-reexport")).toBe(true);
    });

    it("✅ 수정됨(A2) — gen이 `export { writeFileSync } from \"node:fs\"`로 특정 심볼만 재노출해도 잡는다", async () => {
      const result = await lintVirtual(
        `export { writeFileSync } from "node:fs";\n`,
        "packages/gen/src/reexport-named-fs-fixture.ts",
      );
      expect(result.messages.some((m) => m.ruleId === "ctk/no-io-reexport")).toBe(true);
    });

    it("오탐 없음(A2) — gen이 node:fs를 일반 import(읽기 용도)로 쓰는 것은 여전히 허용된다", async () => {
      const result = await lintVirtual(
        `import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`,
        "packages/gen/src/normal-read-fixture.ts",
      );
      expect(result.messages.some((m) => m.ruleId === "ctk/no-io-reexport")).toBe(false);
    });

    it("양성 확인 — probe의 no-fs-write-mutation은 동적 import를 거쳐도 호출부에서 여전히 잡는다 (call-site 휴리스틱이라 안전)", async () => {
      const result = await lintVirtual(
        `export async function bad() {\n  const fs = await import("node:fs");\n  fs.writeFileSync("x", "y");\n}\n`,
        "packages/probe/src/dyn-write-fixture.ts",
      );
      expect(result.messages.some((m) => m.ruleId === "ctk/no-fs-write-mutation")).toBe(true);
    });
  },
);

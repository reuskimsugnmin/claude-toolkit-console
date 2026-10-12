import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * R7 Step 2 — failure_class 독자와 run-log 안전 기록자는 각각 정의가 하나뿐이다.
 * 사본은 코드처럼 생기지 않은 자리에서도 생기지만, 이 사본 3벌은 함수 선언이었다 —
 * 원문 정규식이 아니라 AST의 FunctionDeclaration 이름으로 센다(주석·문자열 인용은 노드가 아니다).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(p).isDirectory()) return srcFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
  });
}

function definitionsOf(name: string): string[] {
  const hits: string[] = [];
  for (const pkg of readdirSync(path.join(repoRoot, "packages"))) {
    const src = path.join(repoRoot, "packages", pkg, "src");
    try {
      statSync(src);
    } catch {
      continue;
    }
    for (const file of srcFiles(src)) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node): void => {
        if (ts.isFunctionDeclaration(n) && n.name?.text === name) hits.push(path.relative(repoRoot, file));
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  return hits;
}

describe("단일 정의", () => {
  it.each(["extractFailureClass", "failureClassOf", "writeRunLogSafely"])("function %s는 packages/*/src에 정확히 하나", (name) => {
    expect(definitionsOf(name)).toHaveLength(1);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FAILURE_CLASSES, FailureClassSchema } from "../src/failure/classes.js";

/**
 * core/test/failure-class-registration.test.ts — B1 보안 심사 L-D(2026-08-28).
 *
 * **무엇을 막는가.** `readonly failureClass = "..."`를 선언하는 에러 클래스는 저장소 전체에
 * 30곳이 넘는데, 그중 **6곳이 `FAILURE_CLASSES`에 등재되지 않은 값**을 던지고 있었다. 심사가
 * 지적한 것은 하나(`asset_source_not_a_file`)였지만 세어 보니 여섯이었다 — **지적은 항목이
 * 아니라 범위로 닫는다**(CLAUDE.md).
 *
 * **미등재의 대가는 "기록 안 됨"이 아니라 오분류다.** `cli/commands/{scan,move,rollback}.ts`의
 * `extractFailureClass`가 `FAILURE_CLASS_SET.has()`로 거르므로, 미등재 클래스를 던지면
 * run-log의 `failure_class`가 조용히 `null`이 된다 — 위생이 실제로 막은 자산이 "분류 없음"으로
 * 남는다(안전 원칙 7: "없음"과 "실패"를 구분한다). 즉 **등재가 곧 배선이다.**
 *
 * ⚠️ **양성 대조군을 함께 단언한다.** 정규식이 깨지거나 소스 순회가 빗나가면 이 테스트는
 * "위반 0건"으로 조용히 통과한다 — **결과가 전부 0이면 대상이 아니라 도구를 의심한다**
 * (CLAUDE.md). 아래 `수집한 선언 수`·`발견한 파일 수` 단언이 그 역할이다.
 */

const PACKAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 선언 한 건 — 어느 파일 몇 번째 줄에서 어떤 값을 던지는지. 위반 메시지에 그대로 쓴다. */
interface FailureClassDeclaration {
  file: string;
  line: number;
  value: string;
}

const DECLARATION_RE = /readonly\s+failureClass\s*=\s*"([^"]+)"/;

function walkSourceFiles(dirAbs: string, out: string[] = []): string[] {
  for (const dirent of readdirSync(dirAbs, { withFileTypes: true })) {
    // `dist`(빌드 산출물)와 `node_modules`는 원본이 아니다 — 세면 같은 선언을 두 번 센다.
    if (dirent.name === "node_modules" || dirent.name === "dist" || dirent.name === "test") continue;
    const abs = path.join(dirAbs, dirent.name);
    if (dirent.isDirectory()) walkSourceFiles(abs, out);
    else if (dirent.isFile() && abs.endsWith(".ts")) out.push(abs);
  }
  return out;
}

function collectDeclarations(): FailureClassDeclaration[] {
  const found: FailureClassDeclaration[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const fileAbs of walkSourceFiles(path.join(PACKAGES_DIR, pkg.name))) {
      const lines = readFileSync(fileAbs, "utf8").split("\n");
      lines.forEach((line, i) => {
        const m = DECLARATION_RE.exec(line);
        if (m?.[1] !== undefined) {
          found.push({ file: path.relative(PACKAGES_DIR, fileAbs), line: i + 1, value: m[1] });
        }
      });
    }
  }
  return found;
}

describe("failure_class 등재 — 던지는 값은 전부 FAILURE_CLASSES에 있어야 한다(L-D)", () => {
  const declarations = collectDeclarations();

  it("양성 대조군 — 스캐너가 실제로 선언을 찾아냈다(0건이면 도구가 깨진 것이다)", () => {
    // 2026-08-28 실측 30건. 하한만 둔다(선언이 늘어나는 것은 정상이고, 줄어들면 스캐너를
    // 의심해야 한다). 파일 축도 함께 본다 — 한 파일만 읽고 있었다면 이쪽이 잡는다.
    expect(declarations.length).toBeGreaterThanOrEqual(25);
    expect(new Set(declarations.map((d) => d.file)).size).toBeGreaterThanOrEqual(10);
  });

  it("스캐너가 여러 패키지에 걸쳐 돈다 — core 하나만 보고 통과하지 않는다", () => {
    const packages = new Set(declarations.map((d) => d.file.split(path.sep)[0]));
    expect(packages.size).toBeGreaterThanOrEqual(4);
  });

  it("미등재 failure_class를 던지는 선언이 하나도 없다", () => {
    const registered = new Set<string>(FAILURE_CLASSES);
    const violations = declarations.filter((d) => !registered.has(d.value));
    // 위반을 건수가 아니라 **자리와 함께** 보고한다 — "몇 건"만 알면 어디를 고칠지 모른다.
    expect(violations.map((v) => `${v.file}:${v.line} → "${v.value}"`)).toEqual([]);
  });

  it("등재된 값은 전부 FailureClassSchema를 통과한다(열거와 스키마가 갈리지 않는다)", () => {
    for (const value of FAILURE_CLASSES) {
      expect(FailureClassSchema.parse(value)).toBe(value);
    }
  });
});

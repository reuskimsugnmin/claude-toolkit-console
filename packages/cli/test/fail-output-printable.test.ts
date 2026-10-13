import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ctk.ts의 오류 출력은 모두 `printable()`을 거친다 — 메시지에 동기화 저장소 유래 문자열(자산 id 등)이
 * 섞이면 ESC/OSC 같은 터미널 제어문자가 그대로 나간다(R7 보안 심사 C I-3). 분기가 늘어날 때 하나라도
 * 빠지면 이 검사가 그 줄을 가리킨다.
 */
describe("ctk.ts — 오류 메시지 출력은 printable()을 거친다", () => {
  const source = readFileSync(path.join(__dirname, "..", "bin", "ctk.ts"), "utf8");

  it("err.message/message를 찍는 console.error 줄마다 printable(이 있다", () => {
    const lines = source.split("\n").map((l, i) => ({ l, n: i + 1 }));
    const printing = lines.filter(({ l }) => /console\.error\(/.test(l) && /\b(err\.message|message)\b/.test(l));
    expect(printing.length).toBeGreaterThan(5); // 0건 통과 방지 — 검사 대상이 실제로 잡혔다
    const missing = printing.filter(({ l }) => !l.includes("printable("));
    expect(missing.map(({ n, l }) => `${n}: ${l.trim()}`)).toEqual([]);
  });
});

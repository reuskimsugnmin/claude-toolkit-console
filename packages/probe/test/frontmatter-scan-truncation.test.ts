import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FRONTMATTER_SCAN_MAX_BYTES, readForFrontmatterScan, scanFrontmatter } from "../src/frontmatter-scan.js";
import { parseSimpleFrontmatter } from "../src/frontmatter.js";

/**
 * probe/test/frontmatter-scan-truncation.test.ts — 보안 재심 M-1(2026-08-28).
 *
 * ⚠️ **fail-closed 게이트 자신의 구멍이었다.** `readForFrontmatterScan`은 정확히 상한 바이트까지
 * 읽으므로 절단면이 줄 한가운데에 떨어진다 — 즉 `content`의 **마지막 원소는 줄이 아니라 조각**이다.
 * 공격자가 `---TRAP` 같은 줄의 앞 3바이트에 절단면이 오도록 패딩하면 그 조각의 `trim()`이 정확히
 * `"---"`가 되어 "닫혔다"로 오인되고, 상한 안쪽의 자칭 `name`이 그대로 쓰인다.
 *
 * **두 함수의 규칙이 갈린 것이 아니라 입력이 달랐다.** `hasCompleteFrontmatterBlock`의
 * split·trim·종료 조건은 `parseSimpleFrontmatter`와 정확히 같았다 — 둘이 사이좋게 같은 허구를 봤다.
 *
 * 이 테스트가 없으면 이 축은 영영 안 태워진다: 기존 L-A 테스트들은 **채움 줄에 `---`가 없다**는
 * 전제로 짜여 있어 절단면이 `---` 위에 떨어지는 경우를 만들지 못한다.
 */

let dir: string | null = null;
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * 절단면(`FRONTMATTER_SCAN_MAX_BYTES`)이 `---TRAP` 줄의 `---` **직후**에 떨어지는 파일을 만든다.
 * `offsetFromLimit`으로 절단면 위치를 한 바이트씩 밀어 경계 주변 전체를 훑는다.
 */
function writeTrapFile(offsetFromLimit: number): string {
  dir = mkdtempSync(path.join(tmpdir(), "ctk-fm-trunc-"));
  const head = "---\nname: seen-first\n";
  const trap = "---TRAP\nname: hidden-past-the-limit\n---\n\n본문\n";
  const fillLen = FRONTMATTER_SCAN_MAX_BYTES - Buffer.byteLength(head) - 3 + offsetFromLimit;
  const filler = "f".repeat(fillLen - 1) + "\n";
  const abs = path.join(dir, "SKILL.md");
  writeFileSync(abs, head + filler + trap, "utf8");
  return abs;
}

describe("frontmatter-scan — 절단면이 만든 가짜 구획자(M-1)", () => {
  it("절단면이 `---TRAP`의 앞 3바이트에 떨어져도 '닫혔다'로 오인하지 않는다 — 판정 불가로 남는다", () => {
    const abs = writeTrapFile(0);

    // 양성 대조군 ① — 이 파일이 실제로 잘리는 파일이 맞다(안 잘리면 이 테스트는 공허하다).
    const read = readForFrontmatterScan(abs);
    expect(read.ok && read.truncated, "파일이 상한을 넘지 않아 이 축을 태우지 못했다").toBe(true);

    // 양성 대조군 ② — 전체 파일을 읽으면 판정이 **실제로 달라진다**(그래서 위험한 축이다).
    expect(parseSimpleFrontmatter(readFileSync(abs, "utf8")).name).toBe("hidden-past-the-limit");

    const scanned = scanFrontmatter(abs);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.unmeasured, "가짜 구획자에 속아 판정을 신뢰했다(M-1)").toBe("unterminated_within_scan_limit");
    expect(scanned.frontmatter, "판정 불가인데 값을 돌려줬다").toEqual({});
  });

  it("절단면 위치를 -2..+2로 밀어도 전부 판정 불가다 — 한 오프셋만 우연히 막히는 것이 아니다", () => {
    for (const offset of [-2, -1, 0, 1, 2]) {
      const abs = writeTrapFile(offset);
      const scanned = scanFrontmatter(abs);
      expect(scanned.ok).toBe(true);
      if (!scanned.ok) continue;
      expect(scanned.unmeasured, `offset=${offset}에서 뚫렸다`).toBe("unterminated_within_scan_limit");
      rmSync(dir!, { recursive: true, force: true });
      dir = null;
    }
  });

  it("대조군 — 진짜 닫는 `---`가 상한 안에 온전히 있으면 그대로 신뢰한다(과잉 차단 아님)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-fm-trunc-ok-"));
    const abs = path.join(dir, "SKILL.md");
    // frontmatter는 맨 앞에서 닫히고 본문만 상한을 크게 넘는다 — 정상 자산의 모습이다.
    writeFileSync(abs, `---\nname: real-name\ndescription: 정상\n---\n\n${"y".repeat(100_000)}\n`, "utf8");

    const read = readForFrontmatterScan(abs);
    expect(read.ok && read.truncated, "대조군이 잘리지 않아 비교 대상이 되지 못했다").toBe(true);

    const scanned = scanFrontmatter(abs);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.unmeasured, "닫힌 frontmatter를 판정 불가로 막았다(과잉 차단)").toBeNull();
    expect(scanned.frontmatter.name).toBe("real-name");
  });

  it("대조군 — 절단면이 마침 개행에 정확히 떨어져도 정상 판정을 잃지 않는다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-fm-trunc-nl-"));
    const abs = path.join(dir, "SKILL.md");
    const head = "---\nname: real-name\n---\n";
    // head 뒤를 개행으로 딱 떨어지게 채워 절단면이 줄 경계에 오게 한다.
    const pad = "p".repeat(FRONTMATTER_SCAN_MAX_BYTES - Buffer.byteLength(head) - 1) + "\n";
    writeFileSync(abs, head + pad + "뒤에 더 있다\n", "utf8");

    const scanned = scanFrontmatter(abs);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.unmeasured).toBeNull();
    expect(scanned.frontmatter.name).toBe("real-name");
  });
});

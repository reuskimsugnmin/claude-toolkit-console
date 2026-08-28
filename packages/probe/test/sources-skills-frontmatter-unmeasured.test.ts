import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSkills, findSkillDirsById } from "../src/sources/skills.js";
import type { HomeContext } from "../src/home.js";

/**
 * probe/test/sources-skills-frontmatter-unmeasured.test.ts — 3차 심사 L-A·L-B(2026-08-28).
 *
 * ⚠️ **이 축은 신호도 없고 읽는 자리도 없었다.** `readSkillDir`은 `readForFrontmatterScan`이
 * 돌려주는 `truncated`를 **읽지도 않았고**, `SkillSourceResult`에는 그 사실을 올릴 필드조차
 * 없었다 — 그런데 실측상 독립 스킬이 번들보다 모집단이 더 크다(위생 거부 54건이 전부 스킬이었다).
 *
 * `parseSimpleFrontmatter`는 닫는 `---`가 없으면 파일 끝까지 소비하며 **last-write-wins**를
 * 적용하므로, 스캔 상한(64KB) 밖의 두 번째 `name:`이 판정을 뒤집는다. 처방은 fail-closed —
 * 판정할 수 없으면 자칭 값을 쓰지 않고 디렉터리 이름으로 떨어뜨리고, **건수를 올린다.**
 */

function buildHome(): { home: HomeContext; cleanup: () => void } {
  const ctkHome = mkdtempSync(path.join(tmpdir(), "ctk-probe-skill-fm-"));
  const ctkConfigDir = path.join(ctkHome, ".claude");
  mkdirSync(path.join(ctkConfigDir, "skills"), { recursive: true });
  return {
    home: { ctkHome, ctkConfigDir, configDirExplicit: false },
    cleanup: () => rmSync(ctkHome, { recursive: true, force: true }),
  };
}

function writeSkill(home: HomeContext, dirName: string, body: string): void {
  const dir = path.join(home.ctkConfigDir, "skills", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

/** 닫는 `---`를 스캔 상한 밖으로 밀어내는 채움 — 채움 줄에 `---`가 있으면 거기서 닫힌다. */
function fillerPastScanLimit(): string {
  return Array.from({ length: 4000 }, (_, i) => `filler_${i}: ${"z".repeat(20)}`).join("\n");
}

describe("probe/sources/skills — frontmatter 판정 불가는 fail-closed로 처리하고 건수를 올린다(L-A·L-B)", () => {
  let fixture: { home: HomeContext; cleanup: () => void };
  afterEach(() => fixture?.cleanup());

  it("닫히지 않은 frontmatter는 자칭 name을 쓰지 않고 디렉터리 이름으로 떨어진다", () => {
    fixture = buildHome();
    writeSkill(
      fixture.home,
      "real-dir-name",
      `---\nname: seen-first\ndescription: 상한 안쪽 설명\n${fillerPastScanLimit()}\nname: hidden-past-the-limit\n---\n\n본문\n`,
    );

    const result = collectSkills({ home: fixture.home, machineId: "m1" });
    const ids = result.assets.map((a) => a.id);

    expect(ids).toEqual(["real-dir-name"]);
    // 상한 **안쪽** 값을 그대로 쓰는 것이 예전 결함이다 — 상한 위치에 따라 정체가 흔들린다.
    expect(ids, "상한 안쪽의 자칭 name이 쓰였다 — L-A 결함이 살아 있다").not.toContain("seen-first");
    expect(ids).not.toContain("hidden-past-the-limit");
    expect(result.assets[0]?.description, "같은 블록에서 온 description을 신뢰했다").toBeUndefined();
  });

  it("판정 불가 건수가 SkillSourceResult에 올라온다 — 이 축에는 읽는 자리 자체가 없었다(L-B)", () => {
    fixture = buildHome();
    writeSkill(fixture.home, "broken", `---\nname: x\n${fillerPastScanLimit()}\n---\n\n본문\n`);
    writeSkill(fixture.home, "fine", "---\nname: fine-skill\ndescription: 정상\n---\n\n본문\n");

    const result = collectSkills({ home: fixture.home, machineId: "m1" });
    expect(result.frontmatterUnmeasured).toBe(1);
  });

  it("대조군 — 정상 스킬은 자칭 name·description을 그대로 쓴다(과잉 차단 아님)", () => {
    fixture = buildHome();
    writeSkill(fixture.home, "dir-name", "---\nname: claimed-name\ndescription: 정상 설명\n---\n\n본문\n");

    const result = collectSkills({ home: fixture.home, machineId: "m1" });
    expect(result.assets.map((a) => a.id)).toEqual(["claimed-name"]);
    expect(result.assets[0]?.description).toBe("정상 설명");
    expect(result.frontmatterUnmeasured, "정상 스킬을 판정 불가로 셌다").toBe(0);
  });

  it("대조군 — 본문이 상한을 넘어도 frontmatter가 닫혔으면 판정은 정확하다(잘림 ≠ 판정 불가)", () => {
    fixture = buildHome();
    writeSkill(
      fixture.home,
      "big-body",
      `---\nname: big-claimed\ndescription: 정상\n---\n\n${"y".repeat(100_000)}\n`,
    );

    const result = collectSkills({ home: fixture.home, machineId: "m1" });
    expect(result.assets.map((a) => a.id)).toEqual(["big-claimed"]);
    expect(result.frontmatterUnmeasured, "닫힌 frontmatter를 판정 불가로 셌다(과잉 보고)").toBe(0);
  });

  it("findSkillDirsById도 같은 fail-closed 값을 본다 — 수집과 조회가 갈리지 않는다", () => {
    fixture = buildHome();
    writeSkill(fixture.home, "real-dir-name", `---\nname: seen-first\n${fillerPastScanLimit()}\n---\n\n본문\n`);

    // 수집 경로가 정한 id로 조회하면 찾히고, 자칭 name으로는 찾히지 않는다.
    expect(findSkillDirsById(fixture.home, "real-dir-name")).toHaveLength(1);
    expect(findSkillDirsById(fixture.home, "seen-first"), "조회 경로만 자칭 name을 믿고 있다").toHaveLength(0);
  });
});

/**
 * 보안 재심 L-3·L-4(2026-08-28) — **막는 것과 보이는 것은 다른 축이다.**
 */
describe("probe/sources/skills — 막았다는 사실을 보고한다(L-3·L-4)", () => {
  let fx: { home: HomeContext; cleanup: () => void };
  afterEach(() => fx?.cleanup());

  it("L-3 — SKILL.md가 FIFO면 열지 않고, 그 사실을 건수로 올린다(예전엔 '없음'과 같은 취급)", () => {
    fx = buildHome();
    const dir = path.join(fx.home.ctkConfigDir, "skills", "fifo-skill");
    mkdirSync(dir, { recursive: true });
    const fifo = path.join(dir, "SKILL.md");
    // 실제 FIFO를 만든다 — `readFileSync`가 여기서 영구 블록되는 것이 M-1의 실증이었다.
    execFileSync("mkfifo", [fifo]);

    const result = collectSkills({ home: fx.home, machineId: "m1" });
    expect(result.assets, "FIFO를 자산으로 편입했다").toEqual([]);
    expect(result.notRegularFileSkipped, "막기만 하고 보고하지 않는다 — L-3 결함이 살아 있다").toBe(1);
  });

  it("L-4 — 디렉터리 이름에 `:`가 있으면 그 스킬만 건너뛴다(scan 전체를 죽이지 않는다)", () => {
    fx = buildHome();
    // 번들 자식 id(`<부모id>:<kind>:<suffix>`)를 참칭하는 디렉터리.
    writeSkill(fx.home, "omc:skill:ask", "---\nname:\n---\n\n본문\n");
    writeSkill(fx.home, "normal", "---\nname: normal-skill\n---\n\n본문\n");

    const result = collectSkills({ home: fx.home, machineId: "m1" });
    expect(result.assets.map((a) => a.id), "`:` 참칭 id가 그대로 편입됐다").toEqual(["normal-skill"]);
    expect(result.unsafeIdSkipped).toBe(1);
  });

  it("L-4 대조군 — `:`가 없는 정상 디렉터리는 그대로 편입된다(과잉 차단 아님)", () => {
    fx = buildHome();
    writeSkill(fx.home, "plain-dir", "---\nname:\n---\n\n본문\n");
    const result = collectSkills({ home: fx.home, machineId: "m1" });
    expect(result.assets.map((a) => a.id)).toEqual(["plain-dir"]);
    expect(result.unsafeIdSkipped).toBe(0);
  });
});

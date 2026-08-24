import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAssetSourceFileSafely, SymlinkAssetSourceRejectedError } from "../src/file-hygiene.js";

/**
 * gen/test/symlink-containment.test.ts — **심볼릭 링크의 조건부 허용.**
 *
 * 배경(2026-08-24 실측): 위생 거부 54건이 전부 스킬이었고 링크 대상이 **100% `skills/` 안**이었다 —
 * 툴 하나가 자기 스킬 81개를 한 디렉터리에 두고 각각을 최상위로 링크하는 설치 방식이다. 링크를
 * 일률 거부하니 자산의 30%가 영영 문서를 못 만들었다.
 *
 * 이 파일이 지키는 경계는 하나다: **봉쇄가 실제로 봉쇄하는가.** 원래 우려("`SKILL.md`가
 * `~/.ssh/id_rsa`의 링크")가 여전히 막히는지, 그리고 `..`·중첩 링크로 빠져나갈 수 없는지.
 */
describe("readAssetSourceFileSafely — 봉쇄 루트 안의 링크만 따라간다", () => {
  let root: string;
  let skills: string;
  let secret: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup(): void {
    root = mkdtempSync(path.join(tmpdir(), "ctk-containment-"));
    skills = path.join(root, "config", "skills");
    mkdirSync(path.join(skills, "bundle", "inner"), { recursive: true });
    mkdirSync(path.join(skills, "alias"), { recursive: true });
    writeFileSync(path.join(skills, "bundle", "inner", "SKILL.md"), "번들 안의 본문");
    // 봉쇄 루트 **밖**의 민감 파일 — 원래 우려의 대상이다.
    secret = path.join(root, "secret.txt");
    writeFileSync(secret, "SUPER_SECRET_VALUE");
  }

  const opts = (): { symlinkContainmentRoots: string[] } => ({ symlinkContainmentRoots: [skills] });

  it("봉쇄 루트 안을 가리키는 링크는 따라간다 — 이것이 54건을 살리는 경로다", () => {
    setup();
    const alias = path.join(skills, "alias", "SKILL.md");
    symlinkSync(path.join(skills, "bundle", "inner", "SKILL.md"), alias);
    expect(readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, opts())).toBe("번들 안의 본문");
  });

  it("⚠️ 봉쇄 루트 밖을 가리키는 링크는 거부한다 — 원래 우려가 그대로 막힌다", () => {
    setup();
    const alias = path.join(skills, "alias", "SKILL.md");
    symlinkSync(secret, alias);
    expect(() => readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, opts())).toThrow(
      SymlinkAssetSourceRejectedError,
    );
  });

  it("⚠️ `..`로 빠져나가는 링크는 거부한다 — realpath가 먼저 해소한다", () => {
    setup();
    const alias = path.join(skills, "alias", "SKILL.md");
    symlinkSync(path.join(skills, "bundle", "..", "..", "..", "secret.txt"), alias);
    expect(() => readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, opts())).toThrow(
      SymlinkAssetSourceRejectedError,
    );
  });

  it("⚠️ 중첩 링크(봉쇄 안 → 봉쇄 밖)도 거부한다 — 한 겹만 보면 통과한다", () => {
    setup();
    const hop = path.join(skills, "bundle", "hop.md");
    symlinkSync(secret, hop); // 봉쇄 안에 있지만 밖을 가리킨다
    const alias = path.join(skills, "alias", "SKILL.md");
    symlinkSync(hop, alias); // 봉쇄 안을 가리키는 것처럼 보인다
    expect(() => readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, opts())).toThrow(
      SymlinkAssetSourceRejectedError,
    );
  });

  it("⚠️ 봉쇄 루트 접두만 같은 형제 디렉터리는 안이 아니다 (skills-evil vs skills)", () => {
    setup();
    const sibling = path.join(root, "config", "skills-evil");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, "x.md"), "형제");
    const alias = path.join(skills, "alias", "SKILL.md");
    symlinkSync(path.join(sibling, "x.md"), alias);
    expect(() => readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, opts())).toThrow(
      SymlinkAssetSourceRejectedError,
    );
  });

  /**
   * ⚠️ **보안 심사 H-1.** 봉쇄 루트 안이라도 **이름이 다른 파일**로 가는 링크는 거부한다.
   * 없으면 `skills/` 서브트리의 **아무 파일이나** 카탈로그 문서에 실려 private 저장소로
   * 동기화된다 — 도트파일 관리자가 `skills/`를 git 저장소로 심으면 `.git/config`의 토큰까지
   * 사정권이다. 링크 허용 **전에는 공집합**이던 위험이라 이 변경이 만든 것이다.
   *
   * 대가는 실측 0 — 이 환경의 심볼릭 링크 SKILL.md **55건의 대상 basename이 100% `SKILL.md`**다.
   */
  it("⚠️ 봉쇄 안이어도 **이름이 다른** 파일로 가는 링크는 거부한다 (심사 H-1)", () => {
    setup();
    mkdirSync(path.join(skills, "victim"), { recursive: true });
    mkdirSync(path.join(skills, ".git"), { recursive: true });
    writeFileSync(path.join(skills, "victim", ".env"), "API_KEY=synthetic");
    writeFileSync(path.join(skills, ".git", "config"), "[remote]\n url = https://tok@example.invalid/r.git");
    for (const target of [path.join(skills, "victim", ".env"), path.join(skills, ".git", "config")]) {
      const alias = path.join(skills, "alias", `SKILL-${path.basename(target)}.md`);
      symlinkSync(target, alias);
      expect(() => readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, opts()), target).toThrow(
        SymlinkAssetSourceRejectedError,
      );
    }
  });

  it("이름이 같으면 허용된다 — 실측 55건이 전부 이 모양이다", () => {
    setup();
    const alias = path.join(skills, "alias", "SKILL.md");
    symlinkSync(path.join(skills, "bundle", "inner", "SKILL.md"), alias);
    expect(readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, opts())).toBe("번들 안의 본문");
  });

  /**
   * ⚠️ **보안 심사 M-2b.** 봉쇄 루트가 이 머신에 없을 때 그 ENOENT가 원문의 ENOENT와 섞이면
   * 가드 실패가 `asset_source_missing`("원문이 사라졌다")으로 오분류된다 — 화면은 사용자에게
   * 있지도 않은 드리프트를 조사시킨다(안전 원칙 7).
   */
  it("봉쇄 루트가 없으면 거부하되 '원문 없음'으로 오분류하지 않는다 (심사 M-2b)", () => {
    setup();
    const alias = path.join(skills, "alias", "SKILL.md");
    symlinkSync(path.join(skills, "bundle", "inner", "SKILL.md"), alias);
    const missingRoot = path.join(root, "does-not-exist");
    try {
      readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, { symlinkContainmentRoots: [missingRoot] });
      expect.unreachable("거부했어야 한다");
    } catch (err) {
      expect(err).toBeInstanceOf(SymlinkAssetSourceRejectedError);
      expect((err as { failureClass: string }).failureClass).toBe("path_traversal_detected");
    }
  });

  it("빈 목록은 '봉쇄 없음'과 같다 — 링크 전부 거부(fail-closed)", () => {
    setup();
    const alias = path.join(skills, "alias", "SKILL.md");
    symlinkSync(path.join(skills, "bundle", "inner", "SKILL.md"), alias);
    expect(() => readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, { symlinkContainmentRoots: [] })).toThrow(
      SymlinkAssetSourceRejectedError,
    );
  });

  it("루트가 여러 개면 그중 하나만 맞아도 된다 — 프로젝트 스코프를 덮는 축이다 (심사 M-2a)", () => {
    setup();
    const projSkills = path.join(root, "project", ".claude", "skills");
    mkdirSync(path.join(projSkills, "bundle"), { recursive: true });
    writeFileSync(path.join(projSkills, "bundle", "SKILL.md"), "프로젝트 번들 본문");
    mkdirSync(path.join(projSkills, "alias"), { recursive: true });
    const alias = path.join(projSkills, "alias", "SKILL.md");
    symlinkSync(path.join(projSkills, "bundle", "SKILL.md"), alias);
    // user 루트만 주면 거부, 프로젝트 루트를 함께 주면 허용 — 배선 누락이 관측된다.
    expect(() => readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, opts())).toThrow(
      SymlinkAssetSourceRejectedError,
    );
    expect(
      readAssetSourceFileSafely(alias, path.dirname(alias), 200_000, {
        symlinkContainmentRoots: [skills, projSkills],
      }),
    ).toBe("프로젝트 번들 본문");
  });

  it("봉쇄 루트를 주지 않으면 링크는 전부 거부된다 — 기본값이 바뀌지 않았다", () => {
    setup();
    const alias = path.join(skills, "alias", "SKILL.md");
    symlinkSync(path.join(skills, "bundle", "inner", "SKILL.md"), alias);
    expect(() => readAssetSourceFileSafely(alias, path.dirname(alias))).toThrow(SymlinkAssetSourceRejectedError);
  });

  /**
   * ⚠️ 파괴 실험에서 `assertNotSymlink`를 떼도 테스트가 안 깨졌다 — 표본의 링크가 전부 자산
   * 루트 **밖**을 가리켜 realpath 검사가 대신 잡았기 때문이다. 같은 디렉터리 안을 가리키는
   * 링크만이 두 검사를 가른다. 기본 모드의 "링크는 무조건 거부"가 살아 있는지 여기서 본다.
   */
  it("기본 모드에서는 같은 디렉터리 안을 가리키는 링크도 거부한다 (링크 거부 자체가 살아 있다)", () => {
    setup();
    const dir = path.join(skills, "alias");
    // basename이 같아야 봉쇄 모드에서 허용된다(심사 H-1) — 같은 이름을 다른 자리에 둔다.
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    writeFileSync(path.join(dir, "nested", "SKILL.md"), "같은 디렉터리");
    const alias = path.join(dir, "SKILL.md");
    symlinkSync(path.join(dir, "nested", "SKILL.md"), alias);
    // realpath는 루트 **안**이므로 realpath 검사만으로는 통과한다 — assertNotSymlink가 잡아야 한다.
    expect(() => readAssetSourceFileSafely(alias, dir)).toThrow(SymlinkAssetSourceRejectedError);
    // 반대로 봉쇄 모드에서는 허용된다(그것이 봉쇄 모드의 목적이다).
    expect(readAssetSourceFileSafely(alias, dir, 200_000, opts())).toBe("같은 디렉터리");
  });

  /**
   * ⚠️ **회귀 테스트 — 봉쇄는 교체가 아니라 추가다.**
   *
   * 처음 구현은 봉쇄 모드에서 판정 기준을 자산 루트 대신 **봉쇄 루트로 바꿨다.** 그러자
   * 봉쇄 루트 밖에 있는 **프로젝트 스코프 스킬**(`<프로젝트>/.claude/skills/...`)이 전부
   * 거부됐다 — 링크도 아닌 평범한 파일인데. 실측: 이미 문서가 있던 **22건이 새로 차단**됐다.
   *
   * **단위 테스트 1085개가 전부 통과하는 동안 실환경 dry-run이 잡았다** — 픽스처가 전부 봉쇄
   * 루트 안이라 "봉쇄 밖의 정상 파일"이라는 축 자체가 표본에 없었다.
   */
  it("봉쇄 루트 **밖**의 링크 아닌 파일은 봉쇄 모드에서도 그대로 읽힌다 (회귀: 22건이 차단됐다)", () => {
    setup();
    // 프로젝트 스코프 스킬을 흉내낸다 — 봉쇄 루트(<config>/skills) 밖이고, 링크가 아니다.
    const projectSkill = path.join(root, "project", ".claude", "skills", "proj-skill");
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(path.join(projectSkill, "SKILL.md"), "프로젝트 스코프 본문");
    const md = path.join(projectSkill, "SKILL.md");
    expect(readAssetSourceFileSafely(md, projectSkill, 200_000, opts())).toBe("프로젝트 스코프 본문");
  });

  it("봉쇄 루트 밖의 파일이 **자산 루트 밖**을 realpath로 가리키면 여전히 거부된다", () => {
    setup();
    const projectSkill = path.join(root, "project", ".claude", "skills", "proj-skill");
    mkdirSync(projectSkill, { recursive: true });
    const alias = path.join(projectSkill, "SKILL.md");
    symlinkSync(secret, alias); // 봉쇄 밖을 가리키는 링크 — 스코프와 무관하게 막힌다
    expect(() => readAssetSourceFileSafely(alias, projectSkill, 200_000, opts())).toThrow(
      SymlinkAssetSourceRejectedError,
    );
  });

  it("링크가 아닌 일반 파일은 봉쇄 모드에서도 그대로 읽힌다", () => {
    setup();
    const plain = path.join(skills, "bundle", "inner", "SKILL.md");
    expect(readAssetSourceFileSafely(plain, path.dirname(plain), 200_000, opts())).toBe("번들 안의 본문");
  });

  it("봉쇄 모드에서도 크기 상한은 그대로 걸린다 — 한 가드를 풀어도 다른 가드는 산다", () => {
    setup();
    // 이름은 같게 두고 크기만 키운다 — basename 축과 크기 축을 섞지 않는다.
    const big = path.join(skills, "bundle", "big", "SKILL.md");
    mkdirSync(path.dirname(big), { recursive: true });
    writeFileSync(big, "x".repeat(500));
    const alias = path.join(skills, "alias", "SKILL.md");
    symlinkSync(big, alias);
    expect(() => readAssetSourceFileSafely(alias, path.dirname(alias), 100, opts())).toThrow(/크기 상한/);
  });
});

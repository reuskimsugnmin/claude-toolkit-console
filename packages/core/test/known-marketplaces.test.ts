import { describe, expect, it } from "vitest";
import { parseKnownMarketplacesFile, toRepoLink } from "../src/harness/known-marketplaces.schema.js";

/**
 * 요구사항 6(GitHub 링크)의 데이터 소스 파싱. 픽스처는 실측 형태를 재현하되 **익명화**한다
 * (이 저장소는 public — 실제 마켓플레이스명·개인 경로를 넣지 않는다).
 *
 * 실측(2026-08-22, 엔트리 16건 전수): `source.source`는 `github`(12) · `git`(3) · `directory`(1).
 */

describe("known_marketplaces.json 파싱", () => {
  it("세 가지 출처 유형을 모두 파싱한다", () => {
    const parsed = parseKnownMarketplacesFile({
      "synth-official": { source: { source: "github", repo: "synth-org/synth-plugins" }, lastUpdated: "2026-08-22T00:00:00.000Z" },
      "synth-remote": { source: { source: "git", url: "https://git.example/synth/tools.git" } },
      "synth-local": { source: { source: "directory", path: "/synthetic/home/dev/synth" }, autoUpdate: true },
    });
    expect(Object.keys(parsed)).toHaveLength(3);
    expect(parsed["synth-local"]?.autoUpdate).toBe(true);
  });

  it("모르는 키가 있어도 파싱이 깨지지 않는다 — 깨지면 링크가 통째로 빈다", () => {
    const parsed = parseKnownMarketplacesFile({
      "synth-official": { source: { source: "github", repo: "a/b", futureField: 1 }, brandNewKey: "x" },
    });
    expect(parsed["synth-official"]?.source.source).toBe("github");
  });

  it("source 자체가 없으면 파싱에 실패한다 — 조용히 빈 링크로 넘어가지 않는다", () => {
    expect(() => parseKnownMarketplacesFile({ "synth-broken": { lastUpdated: "x" } })).toThrow();
  });
});

describe("toRepoLink — 링크가 없다는 사실도 값이다", () => {
  it("github 출처는 repo 슬러그로 URL을 만든다", () => {
    expect(toRepoLink({ source: "github", repo: "synth-org/synth-plugins" })).toEqual({
      kind: "github",
      url: "https://github.com/synth-org/synth-plugins",
    });
  });

  it("git 출처는 원문 URL에서 .git만 떼고 호스트를 가정하지 않는다", () => {
    expect(toRepoLink({ source: "git", url: "https://git.example/synth/tools.git" })).toEqual({
      kind: "git",
      url: "https://git.example/synth/tools",
    });
  });

  it(".git이 없는 git URL은 그대로 둔다", () => {
    expect(toRepoLink({ source: "git", url: "https://git.example/synth/tools" }).url).toBe("https://git.example/synth/tools");
  });

  it("directory 출처는 url이 null이고 경로를 절대 내보내지 않는다 — 그 경로는 개인 절대경로다(AC-1.7)", () => {
    const link = toRepoLink({ source: "directory", path: "/synthetic/home/dev/synth" });
    expect(link).toEqual({ kind: "directory", url: null });
    expect(JSON.stringify(link)).not.toContain("/synthetic");
  });

  it("url이 null인 것과 kind가 없는 것은 다르다 — 전자는 '로컬 출처', 후자는 '미수집'이다", () => {
    const local = toRepoLink({ source: "directory", path: "/synthetic/x" });
    expect(local.kind).toBe("directory");
    expect(local.url).toBeNull();
    // 빈 문자열로 메우지 않는다: 화면이 빈 링크를 렌더하면 클릭 가능한 죽은 링크가 된다.
    expect(local.url).not.toBe("");
  });
});

describe("스킴 화이트리스트 — 저장소 링크가 XSS가 되지 않는다 (보안 심사 H3)", () => {
  it("javascript: 스킴은 링크로 만들지 않는다", () => {
    expect(toRepoLink({ source: "git", url: "javascript:fetch('/api/actions')" })).toEqual({ kind: "git", url: null });
  });

  it("data: 스킴도 거부한다", () => {
    expect(toRepoLink({ source: "git", url: "data:text/html,<script>alert(1)</script>" }).url).toBeNull();
  });

  it("file: 스킴도 거부한다", () => {
    expect(toRepoLink({ source: "git", url: "file:///etc/passwd" }).url).toBeNull();
  });

  it("scp 형식(git@host:path)은 URL이 아니므로 링크로 만들지 않는다", () => {
    expect(toRepoLink({ source: "git", url: "git@github.com:synth/x" }).url).toBeNull();
  });

  it("거부해도 kind는 남는다 — '링크 없음'과 '미수집'이 여전히 구분된다", () => {
    expect(toRepoLink({ source: "git", url: "javascript:1" }).kind).toBe("git");
  });

  it("정상 https는 그대로 통과한다 — 위 케이스들이 '전부 null'과 구분됨을 보인다", () => {
    expect(toRepoLink({ source: "git", url: "https://git.example/synth/tools.git" }).url).toBe(
      "https://git.example/synth/tools",
    );
  });
});

import { describe, expect, it } from "vitest";
import { buildProjectChoices, containsPathSeparator, toProjectLabel } from "../src/view/project-label.js";

/**
 * 안 B(마지막 세그먼트만 표시)의 계약. **이 파일의 본문은 "경로가 새지 않는다"이다** —
 * 라벨을 만드는 것은 부수적이고, 그 과정에서 상위 디렉터리 구조가 밖으로 나가지 않는 것이
 * 이 설계의 전부다(AC-1.7 · 보안 심사 M1).
 */

const hash = (p: string) => `h${p.length}`.padEnd(16, "0");

describe("toProjectLabel — 마지막 세그먼트만 남긴다", () => {
  it("홈 아래 경로에서 프로젝트 이름만 뽑는다", () => {
    expect(toProjectLabel("/synthetic/home/Developer/synth-console")).toBe("synth-console");
  });

  it("홈 **밖** 경로에서도 상위 구조가 남지 않는다 — 심사 L-b가 걱정한 경우다", () => {
    const label = toProjectLabel("/synthetic/work/Clients/Acme-confidential/synth-app");
    expect(label).toBe("synth-app");
    expect(label).not.toContain("Clients");
    expect(label).not.toContain("Acme-confidential");
  });

  it("후행 구분자를 무시한다", () => {
    expect(toProjectLabel("/synthetic/home/proj/")).toBe("proj");
    expect(toProjectLabel("/synthetic/home/proj///")).toBe("proj");
  });

  it("Windows 구분자도 받는다", () => {
    expect(toProjectLabel("C:\\\\Users\\\\synth\\\\Projects\\\\synth-app")).toBe("synth-app");
  });

  it("한글 등 비-ASCII 이름을 그대로 둔다 — 실측 표본에 1건 있었다", () => {
    expect(toProjectLabel("/synthetic/home/개인-프로젝트")).toBe("개인-프로젝트");
  });

  it("루트만 주면 빈 문자열이다 — 호출자가 대체 표기를 정한다", () => {
    expect(toProjectLabel("/")).toBe("");
  });
});

describe("buildProjectChoices — 인덱스가 곧 move의 인자다", () => {
  it("입력 순서를 바꾸지 않는다 — 정렬하면 고른 것과 서버가 쓰는 것이 어긋난다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/z-last", "/synthetic/a-first", "/synthetic/m-mid"],
      hashPrefixOf: hash,
    });
    expect(choices.map((c) => c.label)).toEqual(["z-last", "a-first", "m-mid"]);
    expect(choices.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("선택지 어디에도 절대경로가 남지 않는다", () => {
    const paths = [
      "/synthetic/home/Developer/synth-console",
      "/synthetic/work/Clients/Acme-confidential/synth-app",
    ];
    const choices = buildProjectChoices({ absolutePaths: paths, hashPrefixOf: hash });
    const serialized = JSON.stringify(choices);
    expect(serialized).not.toContain("/synthetic");
    expect(serialized).not.toContain("Developer");
    expect(serialized).not.toContain("Clients");
    expect(containsPathSeparator(choices)).toBe(false);
  });

  it("빈 이름은 대체 표기로 바뀐다 — 빈 버튼을 만들지 않는다", () => {
    const choices = buildProjectChoices({ absolutePaths: ["/"], hashPrefixOf: hash });
    expect(choices[0]?.label).toBe("(이름 없음)");
  });

  it("프로젝트가 없으면 빈 배열이다", () => {
    expect(buildProjectChoices({ absolutePaths: [], hashPrefixOf: hash })).toEqual([]);
  });
});

describe("동명 충돌 — 오조작을 막는다", () => {
  it("같은 라벨이 둘 이상이면 양쪽 다 ambiguous로 표시된다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/a/web", "/synthetic/b/web", "/synthetic/c/api"],
      hashPrefixOf: hash,
    });
    expect(choices.map((c) => c.ambiguous)).toEqual([true, true, false]);
  });

  it("충돌한 선택지는 서로 다른 해시 접두를 갖는다 — 화면이 구분할 수단이 있다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/a/web", "/synthetic/bb/web"],
      // 해시는 6자로 잘리므로 픽스처도 앞 6자가 달라야 한다.
      hashPrefixOf: (p) => (p.includes("/a/") ? "aaaaaa0000" : "bbbbbb0000"),
    });
    expect(choices[0]?.hashPrefix).not.toBe(choices[1]?.hashPrefix);
    expect(choices[0]?.hashPrefix).toHaveLength(6);
  });

  it("충돌 그룹 안에서 접두까지 겹치면 더 길게 준다 — 구별 수단이 조용히 사라지지 않는다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/a/web", "/synthetic/b/web"],
      // 앞 6자가 같고 뒤가 다른 해시 — 6자로 자르면 구별이 사라진다(재심 L3).
      hashPrefixOf: (p) => (p.includes("/a/") ? "same00AAAA" : "same00BBBB"),
    });
    expect(choices[0]?.hashPrefix).not.toBe(choices[1]?.hashPrefix);
    expect(choices[0]?.hashPrefix).toHaveLength(10);
  });

  it("충돌하지 않으면 접두를 넓히지 않는다 — 위 케이스가 '항상 10자'와 구분됨을 보인다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/a/web", "/synthetic/b/api"],
      hashPrefixOf: () => "same00XXXX",
    });
    expect(choices[0]?.hashPrefix).toHaveLength(6);
  });

  it("충돌이 없으면 ambiguous가 전부 false다 — 위 케이스가 '항상 true'와 구분됨을 보인다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/a/web", "/synthetic/b/api"],
      hashPrefixOf: hash,
    });
    expect(choices.every((c) => !c.ambiguous)).toBe(true);
  });
});

describe("containsPathSeparator — 계약을 호출자도 확인할 수 있다", () => {
  it("라벨에 구분자가 있으면 true", () => {
    expect(containsPathSeparator([{ index: 0, label: "a/b", ambiguous: false, hashPrefix: "x" }])).toBe(true);
    expect(containsPathSeparator([{ index: 0, label: "a\\\\b", ambiguous: false, hashPrefix: "x" }])).toBe(true);
  });

  it("정상 라벨은 false", () => {
    expect(containsPathSeparator([{ index: 0, label: "synth-app", ambiguous: false, hashPrefix: "x" }])).toBe(false);
  });
});

describe("시각적으로 같은 라벨을 놓치지 않는다 (재심 M4)", () => {
  it("NFC/NFD 두 표기는 같은 이름으로 센다 — 화면에서는 같은 글자다", () => {
    const nfc = "caf\u00e9-app";
    const nfd = "cafe\u0301-app";
    const choices = buildProjectChoices({
      absolutePaths: [`/synthetic/a/${nfc}`, `/synthetic/b/${nfd}`],
      hashPrefixOf: hash,
    });
    expect(choices.map((c) => c.ambiguous)).toEqual([true, true]);
  });

  it("후행 공백만 다른 이름도 충돌로 본다 — 브라우저가 공백을 접는다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/a/api", "/synthetic/b/api "],
      hashPrefixOf: hash,
    });
    expect(choices.map((c) => c.ambiguous)).toEqual([true, true]);
  });

  it("양방향 제어문자가 섞인 이름도 충돌로 본다 — 표시 순서를 뒤집는다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/a/app", "/synthetic/b/\u202Eapp"],
      hashPrefixOf: hash,
    });
    expect(choices.map((c) => c.ambiguous)).toEqual([true, true]);
  });

  it("정말 다른 이름은 충돌이 아니다 — 위 케이스들이 '전부 충돌'과 구분됨을 보인다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/a/web", "/synthetic/b/api"],
      hashPrefixOf: hash,
    });
    expect(choices.map((c) => c.ambiguous)).toEqual([false, false]);
  });
});

describe("parentHint — 사람이 읽을 구별자 (재심 M4)", () => {
  it("충돌한 항목에만 상위 한 칸이 붙는다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/alpha/web", "/synthetic/beta/web", "/synthetic/gamma/api"],
      hashPrefixOf: hash,
    });
    expect(choices[0]?.parentHint).toBe("alpha");
    expect(choices[1]?.parentHint).toBe("beta");
    expect(choices[2]?.parentHint).toBeUndefined();
  });

  it("parentHint도 세그먼트 하나뿐이다 — 계층이 새지 않는다", () => {
    const choices = buildProjectChoices({
      absolutePaths: ["/synthetic/work/Clients/Acme/web", "/synthetic/home/dev/web"],
      hashPrefixOf: hash,
    });
    expect(choices[0]?.parentHint).toBe("Acme");
    expect(JSON.stringify(choices)).not.toContain("Clients");
    expect(containsPathSeparator(choices)).toBe(false);
  });

  it("parentHint에 구분자가 있으면 containsPathSeparator가 잡는다", () => {
    expect(
      containsPathSeparator([{ index: 0, label: "web", ambiguous: true, hashPrefix: "x", parentHint: "a/b" }]),
    ).toBe(true);
  });
});

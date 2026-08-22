import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { browserOpenCommand, browserOpenTokenNotice } from "../src/commands/web.js";
import { openInBrowser } from "../src/open-browser.js";

/**
 * `ctk web --open`의 계약.
 *
 * 이 기능이 치르는 값은 **세션 토큰이 실행 인자에 실린다**는 것이다 — 같은 머신의 다른 계정이
 * `ps`로 볼 수 있다. 조회 노출(프로젝트 이름)과 달리 **쓰기 자격증명**이므로 매번 고지한다.
 * 그 고지가 사라지면 사용자는 대가를 모른 채 편의만 쓰게 되므로 여기서 못 박는다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("browserOpenCommand — 플랫폼별 실행기", () => {
  const URL = "http://127.0.0.1:8787/#token=abc";

  it("macOS는 절대경로를 쓴다 — PATH 오설정·동명 바이너리를 타지 않는다", () => {
    expect(browserOpenCommand(URL, "darwin")).toEqual({ command: "/usr/bin/open", args: [URL] });
  });

  it("Linux는 xdg-open", () => {
    expect(browserOpenCommand(URL, "linux")).toEqual({ command: "xdg-open", args: [URL] });
  });

  it("Windows는 cmd /c start — 첫 인자는 창 제목 자리라 비워 둔다", () => {
    expect(browserOpenCommand(URL, "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", URL] });
  });

  it("모르는 플랫폼은 null — 던지지 않는다", () => {
    expect(browserOpenCommand(URL, "aix")).toBeNull();
  });

  it("URL을 가공하지 않는다 — 프래그먼트가 잘리면 토큰이 사라져 조회 전용이 된다", () => {
    const withFragment = browserOpenCommand(URL, "darwin");
    expect(withFragment?.args[0]).toBe(URL);
    expect(withFragment?.args[0]).toContain("#token=abc");
  });
});

describe("토큰 고지 — 편의의 대가를 매번 말한다", () => {
  it("액션 모드에서는 고지한다", () => {
    const notice = browserOpenTokenNotice(true);
    expect(notice).not.toBeNull();
    expect(notice).toContain("실행 인자");
    // 빠져나갈 길을 함께 준다(안전 원칙 6).
    expect(notice).toContain("--open 없이");
  });

  it("조회 전용에서는 고지하지 않는다 — 토큰이 없으므로 노출도 없다", () => {
    expect(browserOpenTokenNotice(false)).toBeNull();
  });
});

describe("openInBrowser — 실패해도 서버를 죽이지 않는다", () => {
  it("모르는 플랫폼이면 사유와 함께 실패를 돌려준다(던지지 않는다)", () => {
    expect(openInBrowser("http://127.0.0.1:1/", "aix")).toEqual({
      opened: false,
      reason: "unsupported_platform",
    });
  });

  it("실행기가 없어도 던지지 않는다 — 브라우저를 못 여는 것이 기동을 막을 이유는 아니다", () => {
    // linux 분기를 macOS에서 태우면 `xdg-open`이 없어 spawn이 ENOENT로 실패한다.
    // 그 실패가 error 이벤트로만 오고 예외로 새지 않는지 본다.
    expect(() => openInBrowser("http://127.0.0.1:1/", "linux")).not.toThrow();
  });
});

describe("데몬 불변식을 깨지 않는다 (ADR-003)", () => {
  /**
   * 브라우저 실행은 서브프로세스 spawn이라 **상주 프로세스를 만들기 쉬운 자리**다.
   * `detached: true`가 들어오면 `ctk web`이 데몬이 되는 첫걸음이므로 여기서도 막는다
   * (`daemon-invariant.test.ts`가 저장소 전체를 보지만, 이 파일은 그 이유를 남긴다).
   */
  it("open-browser.ts가 detached를 쓰지 않는다", () => {
    const source = readFileSync(path.join(repoRoot, "packages/cli/src/open-browser.ts"), "utf8");
    expect(source).not.toMatch(/detached\s*:\s*true/);
  });

  it("이 검사가 공허하지 않다 — 파일을 실제로 읽었다", () => {
    const source = readFileSync(path.join(repoRoot, "packages/cli/src/open-browser.ts"), "utf8");
    expect(source).toContain("openInBrowser");
  });
});

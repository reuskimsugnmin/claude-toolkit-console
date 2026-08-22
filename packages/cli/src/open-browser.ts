import { spawn } from "node:child_process";
import { browserOpenCommand } from "./commands/web.js";

/**
 * cli/src/open-browser.ts — `ctk web --open`의 실제 브라우저 실행.
 *
 * 플랫폼 → 명령 매핑은 `commands/web.ts`의 순수 함수가 하고, 여기서는 spawn만 한다.
 *
 * ⚠️ **자식을 detach하지 않는다.** ADR-003 데몬 불변식이 금지하고 회귀 테스트가 검사한다
 * (`daemon-invariant.test.ts`). 브라우저 실행기(`open`·`xdg-open`)는 핸드오프 후 즉시
 * 종료하므로 detach가 필요 없다 — 필요해 보인다면 그건 상주 프로세스를 만들고 있다는 신호다.
 *
 * (그 검사는 문자열 매칭이라 **금지 패턴을 인용한 주석도 잡는다.** 실제로 이 주석이 처음
 * 걸렸다 — fail-closed 방향이라 위험하진 않지만, 설명할 때 그 리터럴을 쓰지 않는다.)
 *
 * **실패해도 던지지 않는다.** 브라우저를 못 여는 것이 서버 기동을 막을 이유는 없다 —
 * 사용자는 이미 출력된 URL을 직접 열 수 있다(안전 원칙 6 — 빠져나갈 길을 남긴다).
 */
export type BrowserOpenOutcome =
  | { opened: true }
  | { opened: false; reason: "unsupported_platform" | "spawn_failed" };

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): BrowserOpenOutcome {
  const resolved = browserOpenCommand(url, platform);
  if (resolved === null) return { opened: false, reason: "unsupported_platform" };
  try {
    const child = spawn(resolved.command, [...resolved.args], { stdio: "ignore" });
    // 실행기가 없거나(`xdg-open` 미설치) 실행 자체가 실패해도 프로세스를 죽이지 않는다.
    child.on("error", () => {});
    child.unref();
    return { opened: true };
  } catch {
    return { opened: false, reason: "spawn_failed" };
  }
}

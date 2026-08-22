import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_MARKER_FILENAME, hookMarkerControlConfirmed } from "../src/commands/verify-seal.js";

/**
 * (i) 신호의 양성 대조군 탐지기.
 *
 * **이 함수가 없던 동안 (i)은 아무것도 증명하지 않았다** — 마커를 만드는 훅이 실제 settings에
 * 0건이었고(2026-08-23 실측), 그래서 `hookMarkerAbsent`는 봉인 여부와 무관하게 항상 true였다.
 * 코드는 (ii)에 대해서는 대조군을 강제하면서 (i)에는 같은 논리를 적용하지 않았다.
 *
 * ⚠️ 이 탐지기는 **명령을 실행하지 않는다.** settings의 훅 명령을 실행하면 임의 코드를 도는
 * 것이 되므로, 배선 여부(마커 경로를 쓰는가)만 본다. 명령이 실제로 동작하는지는 운영자가
 * 유료 실행 전에 0원으로 한 번 돌려 확인한다.
 */

const MARKER = "/synthetic/cwd/.ctk-seal-hook-marker";

function settingsWith(contents: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-settings-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(contents), "utf8");
  return file;
}

const sessionStartHook = (command: string) => ({
  hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
});

describe("배선이 있으면 확인된다", () => {
  it("SessionStart 훅 명령에 마커 경로가 있으면 true", () => {
    expect(hookMarkerControlConfirmed(settingsWith(sessionStartHook(`touch ${MARKER}`)), MARKER)).toBe(true);
  });

  it("여러 훅 중 하나만 있어도 찾는다 — 기존 훅과 공존한다", () => {
    const file = settingsWith({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "node /synthetic/other.mjs" }] },
          { hooks: [{ type: "command", command: `/bin/touch ${MARKER}` }] },
        ],
      },
    });
    expect(hookMarkerControlConfirmed(file, MARKER)).toBe(true);
  });
});

describe("배선이 없으면 '확인됨'이라고 하지 않는다 (안전 원칙 7)", () => {
  it("SessionStart 훅이 아예 없으면 false — 실측된 상태가 이것이었다", () => {
    expect(hookMarkerControlConfirmed(settingsWith({ hooks: { Stop: [] } }), MARKER)).toBe(false);
  });

  it("SessionStart는 있는데 마커 경로를 쓰지 않으면 false", () => {
    expect(hookMarkerControlConfirmed(settingsWith(sessionStartHook("node /synthetic/x.mjs")), MARKER)).toBe(false);
  });

  it("**다른 이벤트**에 배선된 것은 세지 않는다 — -p 세션에서 발화 시점이 다르다", () => {
    const file = settingsWith({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `touch ${MARKER}` }] }] } });
    expect(hookMarkerControlConfirmed(file, MARKER)).toBe(false);
  });

  it("settings.json이 없으면 false", () => {
    expect(hookMarkerControlConfirmed("/synthetic/does-not-exist.json", MARKER)).toBe(false);
  });

  it("깨진 JSON은 '배선됨'이 아니다 — 읽기 실패를 확인으로 바꾸지 않는다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-broken-"));
    const file = path.join(dir, "settings.json");
    writeFileSync(file, "{ 이건 JSON이 아니다", "utf8");
    expect(hookMarkerControlConfirmed(file, MARKER)).toBe(false);
  });

  it("hooks가 배열이 아닌 엉뚱한 형태여도 던지지 않고 false", () => {
    expect(hookMarkerControlConfirmed(settingsWith({ hooks: { SessionStart: "not-an-array" } }), MARKER)).toBe(false);
    expect(hookMarkerControlConfirmed(settingsWith({ hooks: 42 }), MARKER)).toBe(false);
    expect(hookMarkerControlConfirmed(settingsWith([1, 2, 3]), MARKER)).toBe(false);
  });

  it("경로가 부분만 겹치면 false — 다른 마커를 우리 것으로 세지 않는다", () => {
    const other = "/synthetic/cwd/.ctk-seal-hook-marker-OTHER";
    expect(hookMarkerControlConfirmed(settingsWith(sessionStartHook(`touch ${MARKER}`)), other)).toBe(false);
  });
});

describe("마커 파일 이름은 한 곳에서만 정한다", () => {
  it("상수가 실제 파일 이름이다 — 훅 명령과 검사 대상이 갈라지면 신호가 죽는다", () => {
    expect(HOOK_MARKER_FILENAME).toBe(".ctk-seal-hook-marker");
    expect(MARKER.endsWith(HOOK_MARKER_FILENAME)).toBe(true);
  });
});

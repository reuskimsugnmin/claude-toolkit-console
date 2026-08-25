import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HomeContext } from "@ctk/probe";
import { runSealLiveTest } from "../src/seal-live-test.js";

const HOME: HomeContext = { ctkHome: "/synthetic/home", ctkConfigDir: "/synthetic/home/.claude", configDirExplicit: true };

describe("gen/seal-live-test — ⓓ-2 실행형 봉인 테스트 (가짜 spawnFn으로 3신호 로직만 검증)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function baseOptions(hookMarkerPath: string) {
    return {
      home: HOME,
      cwd: "/synthetic/sealed-cwd",
      timeoutSec: 30,
      maxBudgetUsd: 0.2,
      verifiedCliVersion: "2.1.238",
      hookMarkerPath,
      hookMarkerControlConfirmed: true,
      claudeMdMarkerString: "CTK_SPIKE_MARKER_STRING",
      installedPluginCommand: "/synth-plugin:help",
    };
  }

  it("3신호 전부 통과 + 양성 대조군 통과 시 passed:true", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-live-test-"));
    const hookMarkerPath = path.join(dir, "hook-marker.txt"); // 존재하지 않음 = (i) 통과

    let call = 0;
    const spawnFn = async () => {
      call++;
      if (call === 1) return { exitCode: 0, stdout: "YES", stderr: "", timedOut: false }; // 양성 대조군
      if (call === 2) return { exitCode: 0, stdout: "NO", stderr: "", timedOut: false }; // (ii) 실제 세션
      return { exitCode: 1, stdout: "", stderr: "Unknown command: /synth-plugin:help", timedOut: false }; // (iii)
    };

    const result = await runSealLiveTest({ ...baseOptions(hookMarkerPath), spawnFn: spawnFn as never });
    expect(result.signals).toEqual({
      positiveControlDetected: true,
      hookMarker: "confirmed_absent",
      claudeMdString: "confirmed_absent",
      claudeMdDiagnostic: { exitCode: 0, answerExcerpt: "NO" },
      pluginCommandRouting: "confirmed_unrecognized",
    });
    expect(result.passed).toBe(true);
  });

  it("양성 대조군이 실패하면(모델이 주입한 문자열조차 못 봄) passed는 무조건 false다(R14 — (ii)를 판정 근거로 쓰지 않는다)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-live-test-control-fail-"));
    const hookMarkerPath = path.join(dir, "hook-marker.txt");
    const spawnFn = async () => ({ exitCode: 0, stdout: "NO", stderr: "", timedOut: false }); // 대조군도 NO
    const result = await runSealLiveTest({ ...baseOptions(hookMarkerPath), spawnFn: spawnFn as never });
    expect(result.signals.positiveControlDetected).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("훅 마커 파일이 존재하면(SessionStart 훅이 실제로 발화) (i)이 실패한다", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-live-test-hook-fired-"));
    const hookMarkerPath = path.join(dir, "hook-marker.txt");
    writeFileSync(hookMarkerPath, "fired"); // 실제로 발화한 것처럼 재현

    let call = 0;
    const spawnFn = async () => {
      call++;
      if (call === 1) return { exitCode: 0, stdout: "YES", stderr: "", timedOut: false };
      if (call === 2) return { exitCode: 0, stdout: "NO", stderr: "", timedOut: false };
      return { exitCode: 1, stdout: "", stderr: "Unknown command", timedOut: false };
    };
    const result = await runSealLiveTest({ ...baseOptions(hookMarkerPath), spawnFn: spawnFn as never });
    expect(result.signals.hookMarker).toBe("present");
    expect(result.passed).toBe(false);
  });

  it("실제 CLAUDE.md 문자열이 컨텍스트에 보이면(봉인 실패) (ii)가 실패한다", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-live-test-claudemd-leak-"));
    const hookMarkerPath = path.join(dir, "hook-marker.txt");
    let call = 0;
    const spawnFn = async () => {
      call++;
      if (call === 1) return { exitCode: 0, stdout: "YES", stderr: "", timedOut: false }; // 대조군
      if (call === 2) return { exitCode: 0, stdout: "YES", stderr: "", timedOut: false }; // 실제 세션도 YES = 새고 있다
      return { exitCode: 1, stdout: "", stderr: "Unknown command", timedOut: false };
    };
    const result = await runSealLiveTest({ ...baseOptions(hookMarkerPath), spawnFn: spawnFn as never });
    expect(result.signals.claudeMdString).toBe("present");
    expect(result.passed).toBe(false);
  });

  it("설치 플러그인 커맨드가 인식되면(봉인 실패) (iii)이 실패한다", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-live-test-plugin-recognized-"));
    const hookMarkerPath = path.join(dir, "hook-marker.txt");
    let call = 0;
    const spawnFn = async () => {
      call++;
      if (call === 1) return { exitCode: 0, stdout: "YES", stderr: "", timedOut: false };
      if (call === 2) return { exitCode: 0, stdout: "NO", stderr: "", timedOut: false };
      return { exitCode: 0, stdout: "명령을 실행했습니다", stderr: "", timedOut: false }; // 인식됨
    };
    const result = await runSealLiveTest({ ...baseOptions(hookMarkerPath), spawnFn: spawnFn as never });
    expect(result.signals.pluginCommandRouting).toBe("recognized");
    expect(result.passed).toBe(false);
  });
});

describe("(i)의 양성 대조군 — 없으면 판정하지 않는다 (2026-08-23 실측)", () => {
  /**
   * `hookMarkerAbsent`는 **봉인 여부와 무관하게 항상 true였다.** 마커를 만드는 훅이
   * settings에 0건이었기 때문이다(실측). 부재가 "훅이 발화하지 않았다"인지 "애초에 만들 것이
   * 없었다"인지 구분되지 않으면 그건 신호가 아니다 — (ii)에 대해 이미 강제하던 논리(R14)가
   * (i)에는 빠져 있었다.
   */
  function opts(dir: string, controlConfirmed: boolean) {
    return {
      home: { ctkHome: dir, ctkConfigDir: path.join(dir, ".claude"), configDirExplicit: false } as never,
      cwd: dir,
      timeoutSec: 60,
      maxBudgetUsd: 0.5,
      verifiedCliVersion: "2.1.238",
      hookMarkerPath: path.join(dir, "hook-marker.txt"), // 존재하지 않음
      hookMarkerControlConfirmed: controlConfirmed,
      claudeMdMarkerString: "SYNTHETIC-MARKER-STRING-FOR-TEST",
      installedPluginCommand: "/synth-plugin:help",
    };
  }

  /** 세 신호가 전부 통과하도록 만든 spawn 스텁 — (i)만 변수로 남긴다. */
  const allPassSpawn = () => {
    let call = 0;
    return () => {
      call++;
      // 1: 대조군(YES) · 2: (ii) 실제 세션(NO) · 3: (iii) 커맨드 미인식
      if (call === 1) return Promise.resolve({ stdout: "YES", stderr: "", exitCode: 0, timedOut: false });
      if (call === 2) return Promise.resolve({ stdout: "NO", stderr: "", exitCode: 0, timedOut: false });
      return Promise.resolve({ stdout: "", stderr: "unknown command", exitCode: 1, timedOut: false });
    };
  };

  it("대조군이 없으면 (i)은 unmeasured이고 passed가 false다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-nocontrol-"));
    const result = await runSealLiveTest({ ...opts(dir, false), spawnFn: allPassSpawn() as never });
    expect(result.signals.hookMarker).toBe("unmeasured");
    expect(result.passed, "못 잰 축이 있으면 통과가 아니다").toBe(false);
  });

  it("대조군이 있으면 같은 조건에서 통과한다 — 위 케이스가 '항상 실패'와 구분됨을 보인다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-control-"));
    const result = await runSealLiveTest({ ...opts(dir, true), spawnFn: allPassSpawn() as never });
    expect(result.signals.hookMarker).toBe("confirmed_absent");
    expect(result.passed).toBe(true);
  });

  it("대조군이 있어도 마커가 생겼으면 present이고 실패다 — 봉인이 뚫린 경우다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-fired-"));
    writeFileSync(path.join(dir, "hook-marker.txt"), "fired");
    const result = await runSealLiveTest({ ...opts(dir, true), spawnFn: allPassSpawn() as never });
    expect(result.signals.hookMarker).toBe("present");
    expect(result.passed).toBe(false);
  });
});

/**
 * (ii)의 **fail-open 회귀 고정.**
 *
 * 예전 판정은 `absent = !(exitCode === 0 && containsYes(stdout))`였다. 그래서 호출이 실패하면
 * — 타임아웃·봉인 에러·인증 실패 무엇이든 — 곧바로 `absent = true`가 되어 신호가 "통과"로
 * 읽혔다. **"없음"과 "실패"를 구분한다**(안전 원칙 7).
 *
 * 여기서 재는 두 입력은 **예전 코드에서 전부 passed:true였다.** 축이 갈리지 않는 표본으로는
 * 이 결함을 주입해도 통과한다 — 그래서 "호출 실패"와 "판독 불가"를 따로 넣는다.
 */
describe("gen/seal-live-test — (ii)는 호출 실패를 '부재'로 삼키지 않는다", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function optsFor(dir: string) {
    return {
      home: HOME,
      cwd: "/synthetic/sealed-cwd",
      timeoutSec: 30,
      maxBudgetUsd: 0.2,
      verifiedCliVersion: "2.1.238",
      hookMarkerPath: path.join(dir, "hook-marker.txt"),
      hookMarkerControlConfirmed: true,
      claudeMdMarkerString: "CTK_SPIKE_MARKER_STRING",
      // 합성 이름을 쓴다 — public 저장소에 실제 설치된 플러그인 이름을 새로 심지 않는다(심사 L-3).
      installedPluginCommand: "/synth-plugin:help",
    };
  }

  /** 대조군은 통과시키고 (ii) 호출만 지정한 결과로 바꾼다 — 다른 축을 고정해 (ii)만 가른다. */
  function spawnWithSecond(second: { exitCode: number | null; stdout: string }) {
    let call = 0;
    return async () => {
      call++;
      if (call === 1) return { exitCode: 0, stdout: "YES", stderr: "", timedOut: false };
      if (call === 2) return { ...second, stderr: "", timedOut: false };
      return { exitCode: 1, stdout: "", stderr: "Unknown command", timedOut: false };
    };
  }

  it("(ii) 호출이 비정상 종료하면 unmeasured이고 passed가 false다 (예전에는 통과였다)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-ii-exit-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithSecond({ exitCode: 143, stdout: "" }) as never,
    });
    expect(result.signals.claudeMdString, "실패를 부재로 읽었다").toBe("unmeasured");
    expect(result.passed, "못 잰 축이 있으면 통과가 아니다").toBe(false);
  });

  it("(ii) 응답이 YES도 NO도 아니면 unmeasured다 — 판정할 수 없으면 판정하지 않는다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-ii-garbage-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithSecond({ exitCode: 0, stdout: "죄송하지만 답변할 수 없습니다" }) as never,
    });
    expect(result.signals.claudeMdString).toBe("unmeasured");
    expect(result.passed).toBe(false);
  });

  it("YES와 NO가 함께 나와도 unmeasured다 — 한쪽을 골라 읽지 않는다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-ii-both-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithSecond({ exitCode: 0, stdout: "YES 아니 NO" }) as never,
    });
    expect(result.signals.claudeMdString).toBe("unmeasured");
    expect(result.passed).toBe(false);
  });

  /**
   * **심사 M-2 — 위 셋은 `exitCode` 가드를 고정하지 못한다.** 세 입력이 전부 stdout 축만 흔들고
   * exitCode 축은 판독 불가한 출력으로 묶여 있어, 가드를 떼어도 여전히 `unmeasured`가 나온다.
   * **두 축이 갈리는 입력**은 하나뿐이다 — 호출은 실패했는데 출력에 단독 단어 `no`가 들어 있는
   * 것(하네스 에러 문자열에 흔하다). 이 입력이 없으면 가드를 지워도 전 스위트가 통과하고,
   * 실패한 호출이 다시 "부재"로 읽힌다.
   */
  it("호출이 실패했으면 stdout에 NO가 있어도 unmeasured다 (exitCode 축 단독)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-ii-failed-no-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithSecond({ exitCode: 1, stdout: "Error: no such profile" }) as never,
    });
    expect(result.signals.claudeMdString, "실패 출력의 'no'를 답으로 읽었다").toBe("unmeasured");
    expect(result.passed).toBe(false);
  });

  it("신호로 죽어 종료 코드가 없어도(null) unmeasured다 — null은 0이 아니다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-ii-null-exit-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithSecond({ exitCode: null, stdout: "no" }) as never,
    });
    expect(result.signals.claudeMdString).toBe("unmeasured");
    expect(result.passed).toBe(false);
  });

  /**
   * **심사 M-3 — 한국어 응답으로 영구 차단되지 않는다.** 프롬프트는 영어 한 단어를 요구하지만
   * 모델이 늘 따르지는 않는다. 못 읽으면 `unmeasured` → `passed` 영구 false →
   * `verified_cli_version`이 갱신되지 않아 유료 `gen`이 영영 막히고, 그때 사용자는 게이트를
   * 우회하는 법부터 찾는다(안전 원칙 6).
   */
  it("한국어 '아니오'도 부재로 읽는다 — 수렴하지 않는 유료 재시도를 만들지 않는다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-ii-ko-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithSecond({ exitCode: 0, stdout: "아니오" }) as never,
    });
    expect(result.signals.claudeMdString).toBe("confirmed_absent");
    expect(result.passed).toBe(true);
  });

  it("미측정일 때 진단(exit·응답 발췌)을 함께 싣는다 — 이유 없는 재시도는 유료다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-ii-diag-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithSecond({ exitCode: 137, stdout: "죄송하지만 답할 수 없습니다" }) as never,
    });
    expect(result.signals.claudeMdString).toBe("unmeasured");
    expect(result.signals.claudeMdDiagnostic.exitCode).toBe(137);
    expect(result.signals.claudeMdDiagnostic.answerExcerpt).toContain("죄송");
  });

  it("같은 조건에서 NO면 confirmed_absent이고 통과다 — 위 셋이 '항상 실패'와 구분됨을 보인다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-ii-no-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithSecond({ exitCode: 0, stdout: "NO" }) as never,
    });
    expect(result.signals.claudeMdString).toBe("confirmed_absent");
    expect(result.passed).toBe(true);
  });
});

/**
 * **심사 L-1 — (iii)도 3상태다.** 이전에는 boolean이라 "봉인 파손"과 "못 쟀다"가 `실패` 한
 * 단어로 뭉쳤다. 방향은 fail-closed였지만(호출이 실패하면 정규식이 안 걸린다) 화면이 (i)·(ii)에
 * 준 3분기 문구를 여기에는 줄 수 없었다 — **4신호 중 2개만 3상태화된 상태였다.**
 * 리뷰 지적은 항목이 아니라 **범위로** 닫는다.
 */
describe("gen/seal-live-test — (iii) 라우팅 신호의 3상태", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function optsFor(dir: string) {
    return {
      home: HOME,
      cwd: "/synthetic/sealed-cwd",
      timeoutSec: 30,
      maxBudgetUsd: 0.2,
      verifiedCliVersion: "2.1.238",
      hookMarkerPath: path.join(dir, "hook-marker.txt"),
      hookMarkerControlConfirmed: true,
      claudeMdMarkerString: "CTK_SPIKE_MARKER_STRING",
      installedPluginCommand: "/synth-plugin:help",
    };
  }

  /** 앞 두 호출은 통과시키고 (iii)만 가른다 — 다른 축을 고정해야 이 축이 드러난다. */
  function spawnWithThird(third: { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }) {
    let call = 0;
    return async () => {
      call++;
      if (call === 1) return { exitCode: 0, stdout: "YES", stderr: "", timedOut: false };
      if (call === 2) return { exitCode: 0, stdout: "NO", stderr: "", timedOut: false };
      return { timedOut: false, ...third };
    };
  }

  it("타임아웃은 '미인식'이 아니라 unmeasured다 — 출력이 없는 것은 답이 아니다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-iii-timeout-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithThird({ exitCode: null, stdout: "", stderr: "", timedOut: true }) as never,
    });
    expect(result.signals.pluginCommandRouting).toBe("unmeasured");
    expect(result.passed, "못 잰 축이 있으면 통과가 아니다").toBe(false);
  });

  it("출력이 아예 비어 있으면 unmeasured다 — 판정 근거가 없다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-iii-empty-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithThird({ exitCode: 1, stdout: "", stderr: "" }) as never,
    });
    expect(result.signals.pluginCommandRouting).toBe("unmeasured");
    expect(result.passed).toBe(false);
  });

  it("커맨드가 인식되면 recognized이고 실패다 — 봉인이 뚫린 경우다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-iii-recognized-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithThird({ exitCode: 0, stdout: "스킬을 로드했다", stderr: "" }) as never,
    });
    expect(result.signals.pluginCommandRouting).toBe("recognized");
    expect(result.passed).toBe(false);
  });

  it("Unknown command면 confirmed_unrecognized이고 통과다 — 위 셋이 '항상 실패'와 구분된다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-seal-iii-ok-"));
    dirs.push(dir);
    const result = await runSealLiveTest({
      ...optsFor(dir),
      spawnFn: spawnWithThird({ exitCode: 1, stdout: "", stderr: "Unknown command: /synth-plugin:help" }) as never,
    });
    expect(result.signals.pluginCommandRouting).toBe("confirmed_unrecognized");
    expect(result.passed).toBe(true);
  });
});

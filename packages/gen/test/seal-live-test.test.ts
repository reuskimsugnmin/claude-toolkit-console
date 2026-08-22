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
      claudeMdMarkerString: "CTK_SPIKE_MARKER_STRING",
      installedPluginCommand: "/oh-my-claudecode:help",
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
      return { exitCode: 1, stdout: "", stderr: "Unknown command: /oh-my-claudecode:help", timedOut: false }; // (iii)
    };

    const result = await runSealLiveTest({ ...baseOptions(hookMarkerPath), spawnFn: spawnFn as never });
    expect(result.signals).toEqual({
      positiveControlDetected: true,
      hookMarkerAbsent: true,
      claudeMdStringAbsent: true,
      installedPluginCommandUnrecognized: true,
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
    expect(result.signals.hookMarkerAbsent).toBe(false);
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
    expect(result.signals.claudeMdStringAbsent).toBe(false);
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
    expect(result.signals.installedPluginCommandUnrecognized).toBe(false);
    expect(result.passed).toBe(false);
  });
});

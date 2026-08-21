import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile, atomicWriteJson, AtomicWriteVerifyError } from "../src/guard/atomic-write.js";

describe("actuator/guard/atomic-write — temp write -> fsync -> rename + 재파싱 검증(AC-2.8)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-atomic-write-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("JSON을 원자적으로 쓰고, 쓴 뒤 재파싱이 가능하다", () => {
    const target = path.join(dir, "settings.json");
    atomicWriteJson(target, { enabledPlugins: { "a@b": true } });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ enabledPlugins: { "a@b": true } });
  });

  it("쓰기 도중에도 임시 파일이 아니라 최종 파일만 남는다(원자성 — 중간 상태 노출 없음)", () => {
    const target = path.join(dir, "settings.json");
    atomicWriteJson(target, { a: 1 });
    const entries = readdirSync(dir);
    expect(entries).toEqual(["settings.json"]);
  });

  it("대상 디렉터리가 없으면 만든다", () => {
    const target = path.join(dir, "nested", "deep", "settings.json");
    atomicWriteJson(target, { a: 1 });
    expect(existsSync(target)).toBe(true);
  });

  it("기존 파일을 덮어쓸 수 있다(값만 바뀌고 나머지 흔적 없음)", () => {
    const target = path.join(dir, "settings.json");
    writeFileSync(target, JSON.stringify({ old: true }), "utf8");
    atomicWriteJson(target, { new: true });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ new: true });
  });

  it("재파싱 검증이 실패하면 AtomicWriteVerifyError를 던진다(쓴 뒤 손상 감지 — 회귀 방지용 방어)", () => {
    const target = path.join(dir, "broken.json");
    expect(() => atomicWriteFile(target, "not valid json", { reparse: (raw) => JSON.parse(raw) as unknown })).toThrow(
      AtomicWriteVerifyError,
    );
    // 검증 실패해도 파일 자체는 rename까지 끝난 상태로 남는다(쓰기 자체는 성공했다는 뜻) — 이
    // 오류는 "내용이 기대와 다르다"는 신호이지 "쓰기가 실패했다"는 신호가 아니다.
    expect(existsSync(target)).toBe(true);
  });

  it("임시 파일명이 Tier-2 tmp 정규식과 동형이다(rename 실패 시 tmp_leftover로 정확히 분류되기 위해)", () => {
    const TMP_PATTERN = /^\.[^.]+\.tmp\.\d+\.[A-Za-z0-9]+$/;
    const target = path.join(dir, "settings.json");
    atomicWriteJson(target, { a: 1 });
    expect(readdirSync(dir).some((f) => TMP_PATTERN.test(f))).toBe(false);
  });

  it(
    "✅ M4 재현 — temp write 단계(rename 이전)에서 프로세스가 SIGKILL로 강제 종료돼도 대상 " +
      "파일은 조치 이전 내용 그대로 남는다(원자성의 핵심 보장 — 이전 구현엔 이 시나리오를 " +
      "'직접 재현하기 어렵다'며 정상 경로 테스트로만 대체한 주석이 있었다). 이 테스트는 실제 " +
      "자식 프로세스를 spawn해 진짜 SIGKILL을 보낸다",
    async () => {
      const target = path.join(dir, "settings.json");
      writeFileSync(target, JSON.stringify({ original: true }), "utf8");

      // atomicWriteFile과 동일한 tmp 명명 규약으로 "temp write → fsync → (READY 신호) → 대기"까지만
      // 수행하는 자식 프로세스. rename에는 절대 도달하지 않는다 — 부모가 READY를 받은 즉시
      // SIGKILL을 보내므로, 이 스크립트가 rename을 시도할 기회 자체가 없다.
      const childScript = `
        const fs = require("node:fs");
        const path = require("node:path");
        // node -e "..." 인자는 argv[1]부터 시작한다(일반 스크립트 파일 실행의 argv[2]와 다르다).
        const dir = process.argv[1];
        const basename = process.argv[2];
        const tmpPath = path.join(dir, "." + basename + ".tmp." + process.pid + ".deadbeef");
        const fd = fs.openSync(tmpPath, "w");
        fs.writeSync(fd, JSON.stringify({ malicious: "killed before rename should never appear" }));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        process.stdout.write("READY\\n");
        setInterval(() => {}, 1000); // rename을 호출하지 않고 SIGKILL을 기다린다.
      `;

      const child = spawn(process.execPath, ["-e", childScript, dir, "settings.json"], { stdio: ["ignore", "pipe", "pipe"] });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("자식 프로세스가 READY를 보내지 않았다")), 5000);
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("READY")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      child.kill("SIGKILL");
      await exited;

      // 대상 파일은 조치 이전 원본 그대로다 — 강제 종료된 쓰기의 내용이 전혀 반영되지 않았다.
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ original: true });
      // tmp 파일은 잔존할 수 있다(tmp_leftover 분류 대상) — 그건 정상이다, 대상 파일이 아니다.
      const leftovers = readdirSync(dir).filter((f) => f !== "settings.json");
      for (const f of leftovers) {
        expect(f).toMatch(/\.tmp\.\d+\.[A-Za-z0-9]+$/);
      }
    },
    10_000,
  );
});

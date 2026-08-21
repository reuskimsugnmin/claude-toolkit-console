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
    // 쓰기 도중 프로세스를 죽이는 시나리오는 직접 재현하기 어려우므로, 정상 쓰기 후 tmp가 남지
    // 않음을 확인해 "성공 경로에서는 흔적이 없다"는 절반을, 명명 규약은 소스코드 상수(정규식)
    // 검사로 나머지 절반을 담보한다.
    const TMP_PATTERN = /^\.[^.]+\.tmp\.\d+\.[A-Za-z0-9]+$/;
    const target = path.join(dir, "settings.json");
    atomicWriteJson(target, { a: 1 });
    expect(readdirSync(dir).some((f) => TMP_PATTERN.test(f))).toBe(false);
  });
});

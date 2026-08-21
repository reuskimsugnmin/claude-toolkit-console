import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { managedPolicyCandidatePaths, readManagedPolicies } from "../src/managed-policy.js";

describe("probe/managed-policy — iter 8 · M1 (I/O 읽기 전용)", () => {
  it("darwin/linux/win32 각각 하나씩 OS별 고정 경로를 반환한다", () => {
    expect(managedPolicyCandidatePaths("darwin")).toHaveLength(1);
    expect(managedPolicyCandidatePaths("linux")).toHaveLength(1);
    expect(managedPolicyCandidatePaths("win32")).toHaveLength(1);
    expect(managedPolicyCandidatePaths("darwin")[0]?.path).toContain("ClaudeCode/managed-settings.json");
  });

  it("알 수 없는 플랫폼은 빈 배열이다(가드 약화가 아니라 정보 부재를 정직하게 반영)", () => {
    expect(managedPolicyCandidatePaths("aix")).toEqual([]);
  });

  it("후보 경로가 하나도 존재하지 않으면 빈 policies를 반환한다(이 머신의 정상 상태 — R15)", () => {
    const result = readManagedPolicies([{ path: "/nonexistent/path/managed-settings.json", platform: "darwin" }]);
    expect(result.policies).toEqual([]);
    expect(result.parseFailures).toEqual([]);
  });

  it("존재하는 파일을 파싱해 policies 배열에 담는다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-managed-policy-"));
    try {
      const file = path.join(dir, "managed-settings.json");
      writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [] } }));
      const result = readManagedPolicies([{ path: file, platform: "darwin" }]);
      expect(result.policies).toEqual([{ hooks: { PreToolUse: [] } }]);
      expect(result.parseFailures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("파싱이 깨진 파일은 policies에 넣지 않고 parseFailures에 경로만 남긴다(원문 없음)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-managed-policy-broken-"));
    try {
      const file = path.join(dir, "managed-settings.json");
      writeFileSync(file, "{ not valid json");
      const result = readManagedPolicies([{ path: file, platform: "darwin" }]);
      expect(result.policies).toEqual([]);
      expect(result.parseFailures).toEqual([file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("여러 후보 중 존재하는 것만 읽는다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-managed-policy-multi-"));
    try {
      const present = path.join(dir, "present.json");
      writeFileSync(present, JSON.stringify({ env: {} }));
      const result = readManagedPolicies([
        { path: path.join(dir, "missing.json"), platform: "darwin" },
        { path: present, platform: "darwin" },
      ]);
      expect(result.policies).toEqual([{ env: {} }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("디렉터리를 경로로 주면 파싱 실패로 처리한다(존재하지만 읽을 수 없음)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ctk-managed-policy-dir-"));
    try {
      const asDir = path.join(dir, "managed-settings.json");
      mkdirSync(asDir);
      const result = readManagedPolicies([{ path: asDir, platform: "darwin" }]);
      expect(result.policies).toEqual([]);
      expect(result.parseFailures).toEqual([asDir]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

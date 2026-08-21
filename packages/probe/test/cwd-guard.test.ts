import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoAncestorConfig, resolveFixedCwd, SealCwdAncestorConfigError } from "../src/harness/cwd-guard.js";

describe("probe/harness/cwd-guard — iter 8 · B3(고정 cwd)·M2(상위 경로 검사)", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("resolveFixedCwd는 homeDir 기준 상대 경로를 조인만 한다(I/O 없음)", () => {
    expect(resolveFixedCwd(".cache/ctk/sealed-cwd", "/home/x")).toBe("/home/x/.cache/ctk/sealed-cwd");
  });

  it("상위 경로에 CLAUDE.md/.claude가 없으면 통과한다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-cwd-guard-clean-"));
    const cwd = path.join(root, "sub", "cwd");
    mkdirSync(cwd, { recursive: true });
    expect(() => assertNoAncestorConfig(cwd)).not.toThrow();
  });

  it("직계 상위에 CLAUDE.md가 있으면 거부한다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-cwd-guard-md-"));
    writeFileSync(path.join(root, "CLAUDE.md"), "# x\n");
    const cwd = path.join(root, "cwd");
    mkdirSync(cwd, { recursive: true });
    expect(() => assertNoAncestorConfig(cwd)).toThrow(SealCwdAncestorConfigError);
  });

  it("더 위쪽 조상에 .claude/ 디렉터리가 있어도 거부한다(직계 상위가 아니어도 검사한다)", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-cwd-guard-dotclaude-"));
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    const cwd = path.join(root, "a", "b", "cwd");
    mkdirSync(cwd, { recursive: true });
    expect(() => assertNoAncestorConfig(cwd)).toThrow(SealCwdAncestorConfigError);
  });

  it("cwd 자기 자신 안에 .claude/나 CLAUDE.md가 있어도 위반이 아니다(검사는 상위부터 시작한다)", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-cwd-guard-self-"));
    const cwd = path.join(root, "cwd");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    writeFileSync(path.join(cwd, "CLAUDE.md"), "# ctk가 여기 둔 것은 정상\n");
    expect(() => assertNoAncestorConfig(cwd)).not.toThrow();
  });

  it("에러는 어느 상위 경로가 문제였는지를 담는다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-cwd-guard-detail-"));
    writeFileSync(path.join(root, "CLAUDE.md"), "# x\n");
    const cwd = path.join(root, "cwd");
    mkdirSync(cwd, { recursive: true });
    try {
      assertNoAncestorConfig(cwd);
      expect.unreachable("여기 도달하면 안 된다");
    } catch (err) {
      expect(err).toBeInstanceOf(SealCwdAncestorConfigError);
      expect((err as SealCwdAncestorConfigError).offendingPath).toBe(path.join(root, "CLAUDE.md"));
    }
  });
});

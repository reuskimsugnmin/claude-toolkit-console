import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoAncestorConfig,
  resolveAgentProbeCwd,
  resolveFixedCwd,
  SealCwdAncestorConfigError,
} from "../src/harness/cwd-guard.js";

describe("probe/harness/cwd-guard — iter 8 · B3(고정 cwd)·M2(상위 경로 검사)", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("resolveFixedCwd는 homeDir 기준 상대 경로를 조인만 한다(I/O 없음)", () => {
    expect(resolveFixedCwd(".cache/ctk/sealed-cwd", "/synthetic/home")).toBe("/synthetic/home/.cache/ctk/sealed-cwd");
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

  // ── 회귀: agent-probe의 **실제 기본 cwd**를 대상으로 검사한다 ────────────────────────────
  //
  // 위 케이스들은 전부 합성 임시 루트를 만들어 넣는다. 그래서 "기본 cwd가 홈 아래라
  // $HOME/.claude에 항상 걸린다"는 결함을 하나도 잡지 못했다 — 프로덕션 값이 한 번도 검사
  // 대상이 아니었기 때문이다(CLAUDE.md: 테스트가 프로덕션 분기를 타는지 확인한다).

  it("기본 agent-probe cwd는 홈 밖이다 — 홈 아래면 $HOME/.claude에 항상 걸려 실행 자체가 불가능해진다", () => {
    const cwd = resolveAgentProbeCwd();
    expect(cwd.startsWith(homedir() + path.sep)).toBe(false);
  });

  it("기본 agent-probe cwd는 이 환경에서 실제로 가드를 통과한다", () => {
    // $HOME/.claude가 존재하는 상태(모든 Claude Code 사용자의 상태)에서 도는 것이 핵심이다.
    expect(existsSync(path.join(homedir(), ".claude"))).toBe(true);
    expect(() => assertNoAncestorConfig(resolveAgentProbeCwd())).not.toThrow();
  });

  it("홈 아래 경로를 주면 여전히 거부된다 — 위 두 케이스가 가드를 약화시켜 통과한 것이 아님을 보인다", () => {
    expect(() => assertNoAncestorConfig(path.join(homedir(), ".cache", "ctk", "probe-cwd"))).toThrow(
      SealCwdAncestorConfigError,
    );
  });

  it("cwd 경로는 실행마다 같다 — B3(고정 경로)의 목적은 그대로 지켜진다", () => {
    expect(resolveAgentProbeCwd()).toBe(resolveAgentProbeCwd());
  });

  it("uid로 구분해 다중 사용자 머신에서 남의 디렉터리를 재사용하지 않는다", () => {
    expect(resolveAgentProbeCwd("/synthetic/tmp", 501)).toBe("/synthetic/tmp/ctk-agent-probe-cwd-501");
    expect(resolveAgentProbeCwd("/synthetic/tmp", 502)).not.toBe(resolveAgentProbeCwd("/synthetic/tmp", 501));
  });

  it("거부 메시지는 왜 막혔는지와 어떻게 푸는지를 함께 담는다(안전 원칙 6)", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-cwd-guard-remedy-"));
    writeFileSync(path.join(root, "CLAUDE.md"), "# x\n");
    const cwd = path.join(root, "cwd");
    mkdirSync(cwd, { recursive: true });
    try {
      assertNoAncestorConfig(cwd);
      expect.unreachable("여기 도달하면 안 된다");
    } catch (err) {
      expect((err as Error).message).toContain("해결:");
    }
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

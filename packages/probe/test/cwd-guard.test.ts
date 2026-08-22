import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("기본 agent-probe cwd는 실제 반환값 그대로 가드를 통과한다", () => {
    // 합성 경로가 아니라 프로덕션이 실제로 쓰는 값을 넣는다. 어떤 머신에서도 통과해야 한다 —
    // 통과하지 못하면 그 머신에서는 `ctk agent-probe`를 실행할 수 없다는 뜻이다.
    expect(() => assertNoAncestorConfig(resolveAgentProbeCwd())).not.toThrow();
  });

  it("홈 아래 고정 cwd(이전 설계)는 홈에 .claude/가 있으면 거부된다 — 위 케이스가 가드를 약화시켜 통과한 것이 아님을 보인다", () => {
    // `$HOME/.claude` 존재 여부는 머신마다 다르므로(CI 러너에는 없다) 그 조건을 합성해서 만든다.
    // 이 대조가 없으면 위 케이스는 "가드가 아무것도 안 한다"와 구분되지 않는다.
    root = mkdtempSync(path.join(tmpdir(), "ctk-cwd-guard-oldshape-"));
    const fakeHome = path.join(root, "home");
    mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
    const oldStyleCwd = path.join(fakeHome, ".cache", "ctk", "probe-cwd");
    mkdirSync(oldStyleCwd, { recursive: true });
    expect(() => assertNoAncestorConfig(oldStyleCwd)).toThrow(SealCwdAncestorConfigError);

    // 같은 트리에서 홈 **밖**(임시 루트 아래)의 새 설계 경로는 통과한다 — 차이를 만드는 것이
    // 가드의 완화가 아니라 cwd 위치임을 보인다.
    const newStyleCwd = resolveAgentProbeCwd(root, 1);
    mkdirSync(newStyleCwd, { recursive: true });
    expect(() => assertNoAncestorConfig(newStyleCwd)).not.toThrow();
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

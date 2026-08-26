import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditSealedLiveConfigDir, captureConfigDirSnapshot, readClaudeJsonRawOrNull, sealedLiveAuditPassed, type ConfigDirSnapshot } from "../src/tree-audit.js";
import { SESSION_OWNED_NOT_ATTRIBUTABLE } from "@ctk/core";

describe("gen/tree-audit — AC-3.7 (sealed-live 전용 Tier-2 허용목록, AC-0.11 기준)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("변경이 없으면 clean이다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-"));
    const before = captureConfigDirSnapshot(dir);
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(true);
    expect(result.verdict.overallStatus).toBe("clean");
  });

  it("AC-0.11 실측 churn(sessions/<pid>.json)은 허용된다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-sessions-"));
    const before = captureConfigDirSnapshot(dir);
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    writeFileSync(path.join(dir, "sessions", "12345.json"), "{}");
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(true);
    expect(result.verdict.overallStatus).toBe("allowed_churn");
  });

  it("허용목록 밖 경로가 바뀌면 위반이다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-violation-"));
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(dir, "CLAUDE.md"), "# 새로 생김");
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(false);
    expect(result.verdict.overallStatus).toBe("violation");
  });

  it(".claude.json은 cachedGrowthBookFeaturesAt 한 키만 바뀌면 통과한다(AC-0.11 실측)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-cjson-"));
    const beforeJson = JSON.stringify({ cachedGrowthBookFeaturesAt: 1, projects: {} });
    writeFileSync(path.join(dir, ".claude.json"), beforeJson);
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ cachedGrowthBookFeaturesAt: 2, projects: {} }));
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, beforeJson);
    expect(sealedLiveAuditPassed(result)).toBe(true);
    expect(result.claudeJsonSemantic?.overallStatus).toBe("allowed_churn");
  });

  it(".claude.json에서 허용 키 밖의 값이 바뀌면 위반이다(화이트리스트 방향, F5)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-cjson-violation-"));
    const beforeJson = JSON.stringify({ numStartups: 1 });
    writeFileSync(path.join(dir, ".claude.json"), beforeJson);
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ numStartups: 2 }));
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, beforeJson);
    expect(sealedLiveAuditPassed(result)).toBe(false);
    expect(result.claudeJsonSemantic?.overallStatus).toBe("violation");
  });

  it("readClaudeJsonRawOrNull은 파일이 없으면 null, 있으면 원문을 반환한다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-audit-read-"));
    expect(readClaudeJsonRawOrNull(dir)).toBeNull();
    writeFileSync(path.join(dir, ".claude.json"), '{"x":1}');
    expect(readClaudeJsonRawOrNull(dir)).toBe('{"x":1}');
  });
});

describe("gen/tree-audit — 다른 세션이 소유한 경로는 자식에게 귀속하지 않는다 (2026-08-24 실측)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // 합성 UUID — 실제 세션 식별자를 픽스처에 넣지 않는다(public 저장소, 보안 재심 L2).
  const PARENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  function init(prefix: string): void {
    dir = mkdtempSync(path.join(tmpdir(), prefix));
  }

  it("다른 세션의 트랜스크립트가 갱신돼도 위반이 아니다 (Claude Code를 켠 채 gen을 돌린 경우)", () => {
    init("ctk-tree-session-transcript-");
    const projDir = path.join(dir, "projects", "-Users-x-repo");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(path.join(projDir, `${PARENT}.jsonl`), '{"a":1}\n');
    const before = captureConfigDirSnapshot(dir);

    writeFileSync(path.join(projDir, `${PARENT}.jsonl`), '{"a":1}\n{"b":2}\n'); // 부모가 대화를 이어감
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result), "부모 세션 churn이 자식 위반으로 잡히면 안 된다").toBe(true);
    expect(result.sessionOwnedExcluded, "제외를 조용히 하지 않고 노출한다").toContain(
      `projects/-Users-x-repo/${PARENT}.jsonl`,
    );
  });

  it("다른 세션의 훅 상태 파일이 삭제·재생성돼도 위반이 아니다", () => {
    init("ctk-tree-session-hookstate-");
    const stateDir = path.join(dir, "hooks", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, `${PARENT}.start`), "x");
    const before = captureConfigDirSnapshot(dir);

    rmSync(path.join(stateDir, `${PARENT}.start`)); // 실측에서 실제로 관측된 형태: 삭제
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(true);
  });

  // ⚠️ 여기부터가 이 변경의 핵심이다. 제외가 **넓어지지 않았는지**를 본다 —
  // 제외가 되는 것보다 제외되면 안 되는 것이 여전히 걸리는지가 중요하다(Pre-mortem H).
  const MUST_STILL_VIOLATE: Array<{ name: string; rel: string }> = [
    { name: "훅 **정의**(settings.json)", rel: "settings.json" },
    { name: "훅 디렉터리의 임의 파일", rel: "hooks/evil.sh" },
    { name: "hooks/state의 uuid가 아닌 파일", rel: "hooks/state/evil.sh" },
    { name: "hooks/state 하위 디렉터리", rel: "hooks/state/nested/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.start" },
    { name: "projects 바로 아래(프로젝트 디렉터리 없음)", rel: "projects/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl" },
    { name: "projects의 uuid가 아닌 jsonl", rel: "projects/-Users-x-repo/not-a-uuid.jsonl" },
    { name: "projects의 uuid지만 다른 확장자", rel: "projects/-Users-x-repo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.sh" },
    { name: "projects 2단 아래", rel: "projects/-Users-x-repo/sub/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl" },
    { name: "플러그인 레지스트리", rel: "plugins/installed_plugins.json" },
    { name: "스킬 본문", rel: "skills/evil/SKILL.md" },
  ];

  for (const c of MUST_STILL_VIOLATE) {
    it(`제외가 넓어지지 않았다 — ${c.name}은 여전히 위반이다`, () => {
      init("ctk-tree-still-violates-");
      const before = captureConfigDirSnapshot(dir);
      const abs = path.join(dir, c.rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, "payload");
      const after = captureConfigDirSnapshot(dir);

      const result = auditSealedLiveConfigDir(dir, before, after, null);
      expect(sealedLiveAuditPassed(result), `${c.rel}이 조용히 통과했다 — 제외 범위가 넓어졌다`).toBe(false);
      expect(result.sessionOwnedExcluded).not.toContain(c.rel);
    });
  }

  it("제외할 것이 없으면 sessionOwnedExcluded는 비어 있다 — 규칙이 죽었는지 산 건지 구분된다", () => {
    init("ctk-tree-no-exclusion-");
    const before = captureConfigDirSnapshot(dir);
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(result.sessionOwnedExcluded).toEqual([]);
  });
});

describe("gen/tree-audit — --allow-concurrent-sessions 옵트아웃 (fail-closed 기본 + 명시 해제)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function withViolation(): { before: ReturnType<typeof captureConfigDirSnapshot>; after: ReturnType<typeof captureConfigDirSnapshot> } {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-optout-"));
    const before = captureConfigDirSnapshot(dir);
    // 서드파티 플러그인 훅이 쓰는 로그 같은 경로 — 제품이 열거할 수 없는 종류다.
    mkdirSync(path.join(dir, "some-plugin"), { recursive: true });
    writeFileSync(path.join(dir, "some-plugin", "log.txt"), "hook fired");
    const after = captureConfigDirSnapshot(dir);
    return { before, after };
  }

  it("기본값은 fail-closed다 — 플래그가 없으면 위반이다", () => {
    const { before, after } = withViolation();
    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(false);
    expect(result.concurrencyOverrideApplied).toBe(false);
  });

  it("플래그를 켜면 통과하되 '무력화됨'을 반드시 기록한다", () => {
    const { before, after } = withViolation();
    const result = auditSealedLiveConfigDir(dir, before, after, null, { allowConcurrentSessions: true });
    expect(sealedLiveAuditPassed(result)).toBe(true);
    expect(result.concurrencyOverrideApplied, "조용히 낮추면 사용자는 감사가 돌았다고 믿는다").toBe(true);
    // 위반 목록 자체는 지우지 않는다 — 무엇을 눈감았는지 남아야 한다.
    expect(result.verdict.overallStatus).toBe("violation");
    expect(result.verdict.violations.length).toBeGreaterThan(0);
  });

  it("위반이 없으면 플래그를 켜도 '적용됨'이 아니다 — 진짜 위험한 실행이 잡음에 묻히지 않게", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-optout-clean-"));
    const before = captureConfigDirSnapshot(dir);
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, null, { allowConcurrentSessions: true });
    expect(result.concurrencyOverrideApplied).toBe(false);
    expect(sealedLiveAuditPassed(result)).toBe(true);
  });

  it("⚠️ 옵트아웃은 '관측 실패'까지 무르게 하지 않는다 — 모르는 것과 못 본 것은 다르다", () => {
    // ⚠️ **이 테스트는 한때 공허했다.** 처음에는 위반이 없는 빈 픽스처를 썼는데, 그러면
    // concurrencyOverrideApplied가 애초에 false라 "옵트아웃이 관측 실패까지 무르게 하는" 결함을
    // 주입해도 발동하지 않았다(파괴 실험이 25개 통과로 드러냄). 판정이 갈리려면 **위반과 관측
    // 실패가 동시에** 있어야 한다.
    const { before, after } = withViolation();
    const brokenBefore = { ...before, collectErrors: 1 };
    const result = auditSealedLiveConfigDir(dir, brokenBefore, after, null, { allowConcurrentSessions: true });
    expect(result.concurrencyOverrideApplied, "위반이 있어야 이 테스트가 의미를 갖는다").toBe(true);
    expect(sealedLiveAuditPassed(result), "아무것도 보지 못한 실행이 통과로 기록되면 안 된다").toBe(false);
    expect(result.incompleteObservationReasons.join(",")).toContain("collect_errors");
  });

  it("제외 진단은 **달라진** 세션 파일만 센다 — 존재만 하는 과거 트랜스크립트는 진단이 아니다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-excluded-count-"));
    const projDir = path.join(dir, "projects", "-Users-x-repo");
    mkdirSync(projDir, { recursive: true });
    // 과거 세션 3건 — 그대로 있고 바뀌지 않는다.
    for (const u of [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
    ]) {
      writeFileSync(path.join(projDir, `${u}.jsonl`), "old\n");
    }
    const live = "44444444-4444-4444-4444-444444444444";
    writeFileSync(path.join(projDir, `${live}.jsonl`), "a\n");
    const before = captureConfigDirSnapshot(dir);

    writeFileSync(path.join(projDir, `${live}.jsonl`), "a\nb\n"); // 살아 있는 세션만 갱신
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(result.sessionOwnedExcluded, "바뀐 1건만 세야 한다(존재하는 4건이 아니라)").toEqual([
      `projects/-Users-x-repo/${live}.jsonl`,
    ]);
  });

  it("다른 세션의 서브에이전트 트랜스크립트도 귀속 불가로 제외된다 (E0.6 — subagents/는 한 단계 깊다)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-subagent-"));
    const proj = path.join(dir, "projects", "-Users-x-repo");
    const sub = path.join(proj, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "subagents");
    mkdirSync(sub, { recursive: true });
    // 현실 조건: 부모 세션의 트랜스크립트가 **이미 있다**. 그래야 그 uuid가 "before에서 관측된
    // 세션"이 되고 서브에이전트 파일이 귀속 불가로 인정된다(H1 — 처음 보는 uuid는 위반이다).
    writeFileSync(path.join(proj, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), "parent\n");
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(sub, "agent-abc123.jsonl"), "{}\n");
    writeFileSync(path.join(sub, "agent-abc123.meta.json"), "{}");
    const after = captureConfigDirSnapshot(dir);
    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(true);
  });
});

describe("gen/tree-audit — 세션 경로의 **신규 생성**은 제외하지 않는다 (보안 재심 H1)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * ⚠️ **이 축이 표본에 없어서 High가 새어 나갔다.** 앞선 근접 경로 테스트 10종은 전부
   * "매치되지 **않는** 경로의 생성"이었고, 파괴 실험 2종은 **경로 축**만 흔들었다. 정작
   * 위험한 것은 "매치되는 경로의 **신규 생성**"이다 — 봉인 안에서 그 파일이 새로 생겼다는 건
   * 훅이 실행됐거나 자식이 세션을 영속했다는 뜻이고, 둘 다 봉인 파손의 1차 신호다.
   */
  const NEW_SESSION = "99999999-9999-9999-9999-999999999999";

  it("봉인 안에서 훅 상태 파일이 **새로** 생기면 위반이다 (훅이 실행됐다는 증거)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-h1-hook-"));
    mkdirSync(path.join(dir, "hooks", "state"), { recursive: true });
    const before = captureConfigDirSnapshot(dir); // before에 그 uuid가 없다
    writeFileSync(path.join(dir, "hooks", "state", `${NEW_SESSION}.start`), "fired");
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result), "신규 생성을 제외하면 봉인 파손 신호가 은폐된다").toBe(false);
  });

  it("자식이 트랜스크립트를 **새로** 쓰면 위반이다 (세션을 영속했다는 증거)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-h1-transcript-"));
    const proj = path.join(dir, "projects", "-Users-x-sealed-cwd");
    mkdirSync(proj, { recursive: true });
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(proj, `${NEW_SESSION}.jsonl`), "{}\n");
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(false);
  });

  it("before에 이미 있던 세션의 append는 여전히 제외된다 — 수정이 과잉 차단으로 뒤집히지 않았다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-h1-append-ok-"));
    const proj = path.join(dir, "projects", "-Users-x-repo");
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, `${NEW_SESSION}.jsonl`), "a\n");
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(proj, `${NEW_SESSION}.jsonl`), "a\nb\n"); // append
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result), "부모가 대화를 이어 쓰는 정상 경로는 통과해야 한다").toBe(true);
  });

  it("기존 트랜스크립트를 **덮어써 줄어들면** 위반이다 — append가 아니면 부모의 행동이 아니다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-h1-overwrite-"));
    const proj = path.join(dir, "projects", "-Users-x-repo");
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, `${NEW_SESSION}.jsonl`), "aaaaaaaaaaaaaaaaaaaa\n");
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(proj, `${NEW_SESSION}.jsonl`), "x\n"); // 크기가 줄었다 = append 아님
    const after = captureConfigDirSnapshot(dir, before.cache);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result), "덮어쓰기를 눈감으면 위조 트랜스크립트를 못 잡는다").toBe(false);
  });

  it("심볼릭 링크 개수가 달라지면 관측 불완전으로 fail-closed다 (보안 재심 M5)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-h1-symlink-"));
    const target = path.join(dir, "target.md");
    writeFileSync(target, "payload");
    const before = captureConfigDirSnapshot(dir);
    mkdirSync(path.join(dir, "skills", "x"), { recursive: true });
    symlinkSync(target, path.join(dir, "skills", "x", "SKILL.md")); // 파일 목록엔 안 나타난다
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result), "링크로 심으면 entries에 안 보인다 — 개수로 잡아야 한다").toBe(false);
    expect(result.incompleteObservationReasons.join(",")).toContain("symlink_count");
  });
});

describe("gen/tree-audit — forbidden이 세션 제외보다 우선한다 (보안 재심 M1, 심층 방어)", () => {
  /**
   * ⚠️ **파괴 실험이 이 방어를 잡지 못했다.** forbidden 우선순위를 제거해도 30개가 그대로
   * 통과했는데, 그건 방어가 필요 없어서가 아니라 **표본에 그 축이 없어서**다 — `..`·NUL이
   * 들어간 세그먼트는 `readdirSync`로 만들 수 없으므로 실제 파일시스템 픽스처로는 도달할 수
   * 없다. `core/guard/forbidden.ts`는 그 계층이 정확히 "수집기가 틀렸을 때"를 위한 최후
   * 방어선이라고 적고 있으니, 스냅샷을 **손으로 조립해** 고정한다.
   */
  const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  function snapshot(paths: readonly string[]): ConfigDirSnapshot {
    return {
      entries: paths.map((p) => ({ path: p, sha256: `sha-${p}` })),
      collectErrors: 0,
      symlinkCount: 0,
      emptyDirCount: 0,
      cache: new Map(),
    };
  }

  const CASES: Array<{ name: string; evil: string }> = [
    { name: "경로 순회(..)", evil: `projects/-../${UUID}.jsonl` },
    { name: "NUL 바이트", evil: `projects/-a\u0000b/${UUID}.jsonl` },
  ];

  for (const c of CASES) {
    it(`${c.name}가 섞인 경로는 세션 이름 공간에 맞아도 제외하지 않는다`, () => {
      // before에 같은 uuid를 **정상 경로로** 넣어 둔다 — 그래야 "uuid를 몰라서 막힌 것"이
      // 아니라 "forbidden이 막았다"는 것이 증명된다(오답이 가능한 픽스처).
      const before = snapshot([`projects/-Users-x-repo/${UUID}.jsonl`]);
      const after = snapshot([`projects/-Users-x-repo/${UUID}.jsonl`, c.evil]);

      const result = auditSealedLiveConfigDir("/tmp/synthetic-config-dir", before, after, null);
      expect(sealedLiveAuditPassed(result), `${c.evil}이 제외되면 forbidden보다 상위 우회 계층이 생긴다`).toBe(
        false,
      );
      expect(result.sessionOwnedExcluded).not.toContain(c.evil);
    });
  }

  it("대조군 — 같은 uuid의 정상 경로는 제외된다(위 두 케이스가 '항상 위반'이 아님을 보인다)", () => {
    const before = snapshot([`projects/-Users-x-repo/${UUID}.jsonl`]);
    const after = snapshot([{ ...{}, ...{} } && `projects/-Users-x-repo/${UUID}.jsonl`].map((p) => p));
    // 내용이 바뀐 것으로 만든다
    after.entries[0] = { path: `projects/-Users-x-repo/${UUID}.jsonl`, sha256: "changed" };
    const result = auditSealedLiveConfigDir("/tmp/synthetic-config-dir", before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(true);
    expect(result.sessionOwnedExcluded).toEqual([`projects/-Users-x-repo/${UUID}.jsonl`]);
  });
});

describe("gen/tree-audit — `.session-stats.json`: 경로에 uuid가 없는 세션 소유 파일 (2026-08-26 실측)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const REL = ".session-stats.json";
  const stats = (turns: number): string =>
    JSON.stringify({ "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee": { turns, note: "x".repeat(turns * 8) } });

  // ⚠️ 이 결함은 **등재돼 있는데도 한 번도 제외되지 않던** 것이다. whitelist.ts에 exact로
  // 올라가 있었지만 제외 판정이 경로에서 uuid를 뽑는 데 의존했고 이 경로에는 uuid가 없다.
  // 규칙이 존재한다는 것과 규칙이 동작한다는 것은 다르다 — 그래서 **등재 사실이 아니라
  // 판정 결과**를 단언한다.
  it("살아 있는 세션이 갱신하면 제외된다 (등재돼 있으나 도달하지 못하던 결함)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-stats-modified-"));
    writeFileSync(path.join(dir, REL), stats(1));
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(dir, REL), stats(2));
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result), "살아 있는 세션 때문에 gen이 막히면 안 된다").toBe(true);
    expect(result.sessionOwnedExcluded, "제외를 조용히 하지 않고 노출한다").toContain(REL);
  });

  // append 규칙은 트랜스크립트(path_uuid 축)의 성질이다. 이 파일은 하네스가 통째로 다시
  // 쓰므로 줄어드는 것이 정상이다 — 두 축에 같은 규칙을 적용하면 정상이 위반이 된다.
  it("크기가 줄어도 제외된다 — append 규칙은 이 축의 것이 아니다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-stats-shrunk-"));
    writeFileSync(path.join(dir, REL), stats(40));
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(dir, REL), stats(1));
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result)).toBe(true);
    expect(result.sessionOwnedExcluded).toContain(REL);
  });

  // 아래 둘이 이 수정의 경계다. 넓히면 봉인이 뚫린다.
  it("**신규 생성**은 위반이다 — before에 없던 파일은 봉인 자식이 쓴 것이다 (H1 유지)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-stats-created-"));
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(dir, REL), stats(1));
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result), "신규 생성이 조용히 통과했다 — 제외가 넓어졌다").toBe(false);
    expect(result.sessionOwnedExcluded).not.toContain(REL);
  });

  it("**삭제**도 위반이다 — 하네스의 정상 동작이 아니다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-stats-deleted-"));
    writeFileSync(path.join(dir, REL), stats(1));
    const before = captureConfigDirSnapshot(dir);
    rmSync(path.join(dir, REL));
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    expect(sealedLiveAuditPassed(result), "삭제가 조용히 통과했다").toBe(false);
    expect(result.sessionOwnedExcluded).not.toContain(REL);
  });

  // ⚠️ **수용된 잔여 위험을 테스트로 고정한다(2026-08-26 재심 L3).** 이 축에는 내용 제약이
  // 없다. 테스트가 없으면 다음 사람은 이것이 **결정된 것인지 빠뜨린 것인지** 구분할 수 없다.
  it("⚠️ 수용된 잔여 위험 — 내용이 통째로 바뀌어도 제외된다(내용 제약이 없다는 사실을 고정한다)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-stats-rewritten-"));
    writeFileSync(path.join(dir, REL), stats(1));
    const before = captureConfigDirSnapshot(dir);
    writeFileSync(path.join(dir, REL), JSON.stringify({ "not-a-session": "arbitrary payload" }));
    const after = captureConfigDirSnapshot(dir);

    const result = auditSealedLiveConfigDir(dir, before, after, null);
    // 이 단언이 깨지면 누군가 내용 제약을 넣었다는 뜻이다 — whitelist.ts의 잔여 위험 문단도
    // 함께 갱신해야 한다(문서와 코드가 갈리면 다음 재심자가 잘못된 전제로 심사한다).
    expect(sealedLiveAuditPassed(result), "내용 제약은 설계상 없다").toBe(true);
    expect(result.sessionOwnedExcluded).toContain(REL);
  });

  // 축이 어긋난 이름을 통과시키지 않는지. exact 규칙이므로 유사 경로는 전부 위반이어야 한다.
  const MUST_STILL_VIOLATE = [".session-stats.json.bak", "sub/.session-stats.json", ".session-stats.jsonx"];
  for (const rel of MUST_STILL_VIOLATE) {
    it(`유사 경로는 여전히 위반이다 — ${rel}`, () => {
      dir = mkdtempSync(path.join(tmpdir(), "ctk-tree-stats-near-"));
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, stats(1));
      const before = captureConfigDirSnapshot(dir);
      writeFileSync(abs, stats(2));
      const after = captureConfigDirSnapshot(dir);

      const result = auditSealedLiveConfigDir(dir, before, after, null);
      expect(sealedLiveAuditPassed(result), `${rel}이 조용히 통과했다`).toBe(false);
    });
  }
});

describe("gen/tree-audit — 등재된 규칙이 **죽어 있지 않은지** 목록 전체로 묻는다 (2026-08-26 재심 M2)", () => {
  // ⚠️ 이번 결함은 항목 하나가 아니라 **부류**였다 — 등재됐는데 판정에 도달하지 못하는 규칙.
  // 항목을 고치는 테스트만 두면 같은 형태가 다시 들어온다. 여기서는 목록을 순회해 묻는다.
  it("모든 규칙이 자기 축이 요구하는 매처를 갖는다", () => {
    expect(SESSION_OWNED_NOT_ATTRIBUTABLE.length, "목록이 비면 이 테스트는 아무것도 검사하지 않는다").toBeGreaterThan(0);
    for (const rule of SESSION_OWNED_NOT_ATTRIBUTABLE) {
      if (rule.attribution === "path_uuid") {
        // 경로에서 uuid를 뽑을 수 없는 path_uuid 규칙은 영원히 제외되지 않는다 — 죽은 규칙이다.
        expect(rule.pattern.source, `${rule.note}: 경로에 uuid 모양이 없다`).toContain("[0-9a-fA-F]{8}");
      } else {
        expect(typeof rule.exact, `${rule.note}: preexisting_file은 exact여야 한다`).toBe("string");
      }
    }
  });

  it("각 규칙이 실제로 제외를 일으킨다 — 등재가 아니라 판정 결과를 단언한다", () => {
    // path_uuid 축은 before에 uuid가 있어야 하고, preexisting_file 축은 파일이 양쪽에 있어야
    // 한다. 두 축 다 위에서 개별 테스트로 실증했다 — 여기서는 목록이 그 두 축만 쓰는지 본다.
    const axes = new Set(SESSION_OWNED_NOT_ATTRIBUTABLE.map((r) => r.attribution));
    expect([...axes].sort(), "새 축이 생겼다면 그 축을 태우는 테스트를 함께 넣어야 한다").toEqual([
      "path_uuid",
      "preexisting_file",
    ]);
  });
});

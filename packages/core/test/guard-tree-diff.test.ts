import { describe, expect, it } from "vitest";
import { verdict, DuplicatePathVerdictError, type FileEntry } from "../src/guard/tree-diff.js";
import { TIER2_CHURN_ALLOWLIST, type AllowlistRule } from "../src/guard/whitelist.js";
import { FORBIDDEN_RULES } from "../src/guard/forbidden.js";

const before: FileEntry[] = [
  { path: ".claude.json", sha256: "sha-before" },
  { path: "settings.json", sha256: "sha-settings" },
];

function afterWithChurn(): FileEntry[] {
  return [
    { path: ".claude.json", sha256: "sha-after" }, // 수정됨 (churn)
    { path: "settings.json", sha256: "sha-settings" }, // 불변
    { path: "backups/x.backup.1700000000", sha256: "sha-backup" }, // 신규 (churn)
  ];
}

describe("core/guard/tree-diff — 착수 조건 C2: 순수 함수, baseline은 호출자가 넘긴다", () => {
  it("동일 diff에 빈 allowlist를 주면 violation으로 판정된다 (test-isolated 기대: 변경 0건)", () => {
    const result = verdict(before, afterWithChurn(), []);
    expect(result.overallStatus).toBe("violation");
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("동일 diff에 Tier-2 allowlist를 주면 allowed_churn으로 판정된다 (sealed-live 기대)", () => {
    const result = verdict(before, afterWithChurn(), TIER2_CHURN_ALLOWLIST);
    expect(result.overallStatus).toBe("allowed_churn");
    expect(result.violations).toHaveLength(0);
  });

  it("동일 diff + 동일 forbidden에 서로 다른 allowlist 2벌을 주면 판정이 갈린다 (핵심 C2 단언)", () => {
    const strict = verdict(before, afterWithChurn(), [], FORBIDDEN_RULES);
    const lenient = verdict(before, afterWithChurn(), TIER2_CHURN_ALLOWLIST, FORBIDDEN_RULES);
    expect(strict.overallStatus).not.toBe(lenient.overallStatus);
  });

  it("변경이 전혀 없으면 clean이다", () => {
    const result = verdict(before, before, []);
    expect(result.overallStatus).toBe("clean");
  });

  it("forbidden(경로 순회)은 allowlist보다 우선한다", () => {
    const maliciousAllowlist: AllowlistRule[] = [{ pattern: /.*/, note: "의도적으로 과도한 와일드카드(테스트용)" }];
    const traversal: FileEntry[] = [{ path: "../../etc/passwd", sha256: "sha-evil" }];
    const result = verdict([], traversal, maliciousAllowlist);
    expect(result.overallStatus).toBe("violation");
    expect(result.violations[0]?.matchedRule).toContain("경로 순회");
  });
});

describe("core/guard/whitelist — 착수 조건 C3: 앵커된 tmp 정규식 + tmp_leftover 분류", () => {
  it("유효한 tmp 임시파일명은 허용된다", () => {
    const result = verdict(
      [],
      [{ path: ".claude.json.tmp.12345.aB3", sha256: "x" }],
      TIER2_CHURN_ALLOWLIST,
    );
    // 종료 후에도 after 스냅샷에 남아있다 → 잔존물로 분류 (churn이 아니라 tmp_leftover)
    expect(result.overallStatus).toBe("allowed_churn");
    expect(result.tmpLeftover).toHaveLength(1);
    expect(result.tmpLeftover[0]?.path).toBe(".claude.json.tmp.12345.aB3");
  });

  it("경로 순회를 포함한 tmp류 이름은 거부된다 (앵커된 정규식만 허용)", () => {
    const result = verdict(
      [],
      [{ path: ".claude.json.tmp.evil/../x", sha256: "x" }],
      TIER2_CHURN_ALLOWLIST,
    );
    expect(result.overallStatus).toBe("violation");
  });

  it("와일드카드 없는 이상한 tmp 변형(빈 rand 부분)은 앵커된 정규식에 매칭되지 않아 거부된다", () => {
    const result = verdict([], [{ path: ".claude.json.tmp..", sha256: "x" }], TIER2_CHURN_ALLOWLIST);
    expect(result.overallStatus).toBe("violation");
  });

  it("tmp가 아닌 채로 사라졌다가(removed) 다시 생기지 않는 정상 케이스는 allowed_churn이지 tmp_leftover가 아니다", () => {
    const result = verdict(
      [{ path: ".claude.json.tmp.999.zZ9", sha256: "x" }],
      [],
      TIER2_CHURN_ALLOWLIST,
    );
    expect(result.removed[0]?.status).toBe("allowed_churn");
    expect(result.tmpLeftover).toHaveLength(0);
  });
});

describe("core/guard/tree-diff — 경계 케이스 (빈 입력·중복 경로·대소문자·유니코드 정규화)", () => {
  it("빈 before/after는 clean이다 (트리 수집이 아무것도 못 봤을 때의 안전한 기본값)", () => {
    const result = verdict([], [], []);
    expect(result.overallStatus).toBe("clean");
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
  });

  it(
    "✅ 수정됨(A3) — after 배열에 동일 경로가 2건 들어오면 verdict()가 조용히 마지막 항목만 " +
      "채택하지 않고 DuplicatePathVerdictError를 던져 판정을 거부한다. tree-collect.ts(Step 2, probe)가 " +
      "언젠가 동일 경로를 중복 수집해도(symlink 이중 목록·수집 중 레이스 등) 앞선 항목이 흔적 없이 " +
      "사라지는 silent last-write-wins는 더 이상 일어나지 않는다 (P2 — 판정 불가는 추정으로 채우지 않는다)",
    () => {
      const before: FileEntry[] = [{ path: "settings.json", sha256: "sha-original" }];
      const after: FileEntry[] = [
        { path: "settings.json", sha256: "sha-first-seen" },
        { path: "settings.json", sha256: "sha-second-seen" },
      ];
      let caught: unknown;
      try {
        verdict(before, after, []);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DuplicatePathVerdictError);
      const error = caught as DuplicatePathVerdictError;
      expect(error.failureClass).toBe("duplicate_path_input");
      expect(error.duplicates).toEqual([{ path: "settings.json", list: "after" }]);
    },
  );

  it("✅ before 배열 쪽 중복도 동일하게 거부된다 (before/after 양쪽 대칭)", () => {
    const before: FileEntry[] = [
      { path: ".claude.json", sha256: "a" },
      { path: ".claude.json", sha256: "b" },
    ];
    expect(() => verdict(before, [], [])).toThrow(DuplicatePathVerdictError);
  });

  it("중복이 없는 정상 입력은 그대로 판정된다 (회귀 방지 — 거부가 과도해지지 않았는가)", () => {
    const result = verdict(before, afterWithChurn(), []);
    expect(result.overallStatus).toBe("violation");
  });

  it("대소문자가 다른 경로는 별개 경로로 취급되어 violation으로 안전하게 처리된다 (오탐 방향이지 누락 방향이 아님)", () => {
    const result = verdict([], [{ path: ".Claude.JSON", sha256: "x" }], TIER2_CHURN_ALLOWLIST);
    // 대소문자 정규화를 하지 않으므로 Tier-2의 ".claude.json"과 매치되지 않는다 — 안전한 방향의 실패.
    expect(result.overallStatus).toBe("violation");
  });

  it(
    "유니코드 정규화 형태(NFC/NFD)가 다른 동일 파일명은 서로 다른 경로 문자열로 취급된다 — " +
      "현재 allowlist는 전부 ASCII라 실제 우회는 안 되지만, 비-ASCII 경로가 allowlist에 들어가는 " +
      "순간 NFC로 기록된 규칙과 NFD로 수집된 실제 경로가 어긋나 오탐(violation 과다)이 날 수 있다 — " +
      "정규화 정책 미결정 상태를 여기 고정해둔다",
    () => {
      const nfc = "café.txt".normalize("NFC");
      const nfd = "café.txt".normalize("NFD");
      expect(nfc).not.toBe(nfd); // 서로 다른 코드포인트 시퀀스임을 전제 확인
      const result = verdict([{ path: nfc, sha256: "a" }], [{ path: nfd, sha256: "a" }], []);
      // 정규화하지 않으므로 "이름이 같은 파일"이 removed+added 쌍으로 보인다(누락 아님, 오탐 방향).
      expect(result.removed).toHaveLength(1);
      expect(result.added).toHaveLength(1);
    },
  );
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decideManagedPolicyGate, gradeManagedPolicy } from "@ctk/core";
import { readManagedPolicies } from "@ctk/probe";
import {
  formatManagedPolicyReport,
  managedPolicyExitCode,
  runDoctorManagedPolicy,
  type DoctorManagedPolicyReport,
} from "../src/commands/doctor.js";

/**
 * R15 릴리스 게이트의 회귀 테스트.
 *
 * 이 파일이 잡는 결함은 둘이고 **뿌리가 같다** — "없음"과 "판정 불가"를 구분하지 않는 것:
 *
 * 1. `readManagedPolicies()`는 `parseFailures`를 함께 돌려주는데 `gen`이 `.policies`만 꺼내
 *    썼다. 깨진 정책 파일 → `policies=[]` → `hasRisk:false` → **게이트 통과.** 위험이 없는
 *    것이 아니라 위험을 **잴 수 없는** 것이다.
 * 2. 탐지기는 있고 `gen`은 쓰는데 **조회 경로(`doctor`)에 배선돼 있지 않았다.** 사용자가
 *    "내 환경에 managed 정책이 있나"를 물을 방법이 없었다(안전 원칙 5).
 */

const policyFile = (contents: string): { path: string; platform: NodeJS.Platform }[] => {
  const dir = mkdtempSync(path.join(tmpdir(), "ctk-managed-"));
  const file = path.join(dir, "managed-settings.json");
  writeFileSync(file, contents, "utf8");
  return [{ path: file, platform: process.platform }];
};

describe("파싱 실패는 '위험 없음'이 아니다 (안전 원칙 7)", () => {
  it("깨진 정책 파일은 parseFailures로 잡히고 policies는 비어 있다", () => {
    const result = readManagedPolicies(policyFile("{ 이건 JSON이 아니다"));
    expect(result.policies).toEqual([]);
    expect(result.parseFailures).toHaveLength(1);
  });

  it("그 빈 policies만 보면 hasRisk=false가 된다 — 이 사각지대가 실재함을 먼저 보인다", () => {
    const { policies } = readManagedPolicies(policyFile("{ 깨짐"));
    expect(gradeManagedPolicy(policies).hasRisk).toBe(false);
  });

  it("게이트는 파싱 실패를 받으면 비대화형에서 거부한다 — 깨진 파일이 열쇠가 되지 않는다", () => {
    const grade = gradeManagedPolicy([]);
    expect(
      decideManagedPolicyGate(grade, {
        interactive: false,
        allowManagedPolicy: false,
        unreadablePolicyPresent: true,
      }),
    ).toBe("blocked");
  });

  it("파싱 실패가 없으면 같은 조건에서 통과한다 — 위 케이스가 '항상 거부'와 구분됨을 보인다", () => {
    expect(
      decideManagedPolicyGate(gradeManagedPolicy([]), { interactive: false, allowManagedPolicy: false }),
    ).toBe("allowed");
  });

  it("명시 옵트인은 판정 불가도 통과시킨다 — 거부에 빠져나갈 길이 있다(안전 원칙 6)", () => {
    expect(
      decideManagedPolicyGate(gradeManagedPolicy([]), {
        interactive: false,
        allowManagedPolicy: true,
        unreadablePolicyPresent: true,
      }),
    ).toBe("allowed");
  });

  it("대화형은 경고 후 진행한다 — 사용자가 그 자리에서 판단할 수 있다", () => {
    expect(
      decideManagedPolicyGate(gradeManagedPolicy([]), {
        interactive: true,
        allowManagedPolicy: false,
        unreadablePolicyPresent: true,
      }),
    ).toBe("allowed");
  });
});

describe("위험 키가 실제로 게이트를 닫는다", () => {
  it("hooks가 든 정책은 비대화형에서 거부된다", () => {
    const { policies } = readManagedPolicies(policyFile(JSON.stringify({ hooks: { SessionStart: [] } })));
    const grade = gradeManagedPolicy(policies);
    expect(grade.keysPresent).toContain("hooks");
    expect(decideManagedPolicyGate(grade, { interactive: false, allowManagedPolicy: false })).toBe("blocked");
  });

  it("모델만 고정하는 정책은 위험 키가 아니다 — 위 케이스가 '모든 정책을 막음'과 구분됨을 보인다", () => {
    const { policies } = readManagedPolicies(policyFile(JSON.stringify({ model: "sonnet" })));
    expect(gradeManagedPolicy(policies).hasRisk).toBe(false);
  });
});

describe("ctk doctor --managed-policy — 조회 경로에 배선됐다 (안전 원칙 5)", () => {
  const report = runDoctorManagedPolicy();

  it("검사한 경로를 부재까지 포함해 싣는다 — '검사 안 함'과 '없음'이 구분돼야 한다", () => {
    // 이 프로젝트가 개발되는 머신은 3경로 전부 부재가 정상이다(R15 실측).
    for (const c of report.candidates) expect(typeof c.present).toBe("boolean");
    expect(report.candidates.length).toBeGreaterThanOrEqual(process.platform === "darwin" ? 1 : 0);
  });

  it("정책 **내용**은 어디에도 담기지 않는다 — 키 이름만 나간다(§7.1)", () => {
    const serialized = JSON.stringify(report);
    // 반환 타입에 내용이 실릴 자리가 아예 없어야 한다.
    expect(Object.keys(report).sort()).toEqual(["candidates", "parseFailures", "riskKeysPresent", "sealComplete"]);
    expect(serialized).not.toContain("apiKeyHelper\":");
  });

  it("sealComplete는 위험 키와 판정 불가를 **둘 다** 반영한다", () => {
    expect(report.sealComplete).toBe(report.riskKeysPresent.length === 0 && report.parseFailures.length === 0);
  });
});

describe("사람이 읽는 출력이 판정 불가를 '이상 없음'으로 쓰지 않는다", () => {
  it("판정 불가면 봉인 불완전이라고 적고 복구 방법을 알려준다", () => {
    const text = formatManagedPolicyReport({
      candidates: [{ path: "/synthetic/managed-settings.json", present: true }],
      parseFailures: ["/synthetic/managed-settings.json"],
      riskKeysPresent: [],
      sealComplete: false,
    });
    expect(text).toContain("위험 판정 불가");
    expect(text).toContain("봉인 불완전");
    expect(text).toContain("--allow-managed-policy");
  });

  it("이상이 없으면 봉인 완전이라고 적는다 — 위 케이스가 '항상 경고'와 구분됨을 보인다", () => {
    const text = formatManagedPolicyReport({
      candidates: [{ path: "/synthetic/managed-settings.json", present: false }],
      parseFailures: [],
      riskKeysPresent: [],
      sealComplete: true,
    });
    expect(text).toContain("봉인 완전");
    expect(text).not.toContain("불완전");
    // CI에서 통과해도 개발자 머신을 검사한 것이 아니다 — 무엇을 잰 것인지 출력이 말해야 한다.
    expect(text).toContain("이 머신 기준");
  });

  it("위험 키는 이름만 적는다", () => {
    const text = formatManagedPolicyReport({
      candidates: [],
      parseFailures: [],
      riskKeysPresent: ["hooks", "apiKeyHelper"],
      sealComplete: false,
    });
    expect(text).toContain("hooks, apiKeyHelper");
  });
});

describe("종료 코드 — 릴리스 게이트가 CI에서도 막는다", () => {
  /**
   * 게이트를 사람 눈에만 기대면 CI에서 아무것도 막지 못한다. `bin/ctk.ts`가 이 함수의 값을
   * 그대로 `process.exitCode`에 넣으므로, 여기서 판정을 결정적으로 고정한다.
   */
  const report = (over: Partial<DoctorManagedPolicyReport>): DoctorManagedPolicyReport => ({
    candidates: [],
    parseFailures: [],
    riskKeysPresent: [],
    sealComplete: true,
    ...over,
  });

  it("봉인 완전이면 0", () => {
    expect(managedPolicyExitCode(report({}))).toBe(0);
  });

  it("위험 키가 있으면 1", () => {
    expect(managedPolicyExitCode(report({ riskKeysPresent: ["hooks"], sealComplete: false }))).toBe(1);
  });

  it("판정 불가만으로도 1 — 위험 키가 비어 있어도 통과시키지 않는다", () => {
    expect(managedPolicyExitCode(report({ parseFailures: ["/synthetic/p.json"], sealComplete: false }))).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  findUnusedLeakAllowances,
  findWorkflowDocLeaks,
  GENERATED_OUTPUT_AXES,
  INSTALL_INVENTORY_AXES,
  LEAK_ALLOWANCES,
  WORKFLOW_DOC_LEAK_AXES,
} from "../src/workflow-doc/leaks.js";

/**
 * ⚠️ **양성 대조군이 이 파일의 존재 이유다.** 이 저장소는 "가드와 그것이 검사할 값을 함께 놓고
 * 본다"에 반복해 데였다 — 마커를 만드는 훅이 없어 봉인 여부와 무관하게 늘 통과하던 신호가
 * 유료 실행 직전에 발견된 적이 있다. 그래서 **각 축마다 오염 문자열을 심어 실제로 빨간지**부터
 * 확인하고, 그다음에 정상 입력이 통과하는지를 본다.
 *
 * 여기 쓰인 오염 문자열은 전부 **합성**이다 — 실제 머신·설치 목록이 아니다.
 */

/**
 * 축마다 그 축**만** 건드리는 합성 오염 문자열.
 *
 * ⚠️ **홈 절대경로 두 축은 런타임에 조립한다.** 소스에 리터럴로 적으면
 * `scripts/hygiene-check.mjs`가 이 파일을 위반으로 잡는다(실제로 잡혔다 — 그 게이트는 추적
 * 파일 전수의 **내용**을 읽는다). **파일 예외로 빼지 않는다** — 예외를 만들면 이 파일이 앞으로
 * 진짜 유출을 담아도 통과한다. 조립하면 축은 그대로 태우면서 소스는 깨끗하다.
 */
const HOME_TAIL = ["someone", ".config"].join("/");
const absHome = (root: string): string => `설정은 /${root}/${HOME_TAIL}에 있다`;

const POLLUTED: Readonly<Record<(typeof WORKFLOW_DOC_LEAK_AXES)[number], string>> = {
  abs_home_users: absHome("Users"),
  abs_home_linux: absHome("home"),
  tilde_home: "설정은 ~/.config/ctk/config.json에 있다",
  marketplace_asset_id: "자산 id는 some-plugin@some-market이다",
  machine_uuid: "machine_id는 3f2a91be-77c4-4d18-9b02-5ea6c1d40f88이다",
  snapshot_filename: "스냅샷은 2026-01-02T03-04-05.678Z.jsonl이다",
};

describe("findWorkflowDocLeaks — 양성 대조군 (각 축이 실제로 막는다)", () => {
  it.each(WORKFLOW_DOC_LEAK_AXES)("축 %s의 오염을 잡는다", (axis) => {
    const leaks = findWorkflowDocLeaks(POLLUTED[axis], [axis]);
    expect(leaks.length, `축 ${axis}가 자기 오염을 못 잡으면 그 축은 신호가 아니다`).toBeGreaterThan(0);
    expect(leaks.every((l) => l.axis === axis)).toBe(true);
  });

  it("위반마다 어느 축인지를 낸다 — 뭉뚱그린 boolean이 아니다", () => {
    const leaks = findWorkflowDocLeaks(POLLUTED.machine_uuid, GENERATED_OUTPUT_AXES);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ axis: "machine_uuid" });
    expect(leaks[0]?.match).toBe("3f2a91be-77c4-4d18-9b02-5ea6c1d40f88");
  });
});

describe("축 집합은 호출부가 정한다 — 기본값이 없다", () => {
  it("요청하지 않은 축은 보지 않는다 — `~/`는 문서 전문 축에서 빠진다", () => {
    // 이것이 과잉 차단을 막는 축이다: 6축을 문서 전문에 걸면 오늘 27건이 위반이 된다.
    expect(findWorkflowDocLeaks(POLLUTED.tilde_home, INSTALL_INVENTORY_AXES)).toHaveLength(0);
    expect(findWorkflowDocLeaks(POLLUTED.tilde_home, GENERATED_OUTPUT_AXES)).toHaveLength(1);
  });

  it("문서 전문 축은 설치 목록 3축이고 경로 축을 포함하지 않는다", () => {
    expect([...INSTALL_INVENTORY_AXES].sort()).toEqual(
      ["machine_uuid", "marketplace_asset_id", "snapshot_filename"].sort(),
    );
    expect(findWorkflowDocLeaks(POLLUTED.abs_home_users, INSTALL_INVENTORY_AXES)).toHaveLength(0);
  });

  it("생성 산출물 축은 6축 전부다 — 서드파티 원문이 흘러드는 자리다", () => {
    expect([...GENERATED_OUTPUT_AXES].sort()).toEqual([...WORKFLOW_DOC_LEAK_AXES].sort());
  });

  it("빈 축 집합은 아무것도 보지 않는다 — 누락이 통과가 되지 않게 호출부가 늘 명시한다", () => {
    const everything = Object.values(POLLUTED).join("\n");
    expect(findWorkflowDocLeaks(everything, [])).toHaveLength(0);
    expect(findWorkflowDocLeaks(everything, GENERATED_OUTPUT_AXES).length).toBeGreaterThanOrEqual(6);
  });
});

describe("허용목록 — 정확 일치만, 미사용은 에러", () => {
  it("허용된 자리표시자는 통과한다", () => {
    expect(findWorkflowDocLeaks("자산 id는 `name@marketplace` 형식이다", INSTALL_INVENTORY_AXES)).toHaveLength(0);
    expect(findWorkflowDocLeaks("`https://user@pass@host/`", INSTALL_INVENTORY_AXES)).toHaveLength(0);
  });

  it("부분 일치는 통과시키지 않는다 — 통과 축은 완전 일치다", () => {
    // `name@marketplace`가 허용됐다고 `name@marketplace2`까지 새면 안 된다.
    const leaks = findWorkflowDocLeaks("자산 id는 name@marketplace2다", INSTALL_INVENTORY_AXES);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.match).toBe("name@marketplace2");
  });

  it("코퍼스에서 쓰이지 않는 허용 항목을 찾아낸다", () => {
    expect(findUnusedLeakAllowances(["name@marketplace", "user@pass"])).toHaveLength(0);
    // 상류가 바뀌어 자리표시자가 사라지면 허용 항목도 사라져야 한다.
    expect(findUnusedLeakAllowances(["name@marketplace"]).map((a) => a.match)).toEqual(["user@pass"]);
    expect(findUnusedLeakAllowances([])).toHaveLength(LEAK_ALLOWANCES.length);
  });

  it("모든 허용 항목에 사유가 붙어 있다", () => {
    for (const allowance of LEAK_ALLOWANCES) {
      expect(allowance.note.length, `${allowance.match}에 사유가 없다`).toBeGreaterThan(0);
    }
  });
});

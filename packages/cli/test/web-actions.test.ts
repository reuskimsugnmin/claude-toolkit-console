import { describe, expect, it } from "vitest";
import { parseWebActionRequest } from "@ctk/core";
import { EstimateTokenStore, createSessionToken } from "../src/commands/web-actions.js";

/**
 * `EstimateTokenStore`는 비용 게이트의 핵심 원시값인데 **테스트가 한 건도 없었다**(보안 심사 M2).
 * `packages/web/test/actions-route.test.ts`의 2-phase 검증은 전부 스텁 핸들러를 쓰므로 이
 * 구현을 한 줄도 타지 않는다 — "규칙 존재 ≠ 규칙이 막음"에 정면으로 해당했다.
 *
 * 특히 **"불일치로 거부된 토큰도 재사용 불가"**는 지금 우연히 맞는 게 아니라 `consume`이
 * 검증 **전에** 삭제하기 때문이다. 리팩터로 순서가 바뀌면 조용히 깨지므로 여기서 못 박는다.
 */

const PLAN = { maxAssets: 3, maxTotalUsd: 2, callCount: 3 };
const EXPECTED = { maxAssets: 3, maxTotalUsd: 2 };

describe("EstimateTokenStore — 1회용", () => {
  it("정확한 승인 내용으로는 소비된다", () => {
    const store = new EstimateTokenStore();
    const token = store.issue(PLAN);
    expect(store.consume(token, EXPECTED)).toEqual(PLAN);
  });

  it("같은 토큰을 두 번 쓸 수 없다 — 재생 공격을 막는다", () => {
    const store = new EstimateTokenStore();
    const token = store.issue(PLAN);
    expect(store.consume(token, EXPECTED)).not.toBeNull();
    expect(store.consume(token, EXPECTED)).toBeNull();
  });

  it("발급된 적 없는 토큰은 거부된다", () => {
    expect(new EstimateTokenStore().consume("never-issued", EXPECTED)).toBeNull();
  });
});

describe("EstimateTokenStore — 승인 내용에 묶인다", () => {
  it("총액이 다르면 거부된다 — 싸게 견적내고 비싸게 실행할 수 없다", () => {
    const store = new EstimateTokenStore();
    const token = store.issue(PLAN);
    expect(store.consume(token, { maxAssets: 3, maxTotalUsd: 50 })).toBeNull();
  });

  it("자산 수가 다르면 거부된다", () => {
    const store = new EstimateTokenStore();
    const token = store.issue(PLAN);
    expect(store.consume(token, { maxAssets: 25, maxTotalUsd: 2 })).toBeNull();
  });

  it("불일치로 거부된 뒤에는 올바른 값으로도 재사용할 수 없다 — 검증 전에 소각한다", () => {
    const store = new EstimateTokenStore();
    const token = store.issue(PLAN);
    expect(store.consume(token, { maxAssets: 3, maxTotalUsd: 50 })).toBeNull();
    expect(store.consume(token, EXPECTED)).toBeNull();
  });

  it("소비 시 **발급 시점의** 호출 수를 돌려준다 — 호출당 예산의 분모다", () => {
    const store = new EstimateTokenStore();
    const token = store.issue({ maxAssets: 25, maxTotalUsd: 2, callCount: 7 });
    expect(store.consume(token, { maxAssets: 25, maxTotalUsd: 2 })?.callCount).toBe(7);
  });
});

describe("EstimateTokenStore — TTL", () => {
  it("만료된 토큰은 거부된다", () => {
    const store = new EstimateTokenStore(1000);
    const token = store.issue(PLAN, 0);
    expect(store.consume(token, EXPECTED, 1001)).toBeNull();
  });

  it("만료 직전에는 유효하다 — 위 케이스가 '항상 거부'와 구분됨을 보인다", () => {
    const store = new EstimateTokenStore(1000);
    const token = store.issue(PLAN, 0);
    expect(store.consume(token, EXPECTED, 999)).not.toBeNull();
  });
});

describe("EstimateTokenStore — 무한 증가를 막는다 (심사 M3)", () => {
  it("미소비 토큰이 상한을 넘으면 발급을 거부하고 복구 방법을 알려준다", () => {
    const store = new EstimateTokenStore();
    for (let i = 0; i < 8; i++) store.issue(PLAN);
    expect(() => store.issue(PLAN)).toThrow(/승인 대기 중인 견적/);
    // 거부에 빠져나갈 길이 함께 있어야 한다(안전 원칙 6).
    try {
      store.issue(PLAN);
    } catch (err) {
      expect((err as Error).message).toMatch(/실행하거나|다시 시도/);
    }
  });

  it("만료된 토큰은 발급 시점에 정리되어 자리를 막지 않는다", () => {
    const store = new EstimateTokenStore(1000);
    for (let i = 0; i < 8; i++) store.issue(PLAN, 0);
    // 전부 만료된 뒤에는 다시 발급된다 — 상한이 영구 잠금이 되지 않는다.
    expect(() => store.issue(PLAN, 5000)).not.toThrow();
  });
});

describe("createSessionToken", () => {
  it("호출마다 다른 값이고 충분히 길다", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createSessionToken()));
    expect(tokens.size).toBe(50);
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(40);
  });

  it("URL에 그대로 넣을 수 있는 문자만 쓴다 — 프래그먼트로 전달되기 때문이다", () => {
    expect(createSessionToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("M1 회귀 — 인덱스 정합성 대조", () => {
  /**
   * 뷰모델을 만들 때와 `move`를 실행할 때 `listKnownProjectPaths`를 **각각 따로** 읽는다.
   * 그 사이 목록이 바뀌면 인덱스가 밀려 **다른 프로젝트의 설정이 바뀐다.** 백업·감사·롤백은
   * "우리가 쓴 곳이 맞는가"를 보지 "사용자가 고른 곳이 맞는가"는 못 보므로, 이 대조가 없으면
   * 그 실패는 어떤 게이트에도 걸리지 않고 **성공으로 끝난다**(재심 M1).
   */
  it("스키마가 to_project_hash_prefix를 받는다", () => {
    const parsed = parseWebActionRequest({
      action: "move",
      asset_id: "a",
      to: "project",
      to_project_index: 2,
      to_project_hash_prefix: "abc123",
    });
    expect(parsed).toMatchObject({ to_project_hash_prefix: "abc123" });
  });

  it("to=project인데 인덱스가 없으면 파싱이 실패한다 — 500이 아니라 400이 된다", () => {
    expect(() => parseWebActionRequest({ action: "move", asset_id: "a", to: "project" })).toThrow();
  });

  it("to=user는 인덱스 없이도 통과한다 — 위 규칙이 과잉이 아님을 보인다", () => {
    expect(() => parseWebActionRequest({ action: "move", asset_id: "a", to: "user" })).not.toThrow();
  });

  it("해시 접두가 너무 짧으면 거부된다 — 우연 일치로 대조가 무력해지지 않게", () => {
    expect(() =>
      parseWebActionRequest({
        action: "move",
        asset_id: "a",
        to: "project",
        to_project_index: 0,
        to_project_hash_prefix: "ab",
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { buildProjectChoices, containsPathSeparator, parseWebActionRequest, type ConsoleViewModel } from "@ctk/core";
import {
  PortHandoffError,
  bindWithPortHandoff,
  projectExposureNotice,
} from "../src/commands/web.js";
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

  it("대조값을 빼면 파싱이 실패한다 — optional로 두면 안 보내는 것만으로 M1 방어가 무력화된다", () => {
    expect(() =>
      parseWebActionRequest({ action: "move", asset_id: "a", to: "project", to_project_index: 0 }),
    ).toThrow();
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

describe("M2 회귀 — 계약이 실제로 막는가", () => {
  /**
   * `containsPathSeparator`는 **프로덕션에서 한 번도 호출되지 않았다**(재심 M2). 계약을
   * 선언해 놓고 단위 테스트로만 검증하면, 라벨 산출이 회귀했을 때 응답이 그대로 나간다.
   * 여기서는 그 관문이 실제로 fail-closed인지 **판정 함수 수준에서** 못 박는다.
   */
  it("라벨에 구분자가 섞이면 containsPathSeparator가 true다", () => {
    const regressed = buildProjectChoices({
      // toProjectLabel이 회귀해 경로 전체를 반환하는 상황을 그대로 흉내낸다.
      absolutePaths: ["/synthetic/a/proj"],
      hashPrefixOf: () => "aaaaaa",
    }).map((c) => ({ ...c, label: "/synthetic/a/proj" }));
    expect(containsPathSeparator(regressed)).toBe(true);
  });

  it("정상 라벨은 false — 위 케이스가 '항상 true'와 구분됨을 보인다", () => {
    const ok = buildProjectChoices({ absolutePaths: ["/synthetic/a/proj"], hashPrefixOf: () => "aaaaaa" });
    expect(containsPathSeparator(ok)).toBe(false);
  });
});

describe("L1 — 프로젝트 이름 노출 고지 (재심 L1)", () => {
  /**
   * `/api/view-model`은 **무인증**이다(막을 대상은 "다른 출처"이지 "사용자 본인"이 아니다).
   * 그래서 여기 실리는 디렉터리 이름은 같은 머신의 **다른 계정**도 읽을 수 있다 —
   * `~/.claude.json`이 `-rw-------`인 것과 비교하면 접근 통제가 느슨해진다.
   *
   * 설계로는 못 닫는다("이름 자체가 비밀"인 경우). 대신 **결정을 매번 사용자 앞에 다시
   * 놓는다** — 착수 전 점검은 시점 표본일 뿐이고, `~/.claude.json`은 새 디렉터리에서
   * `claude`를 한 번 띄우면 자동으로 늘어난다.
   */
  const vm = (projects: unknown[]): ConsoleViewModel =>
    ({
      schema_version: 1,
      generated_at: "2026-08-22T00:00:00.000Z",
      machine_id: "m",
      freshness: { last_scan_at: null, days_since_last_scan: null, is_stale: true, never_scanned: true },
      assets: [],
      projects,
      projects_unavailable: null,
      usage: {
        ranked: [],
        unrankable: [],
        total_assets_with_occupancy: 0,
        ranking_quality: { measured_count: 0, unmeasured_count: 0, is_meaningful: false, reason: "no_measured_assets" },
      },
    }) as ConsoleViewModel;

  it("선택지가 있으면 건수와 끄는 법을 함께 알린다", () => {
    const notice = projectExposureNotice(vm([{ index: 0 }, { index: 1 }]));
    expect(notice).toContain("2건");
    expect(notice).toContain("--no-projects");
    // 경고만 하고 끌 방법이 없으면 경고가 아니라 잔소리다(안전 원칙 6).
    expect(notice).toContain("다른 계정");
  });

  it("건수가 바뀌면 고지도 바뀐다 — 시점 표본 문제를 매번 눈에 띄게 한다", () => {
    expect(projectExposureNotice(vm([{ index: 0 }]))).toContain("1건");
    expect(projectExposureNotice(vm(Array.from({ length: 40 }, (_, i) => ({ index: i }))))).toContain("40건");
  });

  it("노출이 없으면 고지하지 않는다 — 아무 일도 없는데 경고하지 않는다", () => {
    expect(projectExposureNotice(vm([]))).toBeNull();
  });
});

describe("L4 — 포트 확보 TOCTOU (심사 L4)", () => {
  /**
   * 액션 모드는 관문이 실제 포트를 알아야 Host를 대조할 수 있는데, 포트를 OS에게 고르게 하려면
   * 한 번 띄웠다 닫아야 한다. **그 틈에는 아무도 포트를 잡고 있지 않다.**
   *
   * 이 실패는 막히는 쪽이다 — 관문 없는 서버가 뜨는 일은 없다. 그래서 위험이 아니라 **진단과
   * 복구 경로**가 본문이다(안전 원칙 6). 원래는 스택트레이스 하나로 끝나 사용자가 할 수 있는
   * 일이 재실행뿐이었고, 재실행은 같은 확률로 또 실패한다.
   */
  const addrInUse = () => Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });

  it("한 번에 잡히면 다시 고르지 않는다", async () => {
    let reserved = 0;
    const result = await bindWithPortHandoff(
      () => { reserved++; return Promise.resolve(40000 + reserved); },
      (port) => Promise.resolve(`bound:${port}`),
    );
    expect(result).toBe("bound:40001");
    expect(reserved).toBe(1);
  });

  it("EADDRINUSE면 새 포트를 골라 다시 시도한다 — 같은 포트를 재시도하지 않는다", async () => {
    const tried: number[] = [];
    let reserved = 0;
    const result = await bindWithPortHandoff(
      () => { reserved++; return Promise.resolve(40000 + reserved); },
      (port) => {
        tried.push(port);
        return tried.length < 3 ? Promise.reject(addrInUse()) : Promise.resolve(`bound:${port}`);
      },
    );
    expect(tried).toEqual([40001, 40002, 40003]);
    expect(result).toBe("bound:40003");
  });

  it("상한까지 실패하면 --port로 빠져나갈 길을 알려준다", async () => {
    const err = await bindWithPortHandoff(() => Promise.resolve(40000), () => Promise.reject(addrInUse()), 3)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PortHandoffError);
    expect((err as PortHandoffError).attempts).toBe(3);
    expect((err as Error).message).toContain("--port");
    // 원인을 삼키지 않는다 — "없음"과 "실패"를 구분한다(안전 원칙 7).
    expect((err as Error).cause).toMatchObject({ code: "EADDRINUSE" });
  });

  it("EADDRINUSE가 아닌 실패는 재시도하지 않고 그대로 올린다 — 원인을 흐리지 않는다", async () => {
    let attempts = 0;
    const denied = Object.assign(new Error("listen EACCES"), { code: "EACCES" });
    const err = await bindWithPortHandoff(
      () => Promise.resolve(80),
      () => { attempts++; return Promise.reject(denied); },
    ).then(() => null, (e: unknown) => e);
    expect(err).toBe(denied);
    expect(attempts, "권한 거부를 5회 반복해 봐야 같은 결과다").toBe(1);
  });
});

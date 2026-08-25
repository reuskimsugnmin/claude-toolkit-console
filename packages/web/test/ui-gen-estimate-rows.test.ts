import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildConsoleViewModel, deriveObservedUnitCost, projectGenTotalUsd, type GenCost } from "@ctk/core";
import { UI_HTML } from "../server/ui-page.js";

/**
 * web/test/ui-gen-estimate-rows.test.ts — gen 승인 화면이 **원문을 못 구한 자산을 사유별로**
 * 보여주는지 확인한다.
 *
 * ⚠️ **이 경로는 어떤 테스트도 실행하지 않고 있었다.** `ui-confirm.test.ts`는 확인 패널의
 * 열림/닫힘만 돌리고 `runGenTwoPhase()`의 행 조립부는 지나가지 않는다 — 즉 이 코드는 지금까지
 * 파싱만 됐다. 이 저장소에서 문자열로 조립한 UI 스크립트가 두 번 `SyntaxError`로 깨진 채
 * 752개 테스트가 통과했고, **파싱되는 코드도 동작은 틀린다**(CLAUDE.md).
 *
 * 판정하는 것: 사유가 셋이면 승인 화면에 **서로 다른 세 줄**이 나오는가. 한 줄로 합쳐지면
 * 조사할 것이 없는 자산에도 "드리프트를 확인하라"가 붙는다.
 */

class El {
  children: El[] = [];
  listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  classes = new Set<string>();
  className = "";
  disabled = false;
  value = "";
  style: Record<string, string> = {};
  #text = "";

  constructor(readonly tag: string) {}

  get textContent(): string {
    return this.#text || this.children.map((c) => c.textContent).join("\n");
  }
  set textContent(value: string) {
    this.#text = value;
    this.children = [];
  }
  appendChild(child: El): El {
    this.#text = "";
    this.children.push(child);
    return child;
  }
  addEventListener(type: string, fn: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }
  setAttribute(): void {}
  removeAttribute(): void {}
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
  querySelectorAll(): El[] {
    return [];
  }
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string) => (this.classes.has(c) ? this.classes.delete(c) : this.classes.add(c)),
  };
}

function extractScript(html: string): string {
  const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  if (match === null) throw new Error("UI에서 script 태그를 찾지 못했다");
  return match[1] ?? "";
}

const VIEW_MODEL = JSON.parse(
  JSON.stringify(
    buildConsoleViewModel({
      machineId: "synthetic-machine",
      projects: [],
      projectsUnavailable: null,
      assets: [],
      installations: [],
      occupancy: [],
      usage: [],
      lastScanAt: null,
      docPresence: new Map(),
      unusedExpensiveLimit: 5,
      now: new Date("2026-08-22T00:00:00.000Z"),
    }),
  ),
) as unknown;

/** 서버의 `gen_estimate` 응답 `data`가 실제로 갖는 모양 그대로 만든다. */
function estimateData(
  unresolved: { assetId: string; reason: string; locationCount?: number }[],
  observedCost: unknown = null,
  perCallBudgetUsd = 0.1,
) {
  // 서버가 하는 파생을 **실제 함수로** 한다 — 손으로 만든 숫자를 심으면 그 뒤의 단언은
  // 코드가 아니라 픽스처를 재게 된다.
  const unit = deriveObservedUnitCost(observedCost as GenCost | null);
  return {
    observed_cost: observedCost,
    observed_unit_cost:
      unit === null
        ? null
        : {
            mean_usd: unit.meanUsd,
            median_usd: unit.medianUsd,
            max_usd: unit.maxUsd,
            sample_size: unit.sampleSize,
            partial: unit.partial,
            projected_total_usd: projectGenTotalUsd(unit, 3),
          },
    assetCount: 3,
    approxBytes: 100,
    skipped: [],
    unresolved,
    call_count: 3,
    per_call_budget_usd: perCallBudgetUsd,
    max_total_usd: 2,
    max_assets: 3,
    session_remaining_usd: 5,
    estimate_token: "t".repeat(20),
  };
}

async function bootAndEstimate(
  unresolved: { assetId: string; reason: string; locationCount?: number }[],
  observedCost: unknown = null,
  perCallBudgetUsd = 0.1,
): Promise<El> {
  const byId = new Map<string, El>();
  const el = (id: string): El => {
    if (!byId.has(id)) byId.set(id, new El(id));
    return byId.get(id) as El;
  };

  const fetchStub = (url: string, init?: { body?: string }) => {
    if (url === "/api/actions") {
      const body = JSON.parse(init?.body ?? "{}") as { action?: string };
      if (body.action === "gen_estimate") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, data: estimateData(unresolved, observedCost, perCallBudgetUsd) }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, data: {} }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(VIEW_MODEL) });
  };

  const ctx: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => el(id),
      createElement: (tag: string) => new El(tag),
      querySelectorAll: () => [],
      querySelector: () => new El("main"),
    },
    location: { hash: "#token=" + "s".repeat(43), pathname: "/" },
    history: { replaceState: () => {} },
    URLSearchParams,
    fetch: fetchStub,
    console,
  };
  vm.createContext(ctx);
  new vm.Script(extractScript(UI_HTML)).runInContext(ctx);
  for (let i = 0; i < 20; i++) await Promise.resolve();

  // 승인 화면이 뜰 때까지 돌린다. 승인/취소를 누르지 않으므로 promise는 pending인 채로 두고,
  // 화면에 그려진 행만 읽는다 — 유료 호출은 어느 쪽으로도 나가지 않는다.
  const run = new vm.Script("runGenTwoPhase()").runInContext(ctx) as Promise<void>;
  void run;
  for (let i = 0; i < 40; i++) await Promise.resolve();

  return el("action-area");
}

describe("gen 승인 화면 — 원문을 못 구한 자산을 사유별로 보여준다", () => {
  it("사유가 셋이면 서로 다른 세 줄이 나온다 (합치면 잘못된 조언이 붙는다)", async () => {
    const area = await bootAndEstimate([
      { assetId: "a", reason: "source_missing" },
      { assetId: "b", reason: "no_local_source" },
      { assetId: "c", reason: "no_local_source" },
      { assetId: "d", reason: "ambiguous_source", locationCount: 2 },
    ]);
    const text = area.textContent;
    expect(text, "드리프트 사유가 화면에 없다").toContain("원본 없음");
    expect(text, "유형상 원문 부재가 화면에 없다").toContain("유형상 원문 없음");
    expect(text, "중복 설치가 화면에 없다").toContain("중복 설치");
    // 사유 슬러그가 날것으로 나오면 core 라벨 주입이 끊긴 것이다.
    expect(text).not.toContain("no_local_source");
    // 같은 사유는 합산된다 — b·c가 2건으로 묶여야 한다.
    expect(text).toContain("2건");
  });

  it("미해결이 0건이면 그 줄 자체가 나오지 않는다", async () => {
    const area = await bootAndEstimate([]);
    const text = area.textContent;
    expect(text).toContain("생성 대상");
    expect(text).not.toContain("원본 없음");
    expect(text).not.toContain("유형상 원문 없음");
  });
});

/**
 * 실측 단가 줄. **상한만 보여주면 그 상한이 현실적인지 알 수 없다** — 실측(2026-08-24)에서
 * 자산당 중앙값이 호출당 상한보다 커서 30건 중 15건이 하네스에 **사전 거부**됐다. 화면이 그걸
 * 미리 말해야 사용자가 총액을 올릴 수 있다.
 */
describe("gen 승인 화면 — 실측 단가와 상한 경고", () => {
  // 합성 표본 — 평균 $0.200 · 중앙값 $0.160 · 최대 $0.650 (모양만 실측을 따른다)
  const OBSERVED = { calls_reported: 20, calls_unreported: 0, reported_total_usd: 4.0, median_usd: 0.16, max_usd: 0.65 };

  it("실측이 있으면 자산당 단가와 이번 실행 환산액을 보여준다", async () => {
    const text = (await bootAndEstimate([], OBSERVED, 0.5)).textContent;
    // 평균·중앙값·최대를 갈라 적는다 — 셋은 서로 다른 질문에 답한다(한 값으로 뭉치지 않는다).
    expect(text).toContain("평균 $0.200"); // 4.00 ÷ 20
    expect(text).toContain("중앙값 $0.160");
    expect(text).toContain("최대 $0.650");
    // **총액은 평균 × 건수다.** 0.200 × 3 = 0.60
    expect(text).toContain("$0.60");
  });

  /**
   * 회귀 고정 — 화면이 다시 **중앙값**으로 총액을 투사하면 $0.48이 나온다. 실측 3배치에서
   * 그 식은 총액을 11.7~21.0% 낮게 말했고, 사용자는 그 숫자 위에서 승인했다.
   */
  it("총액을 중앙값으로 곱하지 않는다 (그러면 $0.48이 나온다)", async () => {
    const text = (await bootAndEstimate([], OBSERVED, 0.5)).textContent;
    expect(text).not.toContain("$0.48");
  });

  it("호출당 상한이 실측 중앙값보다 낮으면 경고한다 — 이번에 15건이 사전 거부된 이유다", async () => {
    const text = (await bootAndEstimate([], OBSERVED, 0.05)).textContent;
    expect(text).toContain("상한 경고");
    expect(text).toContain("사전 거부");
  });

  it("상한이 충분하면 경고하지 않는다 — 항상 뜨는 경고는 신호가 아니다", async () => {
    const text = (await bootAndEstimate([], OBSERVED, 0.5)).textContent;
    expect(text).not.toContain("상한 경고");
  });

  it("실측이 없으면 '없음'이라고 말한다 — 그럴듯한 숫자를 지어내지 않는다", async () => {
    const text = (await bootAndEstimate([], null, 0.5)).textContent;
    expect(text).toContain("실측 단가");
    expect(text).toContain("없음");
  });

  it("보고 0건인 이력은 실측으로 치지 않는다 — 중앙값 0은 '공짜'로 읽힌다", async () => {
    const empty = { calls_reported: 0, calls_unreported: 3, reported_total_usd: 0, median_usd: null, max_usd: null };
    const text = (await bootAndEstimate([], empty, 0.5)).textContent;
    expect(text).toContain("없음");
    expect(text).not.toContain("$0.000");
  });
});

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildConsoleViewModel } from "@ctk/core";
import { UI_HTML } from "../server/ui-page.js";

/**
 * 확인 패널의 **동작** 회귀 (심사 L6).
 *
 * ⚠️ **문자열 검사로는 이 결함을 못 잡는다.** 결함은 "`confirmBlocks`라는 이름이 있는가"가
 * 아니라 "패널을 지울 때 그 promise가 응답되는가"이고, 깨진 코드에도 `toContain`이 찾는
 * 문자열은 그대로 있다. 그래서 여기서는 **서빙되는 바로 그 스크립트를** 최소 DOM 위에서
 * 실제로 실행한다(CLAUDE.md: 생성된 산출물은 파싱·실행해 확인한다).
 *
 * 원래 결함: 새 확인 패널이 `action-area`를 비우면 앞 패널의 버튼이 DOM에서 떨어져 나가고
 * 리스너도 함께 사라진다 — 그 promise는 영원히 pending이고 이를 기다리던 async 프레임은
 * 깨어나지 않는다. `gen` 견적이 그렇게 묶이면 미소비 견적 토큰이 상한(8개)을 채워 TTL
 * 10분 동안 문서 생성이 막힌다. 조용히 사라지는 것이 아니라 **나중에 엉뚱한 곳에서** 터진다.
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
    return this.#text || this.children.map((c) => c.textContent).join("");
  }
  /** 핵심 의미 — 텍스트를 넣으면 자식이 **떨어져 나간다.** 결함의 발생 지점이 정확히 여기다. */
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
  };

  /** 하위 트리에서 텍스트로 버튼을 찾는다 — 사용자가 화면에서 찾는 방식과 같다. */
  findButton(text: string): El | null {
    if (this.tag === "button" && this.textContent === text) return this;
    for (const child of this.children) {
      const hit = child.findButton(text);
      if (hit !== null) return hit;
    }
    return null;
  }
  find(className: string): El | null {
    if (this.className === className) return this;
    for (const child of this.children) {
      const hit = child.find(className);
      if (hit !== null) return hit;
    }
    return null;
  }
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

interface Harness {
  ctx: Record<string, unknown>;
  el: (id: string) => El;
  actionCalls: unknown[];
}

async function boot(): Promise<Harness> {
  const byId = new Map<string, El>();
  const el = (id: string): El => {
    if (!byId.has(id)) byId.set(id, new El(id));
    return byId.get(id) as El;
  };
  const actionCalls: unknown[] = [];

  const fetchStub = (url: string, init?: { body?: string }) => {
    if (url === "/api/actions") {
      actionCalls.push(JSON.parse(init?.body ?? "{}"));
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

  // boot()은 top-level에서 호출되고 fetch를 await한다 — 마이크로태스크가 비워질 때까지 기다린다.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { ctx, el, actionCalls };
}

/** 영원히 pending인 promise를 타임아웃과 구분한다 — 결함이 재발하면 여기서 드러난다. */
function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: promise가 응답되지 않았다 (L6 재발)`)), 2000),
    ),
  ]);
}

const ROWS = [["대상", "합성 자산"]];

describe("확인 패널 — 한 번에 하나만 열린다 (심사 L6)", () => {
  it("확인이 열린 동안 다른 액션은 실행되지 않고, 막힌 이유가 패널에 표시된다", async () => {
    const { ctx, el, actionCalls } = await boot();
    const run = ctx["runSimpleAction"] as (l: string, b: unknown, r?: unknown) => Promise<void>;

    const first = run("롤백", { action: "rollback" }, ROWS);
    await Promise.resolve();
    expect(el("action-area").find("confirm"), "확인 패널이 열려야 한다").not.toBeNull();

    // 두 번째 액션 — 확인이 필요 없는 것이라도 막힌다.
    await run("스캔", { action: "scan" });
    expect(actionCalls, "확인이 열린 동안에는 어떤 액션도 서버로 나가지 않는다").toEqual([]);
    expect(el("action-area").find("confirm")?.find("hint")?.textContent).toContain("먼저 이 확인에 답한다");

    // 앞 패널은 살아 있다 — 그것을 깨울 버튼이 사라지지 않았다.
    el("action-area").find("confirm")?.findButton("취소")?.click();
    await withDeadline(first, "취소로 닫은 확인");
    expect(actionCalls, "취소했으므로 롤백도 나가지 않는다").toEqual([]);
  });

  it("답한 뒤에는 같은 액션이 실행된다 — 위 케이스가 '항상 막힘'과 구분됨을 보인다", async () => {
    const { ctx, el, actionCalls } = await boot();
    const run = ctx["runSimpleAction"] as (l: string, b: unknown, r?: unknown) => Promise<void>;

    const first = run("롤백", { action: "rollback" }, ROWS);
    await Promise.resolve();
    el("action-area").find("confirm")?.findButton("취소")?.click();
    await withDeadline(first, "취소로 닫은 확인");

    await run("스캔", { action: "scan" });
    expect(actionCalls).toEqual([{ action: "scan" }]);
  });

  it("승인하면 그 액션이 나간다 — 취소가 기본이지만 승인 경로도 살아 있다", async () => {
    const { ctx, el, actionCalls } = await boot();
    const run = ctx["runSimpleAction"] as (l: string, b: unknown, r?: unknown) => Promise<void>;

    const first = run("롤백", { action: "rollback" }, ROWS);
    await Promise.resolve();
    el("action-area").find("confirm")?.findButton("실행")?.click();
    await withDeadline(first, "승인으로 닫은 확인");
    expect(actionCalls).toEqual([{ action: "rollback" }]);
  });

  it("확인이 열린 동안 gen 견적도 시작하지 않는다 — 미소비 토큰이 상한을 채우는 경로다", async () => {
    const { ctx, el, actionCalls } = await boot();
    const run = ctx["runSimpleAction"] as (l: string, b: unknown, r?: unknown) => Promise<void>;
    const gen = ctx["runGenTwoPhase"] as () => Promise<void>;

    const first = run("롤백", { action: "rollback" }, ROWS);
    await Promise.resolve();
    await gen();
    expect(actionCalls, "gen_estimate도 나가면 안 된다").toEqual([]);

    el("action-area").find("confirm")?.findButton("취소")?.click();
    await withDeadline(first, "취소로 닫은 확인");
  });
});

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildConsoleViewModel } from "@ctk/core";
import { buildUiPage } from "../server/ui-page.js";

/**
 * web/test/ui-doc-state.test.ts — 자산 상세의 **문서 상태 배너**를 최소 스텁 위에서 **실행해**
 * 확인한다.
 *
 * ⚠️ **파싱만으로는 부족하다.** 이 저장소에서 문자열로 조립한 UI 스크립트가 두 번
 * `SyntaxError`로 깨진 채 752개 테스트가 통과한 적이 있고, 파싱되는 코드도 동작은 틀릴 수
 * 있다(CLAUDE.md). 기존 `ui-confirm.test.ts`의 하네스는 확인 패널·액션 경로만 실행하므로
 * 여기서 만든 `showDetail` 경로는 **파싱만 되고 실행되지 않았다.**
 *
 * 이 테스트가 판정하는 것은 하나다 — **문서가 없는 세 사유가 서로 다른 문구로 나오는가.**
 * 셋이 같은 문장으로 나오던 것이 고치려는 결함이므로, **오답이 가능해야** 한다: 사유를
 * 바꿔가며 배너가 실제로 달라지는지 본다(후보가 하나면 "골랐다"와 "집었다"가 같다).
 */

/**
 * DOM 스텁. `ui-confirm.test.ts`의 것과 같은 계약을 쓴다 — `textContent` 게터가 자식을 이어
 * 붙이므로 "화면에 보이는 글자"를 그대로 읽을 수 있고, `value`·`setAttribute`가 없으면
 * `renderAssets`가 미처리 거부로 죽는다(테스트는 통과하는데 오류가 섞이는 상태가 되고,
 * 그 잡음에 진짜 오류가 숨는다).
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

const UI_HTML = buildUiPage("n".repeat(22));

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

/** 서버가 `/api/assets/<id>/doc-state`로 실제로 내보내는 봉투 모양 그대로 만든다. */
interface DocStateEnvelope {
  state: unknown;
  display: { label: string; detail: string; action: string };
}

async function bootAndShowDetail(docState: DocStateEnvelope | null): Promise<El> {
  const byId = new Map<string, El>();
  const el = (id: string): El => {
    if (!byId.has(id)) byId.set(id, new El(id));
    return byId.get(id) as El;
  };

  const fetchStub = (url: string) => {
    if (url.includes("/doc-state")) {
      if (docState === null) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(docState) });
    }
    if (url.includes("/doc/")) {
      // 문서 본문은 없다 — 배너가 사유를 말해야 하는 상황을 만든다.
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
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
    location: { hash: "", pathname: "/" },
    history: { replaceState: () => {} },
    URLSearchParams,
    fetch: fetchStub,
    console,
  };
  vm.createContext(ctx);
  new vm.Script(extractScript(UI_HTML)).runInContext(ctx);
  for (let i = 0; i < 20; i++) await Promise.resolve();

  const showDetail = ctx["showDetail"] as (asset: unknown) => Promise<void>;
  expect(showDetail, "showDetail이 스크립트에서 노출돼야 이 경로를 실행할 수 있다").toBeTypeOf("function");
  await showDetail({ id: "synthetic-asset", kind: "skill", name: "synthetic-asset", marketplace: null });
  for (let i = 0; i < 20; i++) await Promise.resolve();

  return el("detail-docs");
}

describe("자산 상세 — 문서가 없는 사유를 구분해 보여준다", () => {
  const CASES: Array<{ name: string; envelope: DocStateEnvelope; mustContain: string[] }> = [
    {
      name: "미실행(유료 실행이 필요)",
      envelope: {
        state: { kind: "pending_generation", trigger: "new" },
        display: { label: "생성 대기", detail: "아직 한 번도 생성하지 않았다.", action: "`ctk gen`으로 생성한다" },
      },
      mustContain: ["생성 대기", "아직 한 번도 생성하지 않았다", "ctk gen"],
    },
    {
      name: "원본 없음(조사가 필요)",
      envelope: {
        state: { kind: "source_missing" },
        display: { label: "원본 없음", detail: "원본을 찾지 못했다.", action: "드리프트인지 확인한다" },
      },
      mustContain: ["원본 없음", "드리프트인지 확인한다"],
    },
    {
      name: "위생 거부(정책 결정이 필요)",
      envelope: {
        state: { kind: "blocked", failure_class: "path_traversal_detected", reason: "심볼릭 링크" },
        display: { label: "위생 거부", detail: "위생 검사가 거부했다.", action: "돈을 써도 만들어지지 않는다" },
      },
      mustContain: ["위생 거부", "돈을 써도 만들어지지 않는다"],
    },
  ];

  for (const c of CASES) {
    it(`${c.name} — 사유와 할 일이 화면에 나온다`, async () => {
      const host = await bootAndShowDetail(c.envelope);
      const text = host.textContent;
      for (const needle of c.mustContain) expect(text, `"${needle}"가 화면에 없다`).toContain(needle);
      expect(text, "할 일이 반드시 붙는다 — 진단만 있고 빠져나갈 길이 없으면 안 된다").toContain("할 일:");
    });
  }

  it("세 사유가 서로 다른 화면을 만든다 (이전 결함: 셋이 같은 한 문장이었다)", async () => {
    const texts: string[] = [];
    for (const c of CASES) texts.push((await bootAndShowDetail(c.envelope)).textContent);
    expect(new Set(texts).size, "사유가 달라도 화면이 같으면 3분할이 되지 않은 것이다").toBe(3);
  });

  it("상태 조회가 실패하면 '문서 없음'으로 뭉개지 않고 확인 실패라고 말한다", async () => {
    const text = (await bootAndShowDetail(null)).textContent;
    expect(text).toContain("문서 상태를 확인하지 못했다");
    // "없다"로 단정하지 않는다 — 못 읽은 것과 없는 것은 다르다(안전 원칙 7).
    expect(text).not.toContain("생성 대기");
  });
});

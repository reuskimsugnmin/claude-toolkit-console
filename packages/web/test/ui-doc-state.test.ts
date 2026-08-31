import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildConsoleViewModel, parseAsset } from "@ctk/core";
import { buildUiPage } from "../server/ui-page.js";
import { createElClass } from "./helpers/dom-stub.js";

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
const El = createElClass({ textJoin: "\n" });
type El = InstanceType<typeof El>;

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
      // ⚠️ 자산을 **실제로 하나 담는다.** 이전에는 빈 배열이었고 `showDetail`에는 손으로 줄인
      // 객체를 넘겼는데, 그러면 상세가 읽는 필드가 늘어날 때마다 픽스처가 조용히 뒤처진다.
      // 여기서 만든 행을 그대로 `showDetail`에 넘겨 **프로덕션과 같은 모양**을 태운다.
      assets: [
        parseAsset({
          schema_version: 1,
          _scope: "machine_independent",
          id: "synthetic-asset",
          kind: "skill",
          name: "synthetic-asset",
        }),
      ],
      installations: [
        {
          schema_version: 1,
          _scope: "machine_dependent",
          machine_id: "synthetic-machine",
          asset_id: "synthetic-asset",
          install_scope: "user",
          enabled_at: "project",
          project_path_hash: null,
          mcp_enabled_state: null,
          mcp_state_source: null,
        },
      ],
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

/**
 * 스크립트만 띄우고, **같은 컨텍스트에서 식 하나를 평가해** 값을 꺼낸다.
 *
 * ⚠️ `ctx["이름"]`으로는 못 읽는다 — vm 컨텍스트에서 top-level `const`/`let`은 전역 **객체의
 * 속성이 되지 않고** 전역 렉시컬 환경에만 산다(`var`·함수 선언과 다르다). 이 테스트를 처음
 * 쓸 때 그대로 걸렸다. 같은 컨텍스트에서 이어 평가하면 그 바인딩이 보이고, 이것이 파싱이
 * 아니라 실행으로 확인하는 방법이다.
 */
async function evalInBootedScript(expression: string): Promise<unknown> {
  const ctx: Record<string, unknown> = {
    document: {
      getElementById: () => new El("stub"),
      createElement: (tag: string) => new El(tag),
      querySelectorAll: () => [],
      querySelector: () => new El("main"),
    },
    location: { hash: "", pathname: "/" },
    history: { replaceState: () => {} },
    URLSearchParams,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(VIEW_MODEL) }),
    console,
  };
  vm.createContext(ctx);
  new vm.Script(extractScript(UI_HTML)).runInContext(ctx);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return new vm.Script(expression).runInContext(ctx);
}

/**
 * 상세를 띄우고 **id 맵 전체**를 돌려준다. `detail-docs` 하나만 돌려주던 것을 넓혔다 —
 * B3 Step 4a가 `detail-meta-grid`도 검사해야 하는데, 그것 때문에 하네스를 한 벌 더 만들면
 * 이 저장소가 방금 없앤 사본 문제가 되살아난다.
 */
async function bootAndShowDetail(
  docState: DocStateEnvelope | null,
): Promise<{ docs: El; byId: Map<string, El> }> {
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
  // ⚠️ **뷰모델이 실제로 내는 행을 그대로 넘긴다.** 이전에는 `{id, kind, name, marketplace}`만
  // 넘겼는데, 프로덕션 경로(`renderAssets` → `showDetail`)는 **항상 완전한 `AssetRowView`**를
  // 넘긴다. 손으로 줄인 픽스처는 그 차이를 숨기다가, 상세가 `installations`를 읽기 시작한
  // 순간(B3 Step 4a) 한꺼번에 터졌다 — 픽스처는 판정이 낼 수 있는 값 전체를 담아야 한다.
  const row = (VIEW_MODEL as { assets: unknown[] }).assets[0];
  expect(row, "뷰모델에 자산 행이 없다 — 픽스처가 비었다").toBeTruthy();
  await showDetail(row);
  for (let i = 0; i < 20; i++) await Promise.resolve();

  return { docs: el("detail-docs"), byId };
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
      name: "유형상 원문 없음(조사할 것이 없다)",
      envelope: {
        state: { kind: "no_local_source" },
        display: {
          label: "유형상 원문 없음",
          detail: "이 자산 유형(MCP 서버 · CLI)은 로컬에 읽을 정형 원문 파일이 없다.",
          action: "조사할 것이 없다 — 드리프트가 아니다",
        },
      },
      mustContain: ["유형상 원문 없음", "드리프트가 아니다"],
    },
    {
      name: "중복 설치 · 내용 불일치(충돌 해소가 필요)",
      envelope: {
        state: { kind: "ambiguous_source", location_count: 2 },
        display: {
          label: "중복 설치 · 내용 불일치",
          detail: "같은 이름의 원문이 이 머신 2곳에 있고 내용이 서로 다르다.",
          action: "중복 중 하나를 지우거나 이름을 갈라 충돌을 없앤다",
        },
      },
      mustContain: ["중복 설치", "2곳", "충돌을 없앤다"],
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
      const { docs: host } = await bootAndShowDetail(c.envelope);
      const text = host.textContent;
      for (const needle of c.mustContain) expect(text, `"${needle}"가 화면에 없다`).toContain(needle);
      expect(text, "할 일이 반드시 붙는다 — 진단만 있고 빠져나갈 길이 없으면 안 된다").toContain("할 일:");
    });
  }

  it("다섯 사유가 서로 다른 화면을 만든다 (이전 결함: 전부 같은 한 문장이었다)", async () => {
    const texts: string[] = [];
    for (const c of CASES) texts.push((await bootAndShowDetail(c.envelope)).docs.textContent);
    expect(new Set(texts).size, "사유가 달라도 화면이 같으면 분할이 되지 않은 것이다").toBe(CASES.length);
  });

  /**
   * ⚠️ **라벨 출처가 하나인지 실행해서 확인한다.** UI는 브라우저 스크립트라 `@ctk/core`를
   * 임포트할 수 없어 `ui-page.ts`가 렌더 시점에 `UNRESOLVED_LABEL`을 주입한다. 그 주입이
   * 조용히 빠지면 화면은 사유 문자열(`no_local_source`)을 날것으로 보여주는데, 문자열
   * 조립물은 **파싱돼도 동작은 틀린다**(CLAUDE.md) — 그래서 정적 검사가 아니라 실행으로 본다.
   */
  it("사유 배지 문구가 core에서 주입돼 실행 시점에 닿는다", async () => {
    const labels = (await evalInBootedScript("UNRESOLVED_LABEL")) as Record<string, string> | undefined;
    expect(labels, "UNRESOLVED_LABEL 주입이 빠졌다").toBeTypeOf("object");
    for (const reason of ["source_missing", "no_local_source", "ambiguous_source"]) {
      expect(labels?.[reason], `${reason}의 배지 문구가 없다`).toBeTruthy();
      // 사유 슬러그를 그대로 보여주면 주입이 안 된 것과 같다.
      expect(labels?.[reason]).not.toBe(reason);
    }
    expect(new Set(Object.values(labels ?? {})).size, "세 사유가 같은 문구면 화면이 뭉갠다").toBe(3);
  });

  it("상태 조회가 실패하면 '문서 없음'으로 뭉개지 않고 확인 실패라고 말한다", async () => {
    const text = (await bootAndShowDetail(null)).docs.textContent;
    expect(text).toContain("문서 상태를 확인하지 못했다");
    // "없다"로 단정하지 않는다 — 못 읽은 것과 없는 것은 다르다(안전 원칙 7).
    expect(text).not.toContain("생성 대기");
  });
});

/**
 * B3 Step 4a — D-5. 설치 스코프·활성·출처가 **목록에만** 있어서, 자산 하나를 보다가 그 값을
 * 알려면 목록으로 되돌아가야 했다. 상세 머리에 메타 그리드를 두어 한 화면에서 끝낸다.
 */
describe("자산 상세 — 메타 그리드 (D-5)", () => {
  /** 그리드를 `라벨 → 값` 맵으로 편다. 쌍은 `<div>`로 감싸여 있다. */
  async function metaOf(): Promise<Map<string, El>> {
    const { byId } = await bootAndShowDetail(null);
    const grid = byId.get("detail-meta-grid")!;
    const out = new Map<string, El>();
    for (const cell of grid.children) {
      expect(cell.children.length, "메타 칸은 dt·dd 두 자식이어야 한다").toBe(2);
      out.set(cell.children[0]!.textContent, cell.children[1]!);
    }
    return out;
  }

  it("종류·id·설치 스코프·활성·출처를 한 화면에서 보여준다", async () => {
    const meta = await metaOf();
    expect(meta.get("종류")!.textContent).toBe("skill");
    expect(meta.get("id")!.textContent).toBe("synthetic-asset");
    expect(meta.get("설치 스코프")!.textContent).toBe("user");
    expect(meta.get("활성")!.textContent).toBe("project");
    expect(meta.get("출처")!.textContent).toBe("—");
  });

  it("설치 스코프와 활성이 **다른 행**이다 — 한 칸에 뭉개지 않는다", async () => {
    const meta = await metaOf();
    expect(meta.has("설치 스코프")).toBe(true);
    expect(meta.has("활성")).toBe(true);
    expect(meta.get("설치 스코프")!.textContent).not.toBe(meta.get("활성")!.textContent);
  });

  it("mcp가 아닌 자산에는 MCP 상태 행이 **없다** — 대조군", async () => {
    const meta = await metaOf();
    expect(meta.has("MCP 상태"), "skill 자산에 MCP 행이 붙었다 — 흡수한 열이 되살아난 것이다").toBe(false);
  });

  it("마켓플레이스가 없으면 그 행도 없다 — 빈 값을 행으로 만들지 않는다", async () => {
    const meta = await metaOf();
    expect(meta.has("마켓플레이스")).toBe(false);
  });
});

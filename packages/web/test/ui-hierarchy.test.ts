import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildConsoleViewModel, parseAsset } from "@ctk/core";
import { buildUiPage } from "../server/ui-page.js";
import { createElClass } from "./helpers/dom-stub.js";

/**
 * web/test/ui-hierarchy.test.ts — B1 Step 6 (결정 4 · 결정 7): 번들 자식을 부모 아래 접어
 * 보여주고 검색이 계층을 관통하는지 **실행해** 확인한다.
 *
 * ⚠️ **파싱만으로는 부족하다.** 문자열로 조립한 UI가 타입체크·테스트를 통과하고도
 * `SyntaxError`로 죽은 적이 두 번 있다(CLAUDE.md). `ui-doc-state.test.ts`와 같은 `node:vm`
 * 하네스를 그대로 재사용해 `<script>`를 뽑아 실제로 띄운다.
 *
 * 픽스처(전부 합성 이름) — 부모 `P` + 자식 `C1`(매치)·`C2`(매치)·`C3`(비매치) + 무관한
 * 최상위 `A`. `parseAsset`로 실제 zod 파서를 통과시킨다(`as Asset` 캐스팅 없음).
 */

/** `ui-doc-state.test.ts`와 같은 계약의 DOM 스텁 — `children` 배열로 트리 구조를 그대로 들여다본다. */
const El = createElClass({ textJoin: "\n" });
type El = InstanceType<typeof El>;

function extractScript(html: string): string {
  const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  if (match === null) throw new Error("UI에서 script 태그를 찾지 못했다");
  return match[1] ?? "";
}

const UI_HTML = buildUiPage("n".repeat(22));

/**
 * 픽스처를 매번 새로 만든다(테스트 간 공유하면 뒤섞임 실험(#5)이 다른 테스트에 영향을 준다).
 * `shuffle`이 true면 배열 순서를 흔든다 — 정렬 인접성에 기대지 않는지 보는 것(#5)이 목적이다.
 */
function buildFixtureViewModel(opts: { dropParentRow?: boolean; shuffle?: boolean } = {}) {
  const parent = parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: "synth-plugin@synth-mp",
    kind: "plugin",
    name: "synth-plugin",
    marketplace: "synth-mp",
  });
  const c1 = parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: "synth-plugin@synth-mp:needle-one",
    kind: "agent",
    name: "needle-one",
    parent_asset_id: "synth-plugin@synth-mp",
  });
  const c2 = parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: "synth-plugin@synth-mp:needle-two",
    kind: "command",
    name: "needle-two",
    parent_asset_id: "synth-plugin@synth-mp",
  });
  const c3 = parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: "synth-plugin@synth-mp:unrelated-sub",
    kind: "agent",
    name: "unrelated-sub",
    parent_asset_id: "synth-plugin@synth-mp",
  });
  const a = parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: "synth-standalone-skill",
    kind: "skill",
    name: "synth-standalone-skill",
  });

  let assets = opts.dropParentRow ? [c1, c2, c3, a] : [parent, c1, c2, c3, a];
  if (opts.shuffle) assets = [...assets].reverse();

  return JSON.parse(
    JSON.stringify(
      buildConsoleViewModel({
        machineId: "synthetic-machine",
        projects: [],
        projectsUnavailable: null,
        assets,
        installations: opts.dropParentRow
          ? []
          : [
              {
                schema_version: 1,
                _scope: "machine_dependent",
                machine_id: "synthetic-machine",
                asset_id: "synth-plugin@synth-mp",
                install_scope: "user",
                enabled_at: "user",
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
}

/** 스크립트를 부팅하고 `renderAssets`·`$`·`EXPANDED` 등을 실행 컨텍스트에서 꺼내 쓴다. */
async function bootWithViewModel(viewModel: unknown): Promise<{
  byId: Map<string, El>;
  ctx: Record<string, unknown>;
  renderAssets: () => void;
}> {
  const byId = new Map<string, El>();
  const el = (id: string): El => {
    if (!byId.has(id)) byId.set(id, new El(id));
    return byId.get(id) as El;
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
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(viewModel) }),
    console,
  };
  vm.createContext(ctx);
  new vm.Script(extractScript(UI_HTML)).runInContext(ctx);
  for (let i = 0; i < 20; i++) await Promise.resolve();

  const renderAssets = ctx["renderAssets"] as (() => void) | undefined;
  expect(renderAssets, "renderAssets가 스크립트에서 노출돼야 이 경로를 실행할 수 있다").toBeTypeOf("function");

  return { byId, ctx, renderAssets: renderAssets as () => void };
}

describe("자산 목록 — 번들 자식을 부모 아래 접어 보여주고 검색이 계층을 관통한다 (B1 Step 6)", () => {
  it("#1 검색어가 자식에만 있으면 부모(P)와 매치된 자식(C1·C2)만 보이고, 비매치 자식(C3)·무관 자산(A)은 안 보인다", async () => {
    const { byId, ctx, renderAssets } = await bootWithViewModel(buildFixtureViewModel());
    byId.get("q")!.value = "needle";
    renderAssets();
    const text = byId.get("assets-body")!.textContent;
    expect(text, "부모가 안 보인다").toContain("synth-plugin");
    expect(text, "매치된 자식 C1이 안 보인다").toContain("needle-one");
    expect(text, "매치된 자식 C2가 안 보인다").toContain("needle-two");
    expect(text, "비매치 자식 C3이 새어 나왔다").not.toContain("unrelated-sub");
    expect(text, "무관한 최상위 A가 새어 나왔다").not.toContain("synth-standalone-skill");
    void ctx;
  });

  it("#2 반대 축: 검색어를 비우고 다시 렌더하면 접힘 기본이라 자식(C1·C2·C3)이 전부 안 보인다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildFixtureViewModel());
    byId.get("q")!.value = "needle";
    renderAssets();
    expect(byId.get("assets-body")!.textContent).toContain("needle-one");

    byId.get("q")!.value = "";
    renderAssets();
    const text = byId.get("assets-body")!.textContent;
    expect(text, "부모는 계속 보여야 한다").toContain("synth-plugin");
    expect(text, "검색어를 비웠는데도 자식 C1이 펼쳐진 채 남았다 — 한 번도 접지 않는 UI에서만 통과하는 결함").not.toContain(
      "needle-one",
    );
    expect(text, "검색어를 비웠는데도 자식 C2가 펼쳐진 채 남았다").not.toContain("needle-two");
    expect(text, "검색어를 비웠는데도 자식 C3이 펼쳐진 채 남았다").not.toContain("unrelated-sub");
  });

  it("#3 filter-count는 매치 건수(2)를 말한다 — 렌더된 행 수(부모+자식2=3)가 아니다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildFixtureViewModel());
    byId.get("q")!.value = "needle";
    renderAssets();
    const count = byId.get("filter-count")!.textContent;
    expect(count.startsWith("2 "), `"2 / N건"으로 시작해야 하는데 "${count}"였다`).toBe(true);
  });

  it("#4 부모 행의 펼치기 버튼을 클릭하면 자식(C1·C2·C3)이 전부 보인다 — 펼침이 실제로 동작한다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildFixtureViewModel());
    renderAssets(); // q === "", kind === "" — 부모만 보이고 자식은 접혀 있어야 한다
    let text = byId.get("assets-body")!.textContent;
    expect(text).toContain("synth-plugin");
    expect(text).not.toContain("needle-one");

    const parentRow = byId.get("assets-body")!.children.find((tr) => tr.textContent.includes("synth-plugin"));
    expect(parentRow, "부모 행을 찾지 못했다").toBeTruthy();
    const toggle = parentRow!.children[0]!.children[0]; // nameTd의 첫 자식 = 펼치기 버튼
    expect(toggle?.tag, "펼치기 버튼이 없다").toBe("button");
    toggle!.click();

    text = byId.get("assets-body")!.textContent;
    expect(text, "펼친 뒤에도 C1이 안 보인다").toContain("needle-one");
    expect(text, "펼친 뒤에도 C2가 안 보인다").toContain("needle-two");
    expect(text, "펼친 뒤에도 C3이 안 보인다(비매치 자식도 펼침 상태에서는 전부 보여야 한다)").toContain("unrelated-sub");
  });

  it("#5 정렬 인접성 비의존: 뷰모델 배열을 뒤섞어 넣어도 부모-자식 묶기가 같다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildFixtureViewModel({ shuffle: true }));
    byId.get("q")!.value = "needle";
    renderAssets();
    const text = byId.get("assets-body")!.textContent;
    expect(text).toContain("synth-plugin");
    expect(text).toContain("needle-one");
    expect(text).toContain("needle-two");
    expect(text).not.toContain("unrelated-sub");
  });

  it("#6 부재 주입: 인덱스에서 부모 행을 제거하면 자식은 inherited_unavailable이고 '미설치'가 아닌 문구로 나온다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildFixtureViewModel({ dropParentRow: true }));
    byId.get("q")!.value = "needle";
    renderAssets();
    const text = byId.get("assets-body")!.textContent;
    expect(text, "고아 자식 C1이 화면에 없다").toContain("needle-one");
    expect(text, "고아 자식이 '미설치'로 읽히면 안 된다").not.toContain("미설치");
    expect(text, "부모를 못 찾았다는 사실이 문구로 나와야 한다").toContain("상속 정보 확인 불가");
  });
});

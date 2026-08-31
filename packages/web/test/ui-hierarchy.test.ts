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
    /**
     * ⚠️ **`URL`이 없으면 하네스가 거짓말한다.** `repoCell`은 `new URL(repo.url)`로 스킴을
     * 검증하고 실패를 `catch`로 잡아 "링크 형식 아님"으로 떨어뜨린다. 컨텍스트에 `URL`이
     * 없으면 그 `catch`가 **`ReferenceError`를 삼켜** 정상 https 출처까지 거부된 것처럼 보인다.
     * `javascript:` 케이스만 단언했다면 **엉뚱한 이유로 통과**했을 것이다 — 반대 축(https가
     * 링크가 되는가)을 함께 태워야 이 결함이 드러난다.
     */
    URL,
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

  /**
   * #3 카운트 축 — B3 D-2. 이전 형식은 `matched.length + " / " + VM.assets.length`였고,
   * 필터가 없으면 두 값이 같아 화면에 "5 / 5건"이 뜨는데 그려진 행은 2개였다. **어느 숫자도
   * 화면과 맞지 않는데 슬래시가 그 사실을 감췄다.**
   *
   * 이제 세 수에 각자 이름이 붙는다. 픽스처(부모 P + 자식 C1·C2·C3 + 독립 A):
   *   - `q="needle"` → 매치 2(C1·C2) · 최상위 1(P) · 전체 5
   *   - 필터 없음     → 최상위 2(P·A) · 전체 5   ← 매치는 표시하지 않는다
   */
  it("#3a 필터가 걸리면 매치·최상위·전체 셋을 각자 이름과 함께 말한다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildFixtureViewModel());
    byId.get("q")!.value = "needle";
    renderAssets();
    expect(byId.get("filter-count")!.textContent).toBe("매치 2건 · 최상위 1건 · 전체 5건");
  });

  it("#3b 필터가 없으면 매치를 빼고 둘만 말한다 — 매치는 전체와 같아 아무것도 알려주지 않는다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildFixtureViewModel());
    renderAssets();
    expect(byId.get("filter-count")!.textContent).toBe("최상위 2건 · 전체 5건");
  });

  it("#3c 종류 필터만 걸어도 '필터가 걸린' 형식이다 — 필터는 검색어만이 아니다", async () => {
    // ⚠️ `q`만 보고 갈랐다면 이 화면에서만 매치 수가 사라져 두 수가 다시 뭉개진다.
    // 픽스처에서 kind="agent"인 것은 C1(needle-one)·C3(unrelated-sub) 둘이고 둘 다 자식이라
    // 컨테이너로 끌려온 부모 P 하나가 최상위가 된다.
    const { byId, renderAssets } = await bootWithViewModel(buildFixtureViewModel());
    byId.get("kind")!.value = "agent";
    renderAssets();
    expect(byId.get("filter-count")!.textContent).toBe("매치 2건 · 최상위 1건 · 전체 5건");
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

/**
 * ─────────────────────────────────────────────────────────────────────────
 * B3 Step 3a — 목록 열 구조 (7열 → 5열)
 *
 * ⚠️ **이 절이 생기기 전, 열을 7개에서 5개로 줄여도 159개 테스트가 하나도 깨지지 않았다.**
 * 열 구조·설치 칸·MCP 칩·출처 칸을 태우는 테스트가 **하나도 없었다**는 뜻이다. 여기서 채운다.
 *
 * 아래 픽스처는 기존 계층 픽스처와 **모집단이 다르다** — `mcp_enabled_state`와 `repo_*`를
 * 실제로 담는다. 기존 픽스처는 그 필드가 전부 `null`이라 `mcpBadge`의 비어있지 않은 분기와
 * `repoCell`의 링크 분기가 **한 번도 실행된 적이 없었다**(미실행 경로).
 * ─────────────────────────────────────────────────────────────────────────
 */
function buildCellFixtureViewModel() {
  const mk = (over: Record<string, unknown>) =>
    parseAsset({ schema_version: 1, _scope: "machine_independent", ...over });

  const assets = [
    // MCP — 상태가 `unknown`(원본이 null)
    mk({ id: "synth-mcp-unknown", kind: "mcp", name: "synth-mcp-unknown" }),
    // MCP — 상태가 `unset`(설정 안 됨). ⚠️ 위와 **다른 배지**여야 한다
    mk({ id: "synth-mcp-unset", kind: "mcp", name: "synth-mcp-unset" }),
    // 출처 4갈래
    mk({ id: "synth-repo-none", kind: "skill", name: "synth-repo-none" }),
    mk({ id: "synth-repo-local", kind: "skill", name: "synth-repo-local", repo_source: "directory" }),
    mk({
      id: "synth-repo-https",
      kind: "skill",
      name: "synth-repo-https",
      repo_source: "github",
      repo_url: "https://example.invalid/synthetic/repo",
    }),
    mk({
      id: "synth-repo-bad",
      kind: "skill",
      name: "synth-repo-bad",
      repo_source: "git",
      repo_url: "javascript:alert(1)",
    }),
    // 부모 없는 자식 → inherited_unavailable
    // ⚠️ id는 `<parent_asset_id>:<suffix>` 형태여야 한다(zod가 강제한다 — `as Asset` 캐스팅
    // 금지 규칙이 이 픽스처를 처음 쓸 때 바로 잡아냈다). 부모는 카탈로그에 **없다**.
    mk({
      id: "synth-absent-parent:orphan-child",
      kind: "agent",
      name: "synth-orphan-child",
      parent_asset_id: "synth-absent-parent",
    }),
  ];

  const inst = (assetId: string, over: Record<string, unknown> = {}) => ({
    schema_version: 1 as const,
    _scope: "machine_dependent" as const,
    machine_id: "synthetic-machine",
    asset_id: assetId,
    install_scope: "user" as const,
    enabled_at: "project" as const,
    project_path_hash: null,
    mcp_enabled_state: null,
    mcp_state_source: null,
    ...over,
  });

  return JSON.parse(
    JSON.stringify(
      buildConsoleViewModel({
        machineId: "synthetic-machine",
        projects: [],
        projectsUnavailable: null,
        assets,
        installations: [
          inst("synth-mcp-unknown"), // mcp_enabled_state: null → 뷰에서 "unknown"
          inst("synth-mcp-unset", { mcp_enabled_state: "unset", mcp_state_source: "none" }),
          inst("synth-repo-none"),
          inst("synth-repo-local"),
          inst("synth-repo-https"),
          inst("synth-repo-bad"),
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

/** 이름으로 행을 집는다 — 정렬 순서에 기대지 않는다. */
function rowByName(byId: Map<string, El>, name: string): El {
  const hit = byId.get("assets-body")!.children.find((tr) => tr.children[0]!.textContent.includes(name));
  if (hit === undefined) throw new Error(`행을 찾지 못했다: ${name}`);
  return hit;
}

describe("B3 Step 3a — 목록 열 구조", () => {
  it("thead가 5열이고 이름·종류·설치·출처·문서다", () => {
    const head = /<thead><tr>\s*([\s\S]*?)<\/tr><\/thead>/.exec(UI_HTML);
    expect(head, "thead를 찾지 못했다").toBeTruthy();
    const ths = [...(head![1] ?? "").matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(ths).toEqual(["이름", "종류", "설치", "출처", "문서"]);
  });

  it("데이터 행의 td 수가 thead와 같다 — 열이 어긋나면 표가 밀린다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildCellFixtureViewModel());
    renderAssets();
    for (const tr of byId.get("assets-body")!.children) {
      expect(tr.children.length, `행 "${tr.children[0]!.textContent}"의 칸 수가 5가 아니다`).toBe(5);
    }
  });
});

describe("B3 Step 3a — 설치 칸: 병합이지 융합이 아니다", () => {
  it("스코프와 활성이 **각각 다른 노드**로 들어간다 — 한 문자열로 이어붙이지 않는다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildCellFixtureViewModel());
    renderAssets();
    const installTd = rowByName(byId, "synth-repo-none").children[2]!;
    expect(installTd.children.length, "설치 칸이 두 노드가 아니다 — 두 축이 뭉개졌다").toBe(2);
    expect(installTd.children[0]!.textContent).toBe("user");
    expect(installTd.children[1]!.textContent).toBe("활성: project");
  });

  it("상속 판정 불가는 한 노드 + 판정불가 배지다 — '미설치'로 읽히면 안 된다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildCellFixtureViewModel());
    // 부모가 카탈로그에 없는 자식은 접힘 기본에서 안 보인다(부모 행이 없어 펼칠 수단이 없다).
    // 검색으로 끌어낸다 — 이 경로가 "조용히 사라지게 두지 않는다"의 자리다.
    byId.get("q")!.value = "orphan";
    renderAssets();
    const installTd = rowByName(byId, "synth-orphan-child").children[2]!;
    expect(installTd.children.length).toBe(1);
    expect(installTd.children[0]!.className).toContain("b-unknown");
    expect(installTd.textContent).toBe("상속 정보 확인 불가");
    expect(installTd.textContent, "'미설치'라고 쓰면 '없음'과 '판정 불가'가 뭉개진다").not.toContain("미설치");
  });
});

describe("B3 Step 3a — MCP 칩은 종류 칸에 흡수됐다 (D-8)", () => {
  it("mcp가 아닌 행에는 칩이 없다 — 빈 배지가 반복되던 열이 사라졌다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildCellFixtureViewModel());
    renderAssets();
    const kindTd = rowByName(byId, "synth-repo-none").children[1]!;
    expect(kindTd.children.length, "mcp가 아닌데 칩이 붙었다").toBe(1);
    expect(kindTd.textContent).toBe("skill");
  });

  it("unknown과 unset을 **다른 배지**로 칠한다 — 이 분기는 지금까지 실행된 적이 없었다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildCellFixtureViewModel());
    renderAssets();
    const unknown = rowByName(byId, "synth-mcp-unknown").children[1]!;
    const unset = rowByName(byId, "synth-mcp-unset").children[1]!;

    expect(unknown.children.length, "mcp 행에 상태 칩이 없다").toBe(2);
    expect(unset.children.length).toBe(2);

    const chipU = unknown.children[1]!;
    const chipS = unset.children[1]!;
    expect(chipU.textContent).toBe("모름");
    expect(chipS.textContent).toBe("설정 안 됨");
    expect(chipU.className, "모름과 설정 안 됨이 같은 클래스다 — 두 사실이 뭉개졌다").not.toBe(chipS.className);
    expect(chipU.className).toContain("b-unknown");
    expect(chipS.className).toContain("b-unset");
  });
});

describe("B3 Step 3a — 출처 칸 4갈래 (지금까지 링크 분기는 미실행이었다)", () => {
  it("출처가 없으면 대시, 로컬이면 링크가 아니라 '로컬'이라고 적는다", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildCellFixtureViewModel());
    renderAssets();
    expect(rowByName(byId, "synth-repo-none").children[3]!.textContent).toBe("—");
    const local = rowByName(byId, "synth-repo-local").children[3]!;
    expect(local.textContent).toBe("로컬(directory)");
    expect(local.children.length, "로컬 출처에 링크를 만들면 죽은 링크가 된다").toBe(0);
  });

  it("https는 링크가 되고 javascript: 는 링크가 되지 않는다 (심사 H3 회귀)", async () => {
    const { byId, renderAssets } = await bootWithViewModel(buildCellFixtureViewModel());
    renderAssets();
    const ok = rowByName(byId, "synth-repo-https").children[3]!;
    expect(ok.children.length, "https 출처가 링크로 렌더되지 않았다").toBe(1);
    expect(ok.children[0]!.tag).toBe("a");
    expect(ok.textContent).toBe("GitHub");

    const bad = rowByName(byId, "synth-repo-bad").children[3]!;
    expect(bad.children.length, "javascript: URI가 링크로 렌더됐다 — 클릭 한 번에 실행된다").toBe(0);
    expect(bad.textContent).toBe("링크 형식 아님(git)");
  });
});

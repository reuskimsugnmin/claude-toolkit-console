import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildConsoleViewModel } from "@ctk/core";
import { buildUiPage } from "../server/ui-page.js";
import { createElClass } from "./helpers/dom-stub.js";

/**
 * web/test/ui-visibility.test.ts — B3 Step 1 (D-1). **가시성 축은 클래스가 아니라 속성이다.**
 *
 * ## 무엇이 결함이었나
 *
 * `.hidden{display:none}`이 `.actions{display:flex}` 바로 앞에 있었고 **둘 다 클래스 선택자
 * 하나**라 명시도가 동률이었다. CSS는 동률이면 소스 순서상 뒤를 택하므로
 * `<div class="actions hidden">`의 계산된 `display`는 **flex**였다 — 조회 모드인데 액션 바가
 * 보였다(브라우저 실측 높이 54.6px). 대조군: 맨 `.hidden` div와 `#view-detail`은 정상적으로
 * `none`이었다. 즉 `.hidden`이 고장난 게 아니라 **`.actions`와 겹칠 때만** 졌다.
 *
 * ## 왜 기존 테스트가 못 잡았나
 *
 * `readonly-server.test.ts`가 `<div class="actions hidden" id="action-bar">`라는 **문자열이
 * 있는지**만 봤다. 클래스가 실제로 요소를 숨기는지는 보지 않았다 — CLAUDE.md의
 * *"규칙 존재 ≠ 규칙이 막음"* 그 자리다.
 *
 * ## 이 파일이 지키는 것과 못 지키는 것
 *
 * ⚠️ **`node:vm` 하네스에는 CSS 엔진이 없다.** 계산된 스타일을 볼 수 없으므로 "실제로 보이는가"는
 * 여기서 판정할 수 없다 — 그 축은 브라우저 검증 1회가 본다. 여기서 지키는 것은 둘이다:
 *
 * 1. **구조 불변식**(문자열) — 스타일시트에 가시성용 클래스 선택자가 아예 없고, `[hidden]`
 *    규칙이 정확히 하나이며 `!important`를 가진다. 이것이 참이면 명시도 경쟁 자체가 성립하지
 *    않는다(결함의 **종**을 없앤다).
 * 2. **실행 한 쌍**(대조군 포함) — 토큰 없이 부팅하면 액션 바가 숨은 채로 남고, 토큰이 있으면
 *    드러난다. 한쪽만 단언하면 "항상 숨김"·"항상 노출"과 구별되지 않는다.
 */

const El = createElClass({ textJoin: "\n" });
type El = InstanceType<typeof El>;

const UI_HTML = buildUiPage("n".repeat(22));

function extractScript(html: string): string {
  const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  if (match === null) throw new Error("UI에서 script 태그를 찾지 못했다");
  return match[1] ?? "";
}

function extractStyle(html: string): string {
  const match = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (match === null) throw new Error("UI에서 style 태그를 찾지 못했다");
  return match[1] ?? "";
}

/**
 * ⚠️ **범위를 코드 축으로 좁힌다.** 이 파일이 검사하는 패턴을 **설명하는 주석**이 `ui-page.ts`에
 * 있다(왜 `!important`인지를 남기려면 옛 코드를 인용할 수밖에 없다). 주석을 걷어내지 않으면
 * 게이트가 **자기 규칙을 적은 문장에 반응한다** — 그건 신호가 아니라 잡음이다(CLAUDE.md 안전
 * 원칙 6). CSS에는 블록 주석뿐이라 이 제거로 충분하다.
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 마크업에서 해당 id를 가진 태그가 **맨 불리언 속성**(`hidden`·`disabled`)을 갖는지 읽는다.
 *
 * ⚠️ **이 유도가 이 파일의 핵심이다.** DOM 스텁은 HTML을 파싱하지 않으므로 속성의 초기값이
 * 반영되지 않고, 스텁의 기본값은 둘 다 `false`다. 시드를 **하드코딩하면** `ui-page.ts`에서
 * 속성을 지워도 테스트가 그대로 통과한다 — 공허한 단언이 된다. 마크업에서 읽어오면 속성이
 * 사라지는 순간 시드가 `false`가 되고 아래 "토큰 없으면 숨은 채로 남는다"가 깨진다.
 */
function markupHasBareAttr(html: string, id: string, attr: "hidden" | "disabled"): boolean {
  const tag = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(html);
  if (tag === null) throw new Error(`마크업에서 id="${id}" 태그를 찾지 못했다`);
  return new RegExp(`\\s${attr}(\\s|>)`).test(tag[0]);
}

const markupStartsHidden = (html: string, id: string): boolean => markupHasBareAttr(html, id, "hidden");

/**
 * 부팅 전에 미리 만들어 둘 요소들.
 *
 * ⚠️ **왜 필요한가** — 조회 모드에서 스크립트는 `#action-bar`를 **한 번도 건드리지 않는다**
 * (`SESSION_TOKEN !== null` 블록 안에만 있다). 그 자체는 옳은 동작이지만, 스텁 맵은
 * 접근된 적 없는 id를 만들지 않으므로 단언 대상이 `undefined`가 된다. 미리 만들어 두면
 * 단언의 의미가 **"부팅이 이 값을 바꾸지 않았다"**로 정확해진다.
 */
const SEEDED_IDS = ["action-bar", "btn-scan", "btn-gen", "btn-rollback", "view-assets", "view-detail", "view-usage"];

function minimalViewModel(): unknown {
  return JSON.parse(
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
}

/** 스크립트를 부팅한다. `hash`에 토큰을 넣으면 액션 모드가 된다. */
async function boot(hash: string): Promise<{ byId: Map<string, El>; ctx: Record<string, unknown> }> {
  const byId = new Map<string, El>();
  const el = (id: string): El => {
    if (!byId.has(id)) {
      const created = new El(id);
      // 마크업의 맨 불리언 속성을 스텁 초기값으로 옮긴다(위 주석 참조).
      created.hidden = markupHasBareAttr(UI_HTML, id, "hidden");
      created.disabled = markupHasBareAttr(UI_HTML, id, "disabled");
      byId.set(id, created);
    }
    return byId.get(id) as El;
  };
  for (const id of SEEDED_IDS) el(id);

  const ctx: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => el(id),
      createElement: (tag: string) => new El(tag),
      querySelectorAll: () => [],
      querySelector: () => new El("main"),
    },
    location: { hash, pathname: "/" },
    history: { replaceState: () => {} },
    URLSearchParams,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(minimalViewModel()) }),
    console,
  };
  vm.createContext(ctx);
  new vm.Script(extractScript(UI_HTML)).runInContext(ctx);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { byId, ctx };
}

describe("D-1 구조 불변식 — 명시도 경쟁이 성립할 수 없다", () => {
  it("스타일시트에 가시성용 클래스 선택자(.hidden)가 없다", () => {
    const css = stripCssComments(extractStyle(UI_HTML));
    expect(css, "`.hidden` 클래스 규칙이 남아 있으면 다시 명시도 경쟁이 생긴다").not.toMatch(/\.hidden\b/);
  });

  it("[hidden] 규칙이 정확히 하나이고 !important를 가진다", () => {
    const css = stripCssComments(extractStyle(UI_HTML));
    const rules = css.match(/\[hidden\]\s*\{[^}]*\}/g) ?? [];
    expect(rules.length, `[hidden] 규칙이 ${rules.length}개다 — 하나여야 한다`).toBe(1);
    expect(rules[0], "!important가 없으면 레이아웃 규칙에 질 수 있다").toMatch(/display:\s*none\s*!important/);
  });

  it("스크립트가 'hidden' 클래스를 조작하지 않는다", () => {
    const script = extractScript(UI_HTML);
    expect(script, "classList로 hidden을 다루면 속성 축과 클래스 축이 갈린다").not.toMatch(
      /classList\.(add|remove|toggle|contains)\(\s*["']hidden/,
    );
  });

  it("이 검사가 공허하지 않다 — 위 세 정규식은 위반 문자열을 실제로 잡는다", () => {
    // 대조군. 규칙이 아무것도 막지 않으면 신호가 아니다(CLAUDE.md).
    expect(stripCssComments("  .hidden { display: none; }")).toMatch(/\.hidden\b/);
    expect("[hidden] { display: none; }").not.toMatch(/display:\s*none\s*!important/);
    expect('$("view-usage").classList.add("hidden");').toMatch(/classList\.(add|remove|toggle|contains)\(\s*["']hidden/);
    // 그리고 주석 제거가 실제로 동작한다(잡음 축).
    expect(stripCssComments("/* .hidden 은 옛 규칙이다 */ [hidden]{}")).not.toMatch(/\.hidden\b/);
  });
});

describe("D-1 마크업 — 숨김은 속성으로 시작한다", () => {
  it("액션 바·상세·사용량이 hidden 속성으로 시작한다", () => {
    expect(markupStartsHidden(UI_HTML, "action-bar"), "액션 바가 hidden 없이 시작한다").toBe(true);
    expect(markupStartsHidden(UI_HTML, "view-detail"), "상세가 hidden 없이 시작한다").toBe(true);
    expect(markupStartsHidden(UI_HTML, "view-usage"), "사용량이 hidden 없이 시작한다").toBe(true);
  });

  it("자산 목록은 반대 축이다 — 처음부터 보인다", () => {
    expect(markupStartsHidden(UI_HTML, "view-assets"), "목록까지 숨으면 첫 화면이 비어 보인다").toBe(false);
  });
});

describe("D-1 실행 — 토큰 유무로 액션 바가 갈린다 (대조군 포함)", () => {
  it("토큰이 없으면 액션 바가 숨은 채로 남고 버튼도 잠겨 있다", async () => {
    const { byId } = await boot("");
    expect(byId.get("action-bar")!.hidden, "조회 모드인데 액션 바가 드러났다 — D-1의 재발이다").toBe(true);
    expect(byId.get("btn-scan")!.disabled, "조회 모드에서 버튼 잠금이 풀렸다").toBe(true);
  });

  it("토큰이 있으면 액션 바가 드러나고 버튼 잠금이 풀린다 — 위 케이스가 '항상 숨김'과 구별된다", async () => {
    const { byId } = await boot("#token=synthetic-session-token");
    expect(byId.get("action-bar")!.hidden, "액션 모드인데 액션 바가 숨어 있다").toBe(false);
    expect(byId.get("btn-scan")!.disabled, "액션 모드인데 버튼이 잠긴 채다 — boot가 잠금을 풀어야 한다").toBe(false);
  });
});

describe("showTab — 지금까지 파싱만 되고 실행된 적이 없던 경로", () => {
  it("사용량 탭으로 전환하면 목록·상세가 숨고 사용량만 보인다", async () => {
    const { byId, ctx } = await boot("");
    const showTab = ctx["showTab"] as ((which: string) => void) | undefined;
    expect(showTab, "showTab이 스크립트에서 노출돼야 이 경로를 실행할 수 있다").toBeTypeOf("function");

    showTab!("usage");
    expect(byId.get("view-assets")!.hidden).toBe(true);
    expect(byId.get("view-usage")!.hidden).toBe(false);
    expect(byId.get("view-detail")!.hidden).toBe(true);
  });

  it("자산 탭으로 되돌리면 반대가 된다 — 한 방향만 보면 '항상 같은 값'과 구별되지 않는다", async () => {
    const { byId, ctx } = await boot("");
    const showTab = ctx["showTab"] as (which: string) => void;
    showTab("usage");
    showTab("assets");
    expect(byId.get("view-assets")!.hidden).toBe(false);
    expect(byId.get("view-usage")!.hidden).toBe(true);
    expect(byId.get("view-detail")!.hidden).toBe(true);
  });

  it("같은 탭을 두 번 눌러도 뒤집히지 않는다", async () => {
    // ⚠️ 옛 구현은 `classList.toggle("hidden", cond)`였고, DOM 스텁 4벌이 **두 번째 인자를
    // 무시**했다. 실제 DOM은 force를 존중하므로 스텁이 실제와 다르게 동작했는데, 유일한
    // 호출자인 showTab에 실행 커버리지가 없어 아무도 몰랐다. 불리언 대입은 이 축이 아예 없다.
    const { byId, ctx } = await boot("");
    const showTab = ctx["showTab"] as (which: string) => void;
    showTab("usage");
    showTab("usage");
    expect(byId.get("view-usage")!.hidden, "같은 탭을 두 번 눌렀더니 사용량이 사라졌다").toBe(false);
    expect(byId.get("view-assets")!.hidden).toBe(true);
  });
});

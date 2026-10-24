import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildConsoleViewModel, parseAsset } from "@ctk/core";
import { buildUiPage } from "../server/ui-page.js";
import { createElClass } from "./helpers/dom-stub.js";

/**
 * web/test/ui-description.test.ts — 원문 frontmatter `description`을 목록·상세에 표시한다.
 * 뷰 모델에는 실려 있었는데 UI가 한 번도 그리지 않아, 생성 문서가 없는 자산(정책 차단·미생성·번들 자식)은
 * 무엇을 하는지 한 줄도 보이지 않았다. 문자열로 조립한 UI라 `<script>`를 뽑아 **실제로 실행해** 본다.
 */
const El = createElClass({ textJoin: "\n" });
type El = InstanceType<typeof El>;

const DESC = "Synthetic one-liner that says what this tool does.";

function viewModel(): { assets: Array<{ id: string }> } {
  const withDesc = parseAsset({ schema_version: 1, _scope: "machine_independent", id: "synth-described", kind: "skill", name: "synth-described", description: DESC });
  const noDesc = parseAsset({ schema_version: 1, _scope: "machine_independent", id: "synth-plain", kind: "skill", name: "synth-plain" });
  return JSON.parse(
    JSON.stringify(
      buildConsoleViewModel({
        machineId: "synthetic-machine",
        projects: [],
        projectsUnavailable: null,
        assets: [withDesc, noDesc],
        installations: [],
        occupancy: [],
        usage: [],
        lastScanAt: null,
        docPresence: new Map(),
        unusedExpensiveLimit: 5,
        now: new Date("2026-10-25T00:00:00.000Z"),
      }),
    ),
  ) as { assets: Array<{ id: string }> };
}

async function boot(vmData: unknown) {
  const byId = new Map<string, El>();
  const el = (id: string): El => {
    if (!byId.has(id)) byId.set(id, new El(id));
    return byId.get(id)!;
  };
  const ctx: Record<string, unknown> = {
    document: { getElementById: el, createElement: (tag: string) => new El(tag), querySelectorAll: () => [], querySelector: () => new El("main") },
    location: { hash: "", pathname: "/" },
    history: { replaceState: () => {} },
    URLSearchParams,
    URL,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(vmData) }),
    console,
  };
  vm.createContext(ctx);
  const html = buildUiPage("n".repeat(22));
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(script).toBeTypeOf("string");
  new vm.Script(script!).runInContext(ctx);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { byId, ctx };
}

describe("원문 description 표시", () => {
  it("목록 — 설명이 있는 자산은 이름 아래 그 한 줄이 보이고, 없는 자산엔 빈 값이 새지 않는다", async () => {
    const { byId, ctx } = await boot(viewModel());
    (ctx["renderAssets"] as () => void)();
    const text = byId.get("assets-body")!.textContent;
    expect(text).toContain(DESC);
    expect(text).toContain("synth-plain");
    expect(text).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  it("상세 — 출처를 밝힌 라벨과 함께 보인다(생성 문서와 구분)", async () => {
    const data = viewModel();
    const { byId, ctx } = await boot(data);
    (ctx["renderDetailMeta"] as (a: unknown) => void)(data.assets.find((a) => a.id === "synth-described"));
    const text = byId.get("detail-meta-grid")!.textContent;
    expect(text).toContain("설명 (원문 frontmatter)");
    expect(text).toContain(DESC);
  });

  it("반대 축 — 설명이 없으면 상세에 그 행이 없다", async () => {
    const data = viewModel();
    const { byId, ctx } = await boot(data);
    (ctx["renderDetailMeta"] as (a: unknown) => void)(data.assets.find((a) => a.id === "synth-plain"));
    expect(byId.get("detail-meta-grid")!.textContent).not.toContain("설명 (원문 frontmatter)");
  });
});

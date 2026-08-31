import { describe, expect, it } from "vitest";
import {
  DOC_REF_EXCEPTIONS,
  findUnusedDocRefExceptions,
  lookupKeyFor,
} from "../src/workflow-doc/exceptions.js";
import { buildTupleIndex, tupleKey, type IndexRowForLookup } from "../src/workflow-doc/index-3tuple.js";
import {
  describeOutcome,
  exitCodeContribution,
  resolveWorkflowAssets,
  type CatalogState,
  type DescriptionLookup,
} from "../src/workflow-doc/resolve.js";
import { formatSummary, summarizeOutcomes } from "../src/workflow-doc/summary.js";
import type { AssetRef } from "../src/workflow-doc/table-locate.js";

function ref(kindLabel: "Skill" | "Agent", plugin: string, name: string): AssetRef {
  return { kindLabel, plugin, name, raw: `${kindLabel}(${plugin}:${name})` };
}

function row(kind: IndexRowForLookup["kind"], name: string, plugin: string): IndexRowForLookup {
  return { id: `${plugin}@market:${kind}:${name}`, kind, name, parent_asset_id: `${plugin}@market` };
}

const found = (description: string): DescriptionLookup => ({ kind: "found", description });
const always = (lookup: DescriptionLookup) => () => lookup;

/**
 * ⚠️ **§2.1의 동명 충돌은 합성이 아니라 실측이다.** 표의 21자산 중 5건이 `(kind, name)`으로는
 * 후보가 둘 이상이다 — 충돌 상대가 하필 문서가 「쓰지 않는 것」으로 적어 둔 플러그인들이다.
 * 아래 픽스처는 그 구조를 그대로 본뜬다.
 */
const COLLIDING: readonly IndexRowForLookup[] = [
  row("agent", "code-reviewer", "oh-my-claudecode"),
  row("agent", "code-reviewer", "pr-review-toolkit"),
  row("agent", "code-reviewer", "feature-dev"),
  row("agent", "code-simplifier", "oh-my-claudecode"),
  row("agent", "code-simplifier", "pr-review-toolkit"),
];

describe("3튜플 색인 — 2튜플이면 모호한 것이 3튜플로 붙는다 (C-1)", () => {
  it("**대조**: 플러그인 축이 없으면 후보가 여럿, 있으면 정확히 1건", () => {
    const index = buildTupleIndex(COLLIDING);

    // (kind, name)만으로 세면 `code-reviewer`는 3건이다 — 2튜플이었다면 ambiguous였다.
    const byKindName = COLLIDING.filter((r) => r.kind === "agent" && r.name === "code-reviewer");
    expect(byKindName).toHaveLength(3);

    // 3튜플은 정확히 1건으로 좁힌다.
    // ⚠️ 키 문자열을 하드코딩하지 않는다 — 구현이 소유한 형식의 **사본**이 되어,
    // 구분자를 바꾸는 순간 테스트가 조용히 어긋난다(실제로 처음에 그렇게 짰다가 걸렸다).
    expect(index.byTuple.get(tupleKey("agent", "oh-my-claudecode", "code-reviewer"))).toHaveLength(1);
    expect(index.byTuple.get(tupleKey("agent", "pr-review-toolkit", "code-reviewer"))).toHaveLength(1);
  });

  it("실제 참조가 `resolved`가 된다 — 이것이 3튜플이 값을 한 지점이다", () => {
    const catalog: CatalogState = { kind: "available", rows: COLLIDING };
    const result = resolveWorkflowAssets(
      [ref("Agent", "oh-my-claudecode", "code-reviewer"), ref("Agent", "oh-my-claudecode", "code-simplifier")],
      catalog,
      always(found("설명")),
    );
    expect(result.outcomes.map((o) => o.tag)).toEqual(["resolved", "resolved"]);
  });

  it("**같은 플러그인 안의 동명 2건**은 `ambiguous`다 — 플러그인 축을 믿지 않는다", () => {
    const rows: IndexRowForLookup[] = [
      { id: "omc@market:agent:dup#1", kind: "agent", name: "dup", parent_asset_id: "omc@market" },
      { id: "omc@market:agent:dup#2", kind: "agent", name: "dup", parent_asset_id: "omc@market" },
    ];
    const result = resolveWorkflowAssets([ref("Agent", "omc", "dup")], { kind: "available", rows }, always(found("x")));
    expect(result.outcomes[0]?.tag).toBe("ambiguous");
    expect(result.outcomes[0]).toMatchObject({ candidates: ["omc@market:agent:dup#1", "omc@market:agent:dup#2"] });
  });

  it("무부모 행은 색인 밖이고 **건수가 보인다** — 막지 않되 보이게 한다", () => {
    const rows: IndexRowForLookup[] = [row("agent", "a", "omc"), { id: "solo", kind: "skill", name: "solo" }];
    const result = resolveWorkflowAssets([ref("Agent", "omc", "a")], { kind: "available", rows }, always(found("x")));
    expect(result.parentlessRows).toBe(1);
  });
});

describe("6갈래 판별 유니온 — 각 갈래에 테스트가 있다", () => {
  const catalog: CatalogState = { kind: "available", rows: [row("agent", "executor", "omc")] };

  it("`resolved`", () => {
    const r = resolveWorkflowAssets([ref("Agent", "omc", "executor")], catalog, always(found("설명")));
    expect(r.outcomes[0]).toMatchObject({ tag: "resolved", description: "설명" });
  });

  it("`not_installed` — 후보 0건", () => {
    const r = resolveWorkflowAssets([ref("Agent", "omc", "없는것")], catalog, always(found("x")));
    expect(r.outcomes[0]?.tag).toBe("not_installed");
  });

  it("`no_catalog`와 `index_corrupted`를 **합치지 않는다**", () => {
    const refs = [ref("Agent", "omc", "executor")];
    expect(resolveWorkflowAssets(refs, { kind: "absent" }, always(found("x"))).outcomes[0]?.tag).toBe("no_catalog");
    expect(resolveWorkflowAssets(refs, { kind: "corrupted" }, always(found("x"))).outcomes[0]?.tag).toBe(
      "index_corrupted",
    );
    // 카탈로그를 못 읽었으면 무부모 행 수는 **0이 아니라 `null`**이다.
    expect(resolveWorkflowAssets(refs, { kind: "absent" }, always(found("x"))).parentlessRows).toBeNull();
  });

  it("`no_description`의 두 하위축을 가른다 — `\"\"`와 필드 부재는 다른 사건이다 (D-2)", () => {
    const refs = [ref("Agent", "omc", "executor")];
    expect(resolveWorkflowAssets(refs, catalog, always({ kind: "empty_string" })).outcomes[0]).toMatchObject({
      tag: "no_description",
      reason: "empty_string",
    });
    expect(resolveWorkflowAssets(refs, catalog, always({ kind: "field_absent" })).outcomes[0]).toMatchObject({
      tag: "no_description",
      reason: "field_absent",
    });
  });

  it("종료 코드 기여가 갈래마다 다르다 — `ambiguous`는 3(구조적 실패)이고 2(미측정)와 합치지 않는다", () => {
    const r = ref("Agent", "omc", "x");
    expect(exitCodeContribution({ tag: "resolved", ref: r, assetId: "i", description: "d" })).toBe(0);
    expect(exitCodeContribution({ tag: "not_installed", ref: r })).toBe(1);
    expect(exitCodeContribution({ tag: "no_catalog", ref: r })).toBe(2);
    expect(exitCodeContribution({ tag: "ambiguous", ref: r, candidates: ["a", "b"] })).toBe(3);
  });

  it("각 갈래가 서로 다른 셀 문구를 낸다 — 표시가 값을 다시 뭉개지 않는다 (R12)", () => {
    const r = ref("Agent", "omc", "x");
    const texts = [
      describeOutcome({ tag: "resolved", ref: r, assetId: "i", description: "설명" }),
      describeOutcome({ tag: "no_catalog", ref: r }),
      describeOutcome({ tag: "index_corrupted", ref: r }),
      describeOutcome({ tag: "not_installed", ref: r }),
      describeOutcome({ tag: "no_description", ref: r, assetId: "i", reason: "empty_string" }),
      describeOutcome({ tag: "ambiguous", ref: r, candidates: [] }),
    ];
    expect(new Set(texts).size).toBe(6);
    expect(describeOutcome({ tag: "not_installed", ref: r })).toContain("마지막 스캔 시점");
  });
});

describe("표기 예외 맵 — 정확히 2건, 미사용은 에러", () => {
  it("`Skill(oh-my-claudecode:plan)`이 `omc-plan`으로 조회된다", () => {
    expect(lookupKeyFor(ref("Skill", "oh-my-claudecode", "plan")).key).toEqual({
      kind: "skill",
      pluginName: "oh-my-claudecode",
      name: "omc-plan",
    });
  });

  it("`revise-claude-md`는 문서상 Skill이지만 kind는 command다", () => {
    expect(lookupKeyFor(ref("Skill", "claude-md-management", "revise-claude-md")).key.kind).toBe("command");
  });

  it("예외가 없으면 기본 매핑을 쓴다", () => {
    expect(lookupKeyFor(ref("Agent", "omc", "executor")).key).toEqual({
      kind: "agent",
      pluginName: "omc",
      name: "executor",
    });
  });

  it("**미사용 예외를 찾아낸다** — 상류가 바뀌면 예외도 사라져야 한다", () => {
    expect(findUnusedDocRefExceptions([])).toHaveLength(DOC_REF_EXCEPTIONS.length);
    const allUsed = DOC_REF_EXCEPTIONS.map((e) => ref(e.from.kindLabel, e.from.plugin, e.from.name));
    expect(findUnusedDocRefExceptions(allUsed)).toEqual([]);
  });

  it("맵이 4건을 넘지 않는다 — 넘으면 예외를 키울 게 아니라 축을 만든다 (ROADMAP §10 신호 1)", () => {
    expect(DOC_REF_EXCEPTIONS.length).toBeLessThanOrEqual(4);
  });
});

describe("요약 — 값을 갈라 놓고 요약이 뭉개지 않는다", () => {
  it("합이 입력 건수와 같다 — 개별 카운터만 보면 '어디에도 안 잡힘'이 통과한다", () => {
    const rows = [row("agent", "executor", "omc")];
    const refs = [ref("Agent", "omc", "executor"), ref("Agent", "omc", "없는것")];
    const summary = summarizeOutcomes(resolveWorkflowAssets(refs, { kind: "available", rows }, always(found("d"))));
    const sum =
      summary.resolved +
      summary.noCatalog +
      summary.indexCorrupted +
      summary.notInstalled +
      summary.noDescription +
      summary.ambiguous +
      summary.descriptionUnreadable;
    expect(sum).toBe(summary.total);
  });

  it("종료 코드는 자산 전체의 **max**로 접힌다", () => {
    const rows: IndexRowForLookup[] = [
      row("agent", "ok", "omc"),
      { id: "d1", kind: "agent", name: "dup", parent_asset_id: "omc@market" },
      { id: "d2", kind: "agent", name: "dup", parent_asset_id: "omc@market" },
    ];
    const refs = [ref("Agent", "omc", "ok"), ref("Agent", "omc", "dup")];
    expect(summarizeOutcomes(resolveWorkflowAssets(refs, { kind: "available", rows }, always(found("d")))).exitCode).toBe(3);
  });

  it("**미측정을 0으로 보이게 만들지 않는다** — 전부 `no_catalog`면 그 사실을 먼저 말한다", () => {
    const refs = [ref("Agent", "omc", "a"), ref("Agent", "omc", "b")];
    const text = formatSummary(summarizeOutcomes(resolveWorkflowAssets(refs, { kind: "absent" }, always(found("d")))));
    expect(text).toContain("미측정");
    expect(text).not.toContain("미설치 2");
  });

  it("`no_description` 두 하위축을 요약이 따로 낸다", () => {
    const rows = [row("agent", "a", "omc"), row("agent", "b", "omc")];
    const refs = [ref("Agent", "omc", "a"), ref("Agent", "omc", "b")];
    const result = resolveWorkflowAssets(refs, { kind: "available", rows }, (id) =>
      id.endsWith("a") ? { kind: "empty_string" } : { kind: "field_absent" },
    );
    const summary = summarizeOutcomes(result);
    expect(summary.noDescriptionEmptyString).toBe(1);
    expect(summary.noDescriptionFieldAbsent).toBe(1);
    expect(formatSummary(summary)).toContain("빈문자열 1 · 필드부재 1");
  });
});

describe("계층 경계", () => {
  it("resolve는 `buildBundledAgentIndex`를 import하지 않는다 — 입력 축이 다르다", async () => {
    const mod = await import("../src/workflow-doc/index-3tuple.js");
    expect(Object.keys(mod)).not.toContain("buildBundledAgentIndex");
  });
});

/**
 * **보안 심사 L-2 대응** — 읽지 못한 것은 "설명이 없다"가 아니다.
 * 이전에는 `asset.json` 읽기 실패와 경로 가드 트립을 전부 `field_absent`로 삼켜 **관측이 끊겼다.**
 */
describe("L-2 — `read_failed`를 `no_description`과 갈랐다", () => {
  const rows = [row("agent", "executor", "omc")];
  const refs = [ref("Agent", "omc", "executor")];
  const resolveWith = (reason: "path_rejected" | "io_error") =>
    resolveWorkflowAssets(refs, { kind: "available", rows }, always({ kind: "read_failed", reason }));

  it("읽기 실패가 `description_unreadable`이 된다 — `no_description`이 아니다", () => {
    const out = resolveWith("io_error").outcomes[0];
    expect(out).toMatchObject({ tag: "description_unreadable", reason: "io_error" });
  });

  it("**경로 거부는 구조적 실패(3), 그 외 읽기 실패는 미측정(2)** — 뭉개지 않는다", () => {
    expect(summarizeOutcomes(resolveWith("path_rejected")).exitCode).toBe(3);
    expect(summarizeOutcomes(resolveWith("io_error")).exitCode).toBe(2);
  });

  it("셀 문구가 갈린다 — 카탈로그 오염 신호를 단순 읽기 실패로 보이게 하지 않는다", () => {
    const pathRejected = describeOutcome(resolveWith("path_rejected").outcomes[0]!);
    const ioError = describeOutcome(resolveWith("io_error").outcomes[0]!);
    expect(pathRejected).not.toBe(ioError);
    expect(pathRejected).toContain("오염");
    // "설명 없음"과도 달라야 한다 — 부재와 판정 불가는 다른 사건이다.
    const absent = describeOutcome({ tag: "no_description", ref: refs[0]!, assetId: "i", reason: "field_absent" });
    expect(pathRejected).not.toBe(absent);
    expect(ioError).not.toBe(absent);
  });

  it("요약이 읽기 실패를 **따로** 세고 경로 거부를 하위축으로 낸다", () => {
    const summary = summarizeOutcomes(resolveWith("path_rejected"));
    expect(summary.descriptionUnreadable).toBe(1);
    expect(summary.descriptionUnreadablePathRejected).toBe(1);
    expect(summary.noDescription, "읽기 실패가 '설명 없음'으로 새면 안 된다").toBe(0);
    expect(formatSummary(summary)).toContain("읽기실패 1(경로거부 1)");
  });

  it("합이 여전히 입력 건수와 같다 — 새 갈래가 어디에도 안 잡히는 일이 없다", () => {
    const summary = summarizeOutcomes(resolveWith("io_error"));
    const sum =
      summary.resolved + summary.noCatalog + summary.indexCorrupted + summary.notInstalled +
      summary.noDescription + summary.ambiguous + summary.descriptionUnreadable;
    expect(sum).toBe(summary.total);
  });
});

import { describe, expect, it } from "vitest";
import { parseAsset } from "../src/schema/asset.js";
import type { Asset } from "../src/schema/asset.js";
import {
  buildBundledAgentIndex,
  classifySubagentRef,
  pluginNameFromId,
  resolveSubagentRef,
} from "../src/usage/subagent-resolve.js";

/**
 * core/test/subagent-resolve.test.ts — B4-b.
 *
 * ⚠️ **`as T` 캐스팅 금지** — 픽스처는 실제 파서(`parseAsset`)를 통과시킨다. 번들 에이전트의
 * id 구조 불변식(`${parent_asset_id}:${suffix}`)을 스키마가 강제하므로, 캐스팅으로 만들면
 * 실환경에 있을 수 없는 자산으로 테스트가 통과한다.
 */

function agent(parentId: string, name: string): Asset {
  return parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: `${parentId}:agent:${name}`,
    kind: "agent",
    name,
    parent_asset_id: parentId,
  });
}

function plugin(id: string, name: string): Asset {
  return parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id,
    kind: "plugin",
    name,
    marketplace: id.slice(id.lastIndexOf("@") + 1),
  });
}

describe("classifySubagentRef — 실측된 두 형태만 있다", () => {
  it("콜론이 없으면 bare_name, 있으면 plugin_qualified다(`classifySkillInput`과 같은 축)", () => {
    expect(classifySubagentRef("general-purpose")).toBe("bare_name");
    expect(classifySubagentRef("omc:executor")).toBe("plugin_qualified");
  });
});

describe("pluginNameFromId — 마지막 `@`를 기준으로 자른다", () => {
  it("일반적인 `<이름>@<마켓>`에서 이름만 꺼낸다", () => {
    expect(pluginNameFromId("omc@official")).toBe("omc");
  });

  it("이름에 `@`가 있어도 마켓플레이스만 떨어져 나간다 — 앞에서 자르면 이름이 잘린다", () => {
    // ⚠️ "플러그인 이름에 `@`가 없다"는 **미측정 전제**다. 그 전제에 기대지 않는다.
    expect(pluginNameFromId("@scope/tool@official")).toBe("@scope/tool");
  });

  it("`@`가 아예 없으면 전체를 이름으로 본다(형태가 달라도 잘못 매칭되지는 않는다)", () => {
    expect(pluginNameFromId("bare-plugin")).toBe("bare-plugin");
  });
});

describe("resolveSubagentRef — 후보가 정확히 하나일 때만 잇는다", () => {
  const assets = [
    plugin("omc@official", "omc"),
    agent("omc@official", "executor"),
    agent("omc@official", "planner"),
    plugin("other@official", "other"),
    agent("other@official", "helper"),
  ];
  const index = buildBundledAgentIndex(assets);

  it("plugin_qualified — 그 플러그인 안에서 찾아 자산 id로 잇는다", () => {
    expect(resolveSubagentRef("omc:executor", index)).toEqual({
      resolved: true,
      assetId: "omc@official:agent:executor",
    });
  });

  it("bare_name — 이름만으로도 후보가 하나면 잇는다", () => {
    expect(resolveSubagentRef("helper", index)).toEqual({
      resolved: true,
      assetId: "other@official:agent:helper",
    });
  });

  it("카탈로그에 없는 이름은 no_match다 — 하네스 내장 에이전트가 여기 온다(결함이 아니다)", () => {
    expect(resolveSubagentRef("general-purpose", index)).toEqual({ resolved: false, reason: "no_match" });
  });

  it("**전역으로 넓히지 않는다** — 플러그인 이름이 틀리면 동명 에이전트가 있어도 잇지 않는다", () => {
    // `other:executor`는 존재하지 않는다. 전역 폴백이 있으면 omc의 executor에 잘못 붙는다.
    expect(resolveSubagentRef("other:executor", index)).toEqual({ resolved: false, reason: "no_match" });
  });

  it("같은 이름의 플러그인이 두 마켓플레이스에 있으면 ambiguous다 — 어느 쪽인지 고르지 않는다", () => {
    // ⚠️ `plugin_qualified`의 앞 세그먼트는 **이름**이고 자산 id는 `<이름>@<마켓>`이다.
    // "이름 유일성"은 미측정 전제이므로 코드가 그것에 기대면 안 된다.
    const dup = buildBundledAgentIndex([
      agent("omc@official", "executor"),
      agent("omc@mirror", "executor"),
    ]);
    expect(resolveSubagentRef("omc:executor", dup)).toEqual({ resolved: false, reason: "ambiguous" });
  });

  it("bare_name이 여러 플러그인에 동명으로 있으면 ambiguous다", () => {
    const dup = buildBundledAgentIndex([agent("a@m", "review"), agent("b@m", "review")]);
    expect(resolveSubagentRef("review", dup)).toEqual({ resolved: false, reason: "ambiguous" });
  });

  it("콜론이 둘 이상이면 잇지 않는다 — 실측상 0건이지만 그 전제에 기대지 않는다", () => {
    // 첫 콜론에서만 갈랐다면 `omc` / `skill:ask`가 되어 조용히 매칭에 실패했을 것이다.
    // 세그먼트가 정확히 둘일 때만 취급하므로 형태가 예상 밖임이 판정에 드러난다.
    expect(resolveSubagentRef("omc:skill:ask", index)).toEqual({ resolved: false, reason: "no_match" });
  });

  it("빈 세그먼트는 잇지 않는다", () => {
    expect(resolveSubagentRef(":executor", index)).toEqual({ resolved: false, reason: "no_match" });
    expect(resolveSubagentRef("omc:", index)).toEqual({ resolved: false, reason: "no_match" });
  });
});

describe("buildBundledAgentIndex — agent만 색인한다", () => {
  it("plugin·skill·command는 색인에 들어가지 않는다 — 같은 이름이어도 에이전트로 잇지 않는다", () => {
    const index = buildBundledAgentIndex([
      plugin("omc@official", "omc"),
      parseAsset({
        schema_version: 1,
        _scope: "machine_independent",
        id: "omc@official:skill:executor",
        kind: "skill",
        name: "executor",
        parent_asset_id: "omc@official",
      }),
    ]);
    expect(resolveSubagentRef("omc:executor", index)).toEqual({ resolved: false, reason: "no_match" });
    expect(resolveSubagentRef("executor", index)).toEqual({ resolved: false, reason: "no_match" });
  });

  it("양성 대조군 — 같은 픽스처에 agent를 더하면 즉시 잇힌다(색인이 죽어 있지 않다)", () => {
    const index = buildBundledAgentIndex([
      plugin("omc@official", "omc"),
      agent("omc@official", "executor"),
    ]);
    expect(resolveSubagentRef("omc:executor", index)).toEqual({
      resolved: true,
      assetId: "omc@official:agent:executor",
    });
  });
});

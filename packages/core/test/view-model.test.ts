import { describe, expect, it } from "vitest";
import {
  assessRankingQuality,
  buildConsoleViewModel,
  toMcpStateView,
  type BuildViewModelInput,
} from "../src/view/view-model.js";
import { parseAsset, type Asset } from "../src/schema/asset.js";
import { parseInstallation, type Installation } from "../src/schema/installation.js";
import { parseOccupancy, type Occupancy } from "../src/schema/occupancy.js";
import type { UsageMetric } from "../src/schema/usage.js";

const NOW = new Date("2026-08-22T00:00:00.000Z");

function asset(overrides: Partial<Asset> & Pick<Asset, "id" | "kind" | "name">): Asset {
  return parseAsset({ schema_version: 1, _scope: "machine_independent", ...overrides });
}

function installation(overrides: Partial<Installation> & Pick<Installation, "asset_id">): Installation {
  return parseInstallation({
    schema_version: 1,
    _scope: "machine_dependent",
    machine_id: "m1",
    install_scope: null,
    enabled_at: null,
    project_path_hash: null,
    mcp_enabled_state: null,
    mcp_state_source: null,
    ...overrides,
  });
}

/**
 * ⚠️ 픽스처는 `as Occupancy` 캐스팅이 아니라 **실제 zod 파서를 통과시킨다.** 이 프로젝트에서
 * "픽스처가 실제 형태와 달라 파서가 검증되지 않았다"가 반복해 나왔고(CLAUDE.md 검증 절),
 * 캐스팅으로 쓰면 스키마가 바뀌어도 테스트는 조용히 통과한다.
 */
function occupancy(assetId: string, idle: Occupancy["idle"]): Occupancy {
  return parseOccupancy({
    schema_version: 1,
    _scope: "machine_independent",
    asset_id: assetId,
    idle,
    loaded: { state: "unmeasured", value_tokens: null, reason: "definition_pending" },
    idle_definition: "harness-parity",
    harness_alwayson: { state: "unmeasured", value_tokens: null, reason: "not_a_plugin" },
    occupancy_divergence: false,
    occupancy_divergence_ratio: null,
  });
}

function baseInput(overrides: Partial<BuildViewModelInput> = {}): BuildViewModelInput {
  return {
    machineId: "m1",
    assets: [],
    installations: [],
    occupancy: [],
    usage: [],
    lastScanAt: NOW.toISOString(),
    docPresence: new Map(),
    unusedExpensiveLimit: 5,
    now: NOW,
    ...overrides,
  };
}

describe("MCP 상태 — unknown을 unset/disabled로 뭉개지 않는다 (OQ-7 안 C)", () => {
  it("MCP 자산의 null 상태는 unknown이다 — '설정 안 됨'이 아니다", () => {
    expect(toMcpStateView("mcp", null)).toBe("unknown");
  });

  it("MCP 자산의 unset은 unset 그대로다 — unknown과 다른 사실이다", () => {
    expect(toMcpStateView("mcp", "unset")).toBe("unset");
  });

  it("MCP가 아닌 자산의 null은 not_applicable이다 — unknown이 아니다", () => {
    expect(toMcpStateView("plugin", null)).toBe("not_applicable");
    expect(toMcpStateView("skill", null)).toBe("not_applicable");
  });

  it("네 상태가 서로 전부 다르다 — 어느 둘도 같은 값으로 접히지 않는다", () => {
    const states = [
      toMcpStateView("mcp", "enabled"),
      toMcpStateView("mcp", "disabled"),
      toMcpStateView("mcp", "unset"),
      toMcpStateView("mcp", null),
      toMcpStateView("plugin", null),
    ];
    expect(new Set(states).size).toBe(5);
  });

  it("뷰모델을 통과해도 unknown이 보존된다", () => {
    const vm = buildConsoleViewModel(
      baseInput({
        assets: [asset({ id: "srv", kind: "mcp", name: "srv" })],
        installations: [installation({ asset_id: "srv", mcp_enabled_state: null, mcp_state_source: "none" })],
      }),
    );
    expect(vm.assets[0]?.installations[0]?.mcp_state).toBe("unknown");
  });
});

describe("점유 — unmeasured를 숫자 0으로 만들지 않는다", () => {
  it("unmeasured 자산은 순위에 들어가지 않고 unrankable에 이유와 함께 남는다", () => {
    const vm = buildConsoleViewModel(
      baseInput({
        assets: [asset({ id: "a", kind: "skill", name: "a" })],
        occupancy: [occupancy("a", { state: "unmeasured", value_tokens: null, reason: "credential_missing" })],
      }),
    );
    expect(vm.usage.ranked).toHaveLength(0);
    expect(vm.usage.unrankable).toHaveLength(1);
    expect(vm.usage.unrankable[0]?.occupancy_idle).toEqual({
      state: "unmeasured",
      value_tokens: null,
      reason: "credential_missing",
    });
  });

  it("뷰모델 어디에도 unmeasured 자산의 idle이 숫자 0으로 나타나지 않는다", () => {
    const vm = buildConsoleViewModel(
      baseInput({
        assets: [asset({ id: "a", kind: "skill", name: "a" })],
        occupancy: [occupancy("a", { state: "unmeasured", value_tokens: null, reason: "credential_missing" })],
      }),
    );
    const unrankableJson = JSON.stringify(vm.usage.unrankable);
    expect(unrankableJson).toContain('"value_tokens":null');
    expect(unrankableJson).not.toContain('"value_tokens":0');
  });

  it("approx_bytes도 순위에서 분리되고 바이트 값이 토큰 자리로 새지 않는다", () => {
    const vm = buildConsoleViewModel(
      baseInput({
        assets: [asset({ id: "a", kind: "skill", name: "a" })],
        occupancy: [occupancy("a", { state: "approx_bytes", value_tokens: null, approx_bytes: 4096 })],
      }),
    );
    expect(vm.usage.ranked).toHaveLength(0);
    expect(vm.usage.unrankable[0]?.occupancy_idle).toEqual({ state: "approx_bytes", value_tokens: null, approx_bytes: 4096 });
  });

  it("measured 자산은 순위에 들어간다 — 위 케이스들이 '순위가 늘 비어 있다'와 구분됨을 보인다", () => {
    const usage: UsageMetric[] = [];
    const vm = buildConsoleViewModel(
      baseInput({
        assets: [asset({ id: "a", kind: "skill", name: "a" })],
        occupancy: [
          occupancy("a", { state: "measured", value_tokens: 120, tokenizer_model: "m", measured_at: NOW.toISOString() }),
        ],
        usage,
      }),
    );
    expect(vm.usage.ranked).toHaveLength(1);
    expect(vm.usage.ranked[0]?.idle_tokens).toBe(120);
  });
});

describe("신선도 — '스캔한 적 없음'을 '0일 전'으로 표시하지 않는다", () => {
  it("스캔 기록이 없으면 never_scanned이고 일수는 null이며 stale이다", () => {
    const vm = buildConsoleViewModel(baseInput({ lastScanAt: null }));
    expect(vm.freshness).toEqual({ last_scan_at: null, days_since_last_scan: null, is_stale: true, never_scanned: true });
  });

  it("방금 스캔했으면 0일 전이고 stale이 아니다", () => {
    const vm = buildConsoleViewModel(baseInput({ lastScanAt: NOW.toISOString() }));
    expect(vm.freshness.days_since_last_scan).toBe(0);
    expect(vm.freshness.is_stale).toBe(false);
    expect(vm.freshness.never_scanned).toBe(false);
  });

  it("8일 지났으면 stale이다", () => {
    const vm = buildConsoleViewModel(baseInput({ lastScanAt: "2026-08-14T00:00:00.000Z" }));
    expect(vm.freshness.days_since_last_scan).toBe(8);
    expect(vm.freshness.is_stale).toBe(true);
  });

  it("깨진 타임스탬프는 조용히 0일로 만들지 않고 일수를 null로 두고 stale 처리한다", () => {
    const vm = buildConsoleViewModel(baseInput({ lastScanAt: "not-a-date" }));
    expect(vm.freshness.days_since_last_scan).toBeNull();
    expect(vm.freshness.is_stale).toBe(true);
  });
});

describe("저장소 링크 — '링크 없음'과 '미수집'을 구분한다", () => {
  it("repo_source가 없으면 repo는 null이다 (미수집·개념 없음)", () => {
    const vm = buildConsoleViewModel(baseInput({ assets: [asset({ id: "s", kind: "skill", name: "s" })] }));
    expect(vm.assets[0]?.repo).toBeNull();
  });

  it("directory 출처는 repo가 있고 url만 null이다 — 미수집과 다르다", () => {
    const vm = buildConsoleViewModel(
      baseInput({
        assets: [asset({ id: "p@mp", kind: "plugin", name: "p", marketplace: "mp", repo_source: "directory" })],
      }),
    );
    expect(vm.assets[0]?.repo).toEqual({ kind: "directory", url: null });
  });

  it("github 출처는 url을 그대로 싣는다", () => {
    const vm = buildConsoleViewModel(
      baseInput({
        assets: [
          asset({
            id: "p@mp",
            kind: "plugin",
            name: "p",
            marketplace: "mp",
            repo_source: "github",
            repo_url: "https://github.com/synth/x",
          }),
        ],
      }),
    );
    expect(vm.assets[0]?.repo).toEqual({ kind: "github", url: "https://github.com/synth/x" });
  });
});

describe("설치 목록 — 자산 하나의 여러 설치를 병합하지 않는다 (P1-13)", () => {
  it("같은 자산의 프로젝트별 설치가 각각 한 줄로 남는다", () => {
    const vm = buildConsoleViewModel(
      baseInput({
        assets: [asset({ id: "p@mp", kind: "plugin", name: "p", marketplace: "mp" })],
        installations: [
          installation({ asset_id: "p@mp", enabled_at: "local", project_path_hash: "h1" }),
          installation({ asset_id: "p@mp", enabled_at: "local", project_path_hash: "h2" }),
        ],
      }),
    );
    expect(vm.assets[0]?.installations).toHaveLength(2);
    expect(vm.assets[0]?.installations.map((i) => i.project_path_hash)).toEqual(["h1", "h2"]);
  });

  it("설치 기록이 없는 자산도 목록에서 사라지지 않는다", () => {
    const vm = buildConsoleViewModel(baseInput({ assets: [asset({ id: "orphan", kind: "cli", name: "orphan" })] }));
    expect(vm.assets).toHaveLength(1);
    expect(vm.assets[0]?.installations).toEqual([]);
  });
});

describe("순위 자격 — 값이 전부 맞아도 결론이 거짓일 수 있다", () => {
  it("measured가 하나도 없으면 순위는 의미 없다", () => {
    expect(assessRankingQuality([], 177)).toEqual({
      measured_count: 0,
      unmeasured_count: 177,
      is_meaningful: false,
      reason: "no_measured_assets",
    });
  });

  it("measured가 전부 0이면 '비싼 툴' 순위가 성립하지 않는다", () => {
    const quality = assessRankingQuality([0, 0, 0, 0, 0, 0], 177);
    expect(quality.is_meaningful).toBe(false);
    expect(quality.reason).toBe("all_measured_are_zero");
    expect(quality.measured_count).toBe(6);
  });

  it("0이 아닌 값이 하나라도 있으면 순위는 의미를 갖는다", () => {
    expect(assessRankingQuality([0, 0, 120], 10).reason).toBe("ok");
    expect(assessRankingQuality([0, 0, 120], 10).is_meaningful).toBe(true);
  });

  it("실측 상황을 뷰모델로 재현한다 — MCP·CLI만 measured(전부 0)이고 나머지는 미측정", () => {
    const zeroCostAssets = ["mcp-a", "mcp-b", "cli-a"];
    const expensiveButUnmeasured = ["plugin-a", "plugin-b"];
    const vm = buildConsoleViewModel(
      baseInput({
        assets: [
          ...zeroCostAssets.map((id) => asset({ id, kind: "mcp", name: id })),
          ...expensiveButUnmeasured.map((id) => asset({ id, kind: "plugin", name: id, marketplace: "mp" })),
        ],
        occupancy: [
          ...zeroCostAssets.map((id) =>
            occupancy(id, { state: "measured", value_tokens: 0, tokenizer_model: "m", measured_at: NOW.toISOString() }),
          ),
          ...expensiveButUnmeasured.map((id) =>
            occupancy(id, { state: "unmeasured", value_tokens: null, reason: "credential_missing" }),
          ),
        ],
      }),
    );
    // 순위는 채워진다 — 지우지 않는다("측정할 게 없다"와 "0이 최선이다"를 구분해야 한다).
    expect(vm.usage.ranked.length).toBeGreaterThan(0);
    expect(vm.usage.ranked.every((r) => r.idle_tokens === 0)).toBe(true);
    // 그러나 결론으로 제시할 자격은 없다.
    expect(vm.usage.ranking_quality).toEqual({
      measured_count: 3,
      unmeasured_count: 2,
      is_meaningful: false,
      reason: "all_measured_are_zero",
    });
  });

  it("자격 판정은 상한으로 자르기 전 모집단을 본다 — 상위 N개만 보면 잘못 판정한다", () => {
    // measured 6건 중 상위 5건만 순위에 들어가지만, 6번째에 0이 아닌 값이 있으면 순위는 유의미하다.
    const ids = ["a", "b", "c", "d", "e", "f"];
    const vm = buildConsoleViewModel(
      baseInput({
        unusedExpensiveLimit: 5,
        assets: ids.map((id) => asset({ id, kind: "skill", name: id })),
        occupancy: ids.map((id, index) =>
          occupancy(id, {
            state: "measured",
            value_tokens: index === 5 ? 999 : 0,
            tokenizer_model: "m",
            measured_at: NOW.toISOString(),
          }),
        ),
      }),
    );
    expect(vm.usage.ranked).toHaveLength(5);
    expect(vm.usage.ranking_quality.measured_count).toBe(6);
    expect(vm.usage.ranking_quality.is_meaningful).toBe(true);
  });
});

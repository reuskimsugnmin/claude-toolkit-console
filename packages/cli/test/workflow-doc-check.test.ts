import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assetJsonPath,
  GENERATED_REGION_END,
  GENERATED_REGION_START,
  parseAsset,
  unescapedPipeIndexes,
  type Asset,
  type AssetKind,
} from "@ctk/core";
import { describe, expect, it } from "vitest";
import { runWorkflowDoc } from "../src/commands/workflow-doc.js";

/**
 * `ctk workflow-doc`을 **실제로 태운다.** 이 저장소는 "vitest가 `main`을 우회해도 통과"한 전례가
 * 있어 함수만 부르고 끝내지 않는다 — 합성 카탈로그를 임시 디렉터리에 만들고, 종료 코드는
 * **빌드된 바이너리를 프로세스로 실행해** 확인한다(함수 반환값이 아니라 프로세스 종료 코드다).
 *
 * 자산명은 저장소에 **이미 커밋된** omc 자산명만 쓰고 설명은 **합성 문자열**이다 —
 * 개인 환경 데이터를 넣지 않는다.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST_BIN = path.join(repoRoot, "packages/cli/dist/bin/ctk.js");

/** 문서 표의 자산 참조와 같은 형태 — 저장소에 이미 커밋된 이름만 쓴다. */
const FIXTURE_ASSETS: readonly { kind: AssetKind; name: string; plugin: string; description?: string }[] = [
  { kind: "agent", name: "executor", plugin: "oh-my-claudecode", description: "합성 설명 — 구현 담당" },
  { kind: "agent", name: "critic", plugin: "oh-my-claudecode", description: "합성 설명 — 계획 검토" },
];

/** ⚠️ **픽스처는 실제 zod 파서를 통과시킨다** — `as Asset` 금지. agent는 `parent_asset_id` 필수다. */
function buildAsset(spec: (typeof FIXTURE_ASSETS)[number]): Asset {
  return parseAsset({
    schema_version: 1,
    _scope: "machine_independent",
    id: `${spec.plugin}@market:${spec.kind}:${spec.name}`,
    kind: spec.kind,
    name: spec.name,
    parent_asset_id: `${spec.plugin}@market`,
    ...(spec.description === undefined ? {} : { description: spec.description }),
  });
}

/** 합성 카탈로그를 만든다 — 인덱스 + 자산별 `asset.json`. */
function makeCatalog(root: string, assets: readonly Asset[]): void {
  mkdirSync(path.join(root, "catalog"), { recursive: true });
  writeFileSync(
    path.join(root, "catalog/index.json"),
    JSON.stringify({
      schema_version: 1,
      assets: assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name, parent_asset_id: a.parent_asset_id })),
    }),
    "utf8",
  );
  for (const asset of assets) {
    const rel = assetJsonPath(asset.kind, asset.name, asset.id);
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), JSON.stringify(asset), "utf8");
  }
}

function makeDoc(dir: string, rows: readonly string[]): string {
  const docPath = path.join(dir, "docs", "workflow-assets.md");
  mkdirSync(path.dirname(docPath), { recursive: true });
  writeFileSync(
    docPath,
    [
      "# 합성 문서",
      "",
      GENERATED_REGION_START,
      "| 단계 | 스폰할 것 | 설명 |",
      "|---|---|---|",
      ...rows,
      GENERATED_REGION_END,
      "",
      "## 쓰지 않는 것 — 워크플로우 플러그인",
      "",
      "정책 절은 마커 밖에 있다.",
      "",
    ].join("\n"),
    "utf8",
  );
  return docPath;
}

const ROW_EXECUTOR = "| 구현 | `Agent(oh-my-claudecode:executor)` |  |";
const ROW_CRITIC = "| 계획 검토 | `Agent(oh-my-claudecode:critic)` |  |";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "ctk-b4c-"));
}

describe("픽스처 자체 검증 — 실제 파서를 통과했는가", () => {
  it("`parseAsset`을 통과한다 — 필수 필드 누락으로 결과가 전부 같아진 전례가 있다", () => {
    const assets = FIXTURE_ASSETS.map(buildAsset);
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.parent_asset_id !== undefined)).toBe(true);
    // agent는 marketplace가 금지다 — 넣으면 파서가 던진다.
    expect(() =>
      parseAsset({
        schema_version: 1,
        _scope: "machine_independent",
        id: "x@m:agent:y",
        kind: "agent",
        name: "y",
        marketplace: "m",
        parent_asset_id: "x@m",
      }),
    ).toThrow();
  });
});

describe("runWorkflowDoc — 네 갈래 종료 코드", () => {
  it("**0** — 카탈로그가 있고 셀이 이미 최신이다", () => {
    const dir = tmp();
    makeCatalog(dir, FIXTURE_ASSETS.map(buildAsset));
    const docPath = makeDoc(dir, [ROW_EXECUTOR]);
    // 먼저 써서 최신으로 만든 뒤 --check가 0인지 본다.
    runWorkflowDoc({ docPath, catalogRoot: dir, write: true });
    expect(runWorkflowDoc({ docPath, catalogRoot: dir }).exitCode).toBe(0);
  });

  it("**1** — 드리프트", () => {
    const dir = tmp();
    makeCatalog(dir, FIXTURE_ASSETS.map(buildAsset));
    const report = runWorkflowDoc({ docPath: makeDoc(dir, [ROW_EXECUTOR]), catalogRoot: dir });
    expect(report.exitCode).toBe(1);
    expect(report.rows[0]?.drifted).toBe(true);
  });

  it("**2** — 미측정(카탈로그 없음). 드리프트가 있어도 2가 이긴다", () => {
    const dir = tmp();
    const report = runWorkflowDoc({ docPath: makeDoc(dir, [ROW_EXECUTOR]), catalogRoot: null });
    expect(report.exitCode).toBe(2);
    expect(report.lines[0]).toContain("미측정");
  });

  it("**3** — 동명 자산 판정 불가. **미측정(2)으로 낮추지 않는다**", () => {
    const dir = tmp();
    const dup = parseAsset({
      schema_version: 1,
      _scope: "machine_independent",
      id: "oh-my-claudecode@market:agent:executor#2",
      kind: "agent",
      name: "executor",
      parent_asset_id: "oh-my-claudecode@market",
      description: "합성 중복",
    });
    makeCatalog(dir, [...FIXTURE_ASSETS.map(buildAsset), dup]);
    expect(runWorkflowDoc({ docPath: makeDoc(dir, [ROW_EXECUTOR]), catalogRoot: dir }).exitCode).toBe(3);
  });

  it("**3** — 마커가 없으면 구조적 실패이고 `failureClass`가 붙는다", () => {
    const dir = tmp();
    const docPath = makeDoc(dir, [ROW_EXECUTOR]);
    writeFileSync(docPath, readFileSync(docPath, "utf8").replace(GENERATED_REGION_START, ""), "utf8");
    const report = runWorkflowDoc({ docPath, catalogRoot: dir });
    expect(report.exitCode).toBe(3);
    expect(report.failure?.failureClass).toBe("workflow_doc_marker_absent");
  });
});

describe("--write — 접두사 바이트 동일성과 멱등성 (D-1′ · F-1)", () => {
  /** 사람이 손으로 만들 법한 **적대적 서식** — 생성기가 이것을 다시 쓰면 안 된다. */
  const ADVERSARIAL = [
    "| 구현      | `Agent(oh-my-claudecode:executor)` — **필수** · `actuator` 주의 |  |",
    "| 계획 검토 | `Agent(oh-my-claudecode:critic)` 산문 a \\| b 포함 |  |",
  ];

  function prefixOf(line: string): string {
    const pipes = unescapedPipeIndexes(line);
    return line.slice(0, (pipes[pipes.length - 2] ?? 0) + 1);
  }

  it("끝에서 두 번째 `|`까지의 접두사가 **바이트 동일**하다 — 정렬 공백·굵게·산문·`\\|` 전부", () => {
    const dir = tmp();
    makeCatalog(dir, FIXTURE_ASSETS.map(buildAsset));
    const docPath = makeDoc(dir, ADVERSARIAL);
    const before = readFileSync(docPath, "utf8").split("\n").filter((l) => l.startsWith("| 구현") || l.startsWith("| 계획"));

    runWorkflowDoc({ docPath, catalogRoot: dir, write: true });
    const after = readFileSync(docPath, "utf8").split("\n").filter((l) => l.startsWith("| 구현") || l.startsWith("| 계획"));

    expect(after).toHaveLength(before.length);
    before.forEach((line, i) => {
      expect(prefixOf(after[i] ?? ""), `${i}행 접두사가 바뀌었다`).toBe(prefixOf(line));
    });
    // 정렬 공백과 이스케이프된 파이프가 살아 있다.
    expect(after[0]).toContain("| 구현      |");
    expect(after[1]).toContain("a \\| b");
  });

  it("**2회 실행이 동일 바이트**다 — 열이 늘어나는 F-1 회귀를 막는다", () => {
    const dir = tmp();
    makeCatalog(dir, FIXTURE_ASSETS.map(buildAsset));
    const docPath = makeDoc(dir, ADVERSARIAL);
    runWorkflowDoc({ docPath, catalogRoot: dir, write: true });
    const once = readFileSync(docPath, "utf8");
    runWorkflowDoc({ docPath, catalogRoot: dir, write: true });
    expect(readFileSync(docPath, "utf8")).toBe(once);
    // 열 수도 그대로다.
    for (const line of once.split("\n").filter((l) => l.startsWith("|"))) {
      expect(unescapedPipeIndexes(line).length).toBe(4);
    }
  });

  it("마커 밖은 손대지 않는다 — 정책 절이 살아 있다", () => {
    const dir = tmp();
    makeCatalog(dir, FIXTURE_ASSETS.map(buildAsset));
    const docPath = makeDoc(dir, [ROW_EXECUTOR, ROW_CRITIC]);
    runWorkflowDoc({ docPath, catalogRoot: dir, write: true });
    expect(readFileSync(docPath, "utf8")).toContain("## 쓰지 않는 것 — 워크플로우 플러그인");
  });
});

describe("계층·위생 경계", () => {
  const source = readFileSync(path.join(repoRoot, "packages/cli/src/commands/workflow-doc.ts"), "utf8");

  it("`listAllAssets`·`buildBundledAgentIndex`를 import하지 않는다 (D-8 보조 방어)", () => {
    // ⚠️ 소스 전문을 grep하면 **이 규칙을 설명한 주석 자신**에 걸린다(실제로 걸렸다).
    // import 문만 본다 — 게이트가 자기 문서에 반응하면 신호가 아니라 잡음이다.
    const importBlock = source.split(/^\s*(?:export |\/\*\*)/m)[0] ?? "";
    expect(importBlock).not.toContain("listAllAssets");
    expect(importBlock).not.toContain("buildBundledAgentIndex");
    expect(importBlock, "import 블록을 못 뽑았으면 이 단언은 공허하다").toContain("@ctk/core");
  });

  it("`findWorkflowDocLeaks`가 **쓰기 경로와 출력 경로 둘 다**에서 불린다 — 호출 지점을 센다", () => {
    // 막는 것과 보이는 것은 다른 축이다. 한 자리만 배선하면 다른 축이 무방비다.
    expect(source.split("findWorkflowDocLeaks(").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("해시 세그먼트를 재구현하지 않는다 — `assetJsonPath`를 쓴다", () => {
    expect(source).toContain("assetJsonPath(");
    expect(source).not.toContain("createHash");
  });
});

/**
 * **프로세스 수준 종료 코드** — 함수 반환값이 아니라 `bin/ctk.ts`의 배선(D-3)이 검증 대상이다.
 * 빌드 산출물이 없으면 **건너뛴 것이 보이게** 한다(미측정은 통과가 아니다).
 */
describe.skipIf(!existsSync(DIST_BIN))("빌드된 바이너리를 실제로 실행한다", () => {
  function runBin(cwd: string, ctkHome: string, args: string[]): number {
    try {
      execFileSync("node", [DIST_BIN, "workflow-doc", ...args], {
        cwd,
        env: { ...process.env, CTK_HOME: ctkHome },
        encoding: "utf8",
        stdio: "pipe",
      });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  }

  it("카탈로그가 없으면 프로세스 종료 코드가 **2**다 (미측정)", () => {
    const dir = tmp();
    makeDoc(dir, [ROW_EXECUTOR]);
    // CTK_HOME을 빈 임시 홈으로 돌려 로컬 config를 못 찾게 한다.
    expect(runBin(dir, tmp(), ["--check"])).toBe(2);
  });

  it("**양성 대조군** — 동명 자산을 주입하면 프로세스 종료 코드가 **3**이다", () => {
    const dir = tmp();
    const home = tmp();
    const catalog = path.join(home, "catalog-root");
    const dup = parseAsset({
      schema_version: 1,
      _scope: "machine_independent",
      id: "oh-my-claudecode@market:agent:executor#2",
      kind: "agent",
      name: "executor",
      parent_asset_id: "oh-my-claudecode@market",
      description: "합성 중복",
    });
    makeCatalog(catalog, [...FIXTURE_ASSETS.map(buildAsset), dup]);
    mkdirSync(path.join(home, ".config", "ctk"), { recursive: true });
    writeFileSync(
      path.join(home, ".config", "ctk", "config.json"),
      JSON.stringify({ schema_version: 1, catalog_path: catalog }),
      "utf8",
    );
    makeDoc(dir, [ROW_EXECUTOR]);
    expect(runBin(dir, home, ["--check"])).toBe(3);
  });
});

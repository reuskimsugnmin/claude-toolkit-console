import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assetJsonPath,
  describeOutcome,
  findGeneratedRegion,
  findWorkflowDocLeaks,
  GENERATED_OUTPUT_AXES,
  locateTable,
  replaceLastCell,
  renderWorkflowAssetRow,
  resolveWorkflowAssets,
  summarizeOutcomes,
  formatSummary,
  WorkflowDocError,
  type AssetOutcome,
  type CatalogState,
  type DescriptionLookup,
  type FailureClass,
  type IndexRowForLookup,
  type OutcomeSummary,
  type RowCellInput,
} from "@ctk/core";
import { resolveHomeContext } from "@ctk/probe";
import { readCatalogIndexOrNull } from "@ctk/sync";
import { readLocalConfig } from "../local-config.js";

/**
 * `ctk workflow-doc` — `docs/workflow-assets.md`의 **마지막 열만** 카탈로그에서 채운다 (B4-c).
 *
 * ⚠️ **던지지 않고 반환한다 (D-3).** `bin/ctk.ts`의 포괄 `failureClass` 분기는 그 필드를 가진
 * 모든 오류를 **exit 1(드리프트)**로 만든다 — 구조적 실패를 드리프트로 낮춰 보고하게 된다.
 * 이 커맨드는 판정 결과를 돌려주고 호출부가 종료 코드를 정한다.
 *
 * ⚠️ **카탈로그를 열거하지 않는다 (D-8).** 인덱스는 3튜플 색인을 만드느라 메모리에 들어오지만,
 * `asset.json` 본문은 **화이트리스트가 정확히 1건으로 좁힌 자산에 대해서만** 읽는다.
 * `listAllAssets`·`buildBundledAgentIndex`를 import하지 않는다(보조 방어 — grep으로 단언한다).
 */

export interface WorkflowDocOptions {
  /** 기본은 `--check`다 — 쓰기는 명시 플래그일 때만. */
  readonly write?: boolean;
  /** 테스트용 주입. 기본은 저장소의 `docs/workflow-assets.md`. */
  readonly docPath?: string;
  /** 테스트용 주입. `undefined`면 로컬 config에서 찾는다. `null`이면 "카탈로그 없음"을 강제한다. */
  readonly catalogRoot?: string | null;
}

export interface WorkflowDocRowReport {
  readonly lineIndex: number;
  readonly current: string;
  readonly expected: string;
  readonly drifted: boolean;
}

export interface WorkflowDocReport {
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly summary: OutcomeSummary | null;
  readonly rows: readonly WorkflowDocRowReport[];
  readonly wrote: boolean;
  /** 구조적 실패 — `null`이면 구조는 정상이다. */
  readonly failure: { readonly failureClass: FailureClass; readonly message: string } | null;
  /** 화면에 찍을 줄들. **출력 전에 유출 게이트를 통과한 값이다.** */
  readonly lines: readonly string[];
}

const DEFAULT_DOC_RELATIVE = "docs/workflow-assets.md";

/**
 * 문서를 찾는다 — **`import.meta.url` 기준으로 계산하지 않는다.**
 * ⚠️ 처음에 소스 위치(`packages/cli/src/commands`)에서 네 단계를 올라가도록 짰더니 **빌드된
 * `dist/`에서 깊이가 달라 `packages/docs/...`를 열려다 ENOENT로 죽었다.** 타입체크도 단위
 * 테스트도 못 잡는 축이고 **실제로 실행해 본 첫 순간에 드러났다.**
 * cwd에서 위로 올라가며 찾으면 소스·빌드·하위 디렉터리 실행이 모두 성립한다.
 */
function findDocPath(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, DEFAULT_DOC_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `${DEFAULT_DOC_RELATIVE}를 찾지 못했다 — 저장소 안에서 실행하거나 경로를 직접 넘긴다`,
      );
    }
    dir = parent;
  }
}

/** 마커 판정 실패를 `failureClass`로 옮긴다 — 네 갈래를 하나로 뭉개지 않는다. */
function markerFailure(kind: string): { failureClass: FailureClass; message: string } {
  switch (kind) {
    case "marker_missing":
      return { failureClass: "workflow_doc_marker_absent", message: "생성 구간 마커가 없다" };
    case "marker_duplicated":
      return { failureClass: "workflow_doc_marker_duplicated", message: "생성 구간 마커가 2회 이상 나온다" };
    default:
      return { failureClass: "workflow_doc_marker_out_of_order", message: ":end가 :start보다 앞에 있다" };
  }
}

function readCatalogState(catalogRoot: string | null | undefined): {
  state: CatalogState;
  rowsById: ReadonlyMap<string, IndexRowForLookup>;
  root: string | null;
} {
  const root =
    catalogRoot === undefined ? (readLocalConfig(resolveHomeContext())?.catalog_path ?? null) : catalogRoot;
  if (root === null) return { state: { kind: "absent" }, rowsById: new Map(), root: null };

  const { index, corrupted } = readCatalogIndexOrNull(root);
  if (corrupted) return { state: { kind: "corrupted" }, rowsById: new Map(), root };
  if (index === null) return { state: { kind: "absent" }, rowsById: new Map(), root };

  const rows: IndexRowForLookup[] = index.assets.map((a) => ({
    id: a.id,
    kind: a.kind,
    name: a.name,
    parent_asset_id: a.parent_asset_id,
  }));
  return { state: { kind: "available", rows }, rowsById: new Map(rows.map((r) => [r.id, r])), root };
}

/**
 * 자산 하나의 설명을 읽는다 — **화이트리스트가 1건으로 좁힌 뒤에만 불린다.**
 * `""`(값이 비었다)와 필드 부재를 갈라서 돌려준다(D-2).
 */
function makeDescribe(root: string | null, rowsById: ReadonlyMap<string, IndexRowForLookup>) {
  return (assetId: string): DescriptionLookup => {
    const row = rowsById.get(assetId);
    if (root === null || row === undefined) return { kind: "field_absent" };
    try {
      // ⚠️ 해시 세그먼트를 재구현하지 않는다 — `layout.ts`의 단일 관문을 거친다.
      const raw = readFileSync(path.join(root, assetJsonPath(row.kind, row.name, row.id)), "utf8");
      const parsed = JSON.parse(raw) as { description?: unknown };
      if (typeof parsed.description !== "string") return { kind: "field_absent" };
      return parsed.description.length === 0 ? { kind: "empty_string" } : { kind: "found", description: parsed.description };
    } catch {
      // 읽지 못한 것은 "설명이 없다"가 아니다. 그러나 이 자리에서 낼 수 있는 가장 정직한 값은
      // 필드 부재이고, 상위 요약이 그 건수를 따로 낸다.
      return { kind: "field_absent" };
    }
  };
}

/** 자산 하나의 판정을 셀 입력으로 바꾼다 — `resolved`만 렌더러를 타고 나머지는 문구로 넘긴다. */
function toCellInput(outcome: AssetOutcome): RowCellInput {
  return outcome.tag === "resolved"
    ? { kind: "described", asset: { description: outcome.description } }
    : { kind: "placeholder", text: describeOutcome(outcome) };
}

export function runWorkflowDoc(options: WorkflowDocOptions = {}): WorkflowDocReport {
  const docPath = options.docPath ?? findDocPath();
  const original = readFileSync(docPath, "utf8");

  const region = findGeneratedRegion(original);
  if (region.kind !== "ok") {
    const failure = markerFailure(region.kind);
    return { exitCode: 3, summary: null, rows: [], wrote: false, failure, lines: [`FAIL ${failure.failureClass}: ${failure.message}`] };
  }

  let located;
  try {
    located = locateTable(region.text);
  } catch (err) {
    if (err instanceof WorkflowDocError) {
      return {
        exitCode: 3,
        summary: null,
        rows: [],
        wrote: false,
        failure: { failureClass: err.failureClass, message: err.message },
        lines: [`FAIL ${err.failureClass}: ${err.message}`],
      };
    }
    throw err;
  }

  const refs = located.rows.flatMap((r) => r.assetRefs);

  // ⚠️ **미사용 예외 검사는 여기 두지 않는다.** 예외 맵의 신선도는 **정본 문서의 속성**이지
  // 이 커맨드의 런타임 계약이 아니다 — 런타임에 걸면 예외를 쓰지 않는 **부분 표·픽스처가 전부
  // exit 3**이 되어 가드가 기능을 죽인다(실제로 그렇게 짰다가 프로세스 테스트에서 걸렸다).
  // 검사는 정본 문서를 대상으로 `cli/test/workflow-assets-doc.test.ts`가 하고, 그 테스트는
  // `pnpm test`에 들어가 **CI가 실제로 부른다**(등재 = 도달). `findUnusedDocRefExceptions`는
  // 그쪽에서 쓰인다 — 소비자가 0이면 미배선이므로 그 사실을 여기 적어 둔다.

  const { state, rowsById, root } = readCatalogState(options.catalogRoot);
  const result = resolveWorkflowAssets(refs, state, makeDescribe(root, rowsById));
  const summary = summarizeOutcomes(result);

  // 자산 판정을 **행 단위로 다시 묶는다** — 판정은 자산 축, 조립만 행 축이다(D-6).
  let cursor = 0;
  const regionLines = region.text.split("\n");
  const rowReports: WorkflowDocRowReport[] = [];
  for (const row of located.rows) {
    const outcomes = result.outcomes.slice(cursor, cursor + row.assetRefs.length);
    cursor += row.assetRefs.length;
    const expected = renderWorkflowAssetRow(outcomes.map(toCellInput));
    const current = row.line.slice(row.lastCellStart, row.lastCellEnd).trim();
    rowReports.push({ lineIndex: row.lineIndex, current, expected, drifted: current !== expected });
    regionLines[row.lineIndex] = replaceLastCell(row, expected);
  }

  const drifted = rowReports.some((r) => r.drifted);
  let wrote = false;
  if (options.write === true && drifted) {
    const newRegion = regionLines.join("\n");
    // **출력 축 게이트 — 쓰기 전에 통과한다** (D-8).
    const leaks = findWorkflowDocLeaks(newRegion, GENERATED_OUTPUT_AXES);
    if (leaks.length > 0) {
      const message = `생성 구간에 개인 환경 데이터가 있다: ${leaks.map((l) => l.axis).join(", ")}`;
      return {
        exitCode: 3,
        summary,
        rows: rowReports,
        wrote: false,
        failure: { failureClass: "workflow_doc_parse_failed", message },
        lines: [`FAIL ${message}`],
      };
    }
    writeFileSync(docPath, original.slice(0, region.start) + newRegion + original.slice(region.end), "utf8");
    wrote = true;
  }

  const lines = [
    formatSummary(summary),
    ...rowReports.filter((r) => r.drifted).map((r) => `  드리프트 ${r.lineIndex}행: "${r.current}" → "${r.expected}"`),
  ];
  // **화면에 찍기 전에도 같은 게이트를 통과한다** — 막는 것과 보이는 것은 다른 축이고,
  // 진단 출력도 서드파티 `description`을 담는다.
  const outputLeaks = findWorkflowDocLeaks(lines.join("\n"), GENERATED_OUTPUT_AXES);
  const safeLines = outputLeaks.length > 0 ? [`FAIL 진단 출력에 개인 환경 데이터가 있다: ${outputLeaks.map((l) => l.axis).join(", ")}`] : lines;

  // 종료 코드는 **자산 전체의 max**에 드리프트를 얹는다. 실패(3)를 드리프트(1)로 낮추지 않는다.
  const driftCode: 0 | 1 = drifted && !wrote ? 1 : 0;
  const exitCode = (summary.exitCode > driftCode ? summary.exitCode : driftCode) as 0 | 1 | 2 | 3;

  return { exitCode, summary, rows: rowReports, wrote, failure: null, lines: safeLines };
}

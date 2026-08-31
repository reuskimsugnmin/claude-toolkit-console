import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assetJsonPath,
  describeOutcome,
  findGeneratedRegion,
  findWorkflowDocLeaks,
  GENERATED_OUTPUT_AXES,
  locateTable,
  PathTraversalDetectedError,
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
  /**
   * 미측정(카탈로그 없음·인덱스 손상)에서도 쓰기를 허용한다 — **기본은 거부**다.
   * 표를 일부러 "미측정"으로 표기하려는 용법에만 쓴다(보안 심사 H-3).
   */
  readonly allowUnmeasured?: boolean;
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
  /**
   * ⚠️ **`rows[].current`는 문서 원문 그대로이고 `gated()`를 거치지 않는다.**
   * 오늘 `bin/ctk.ts`는 `lines`만 찍으므로 살아 있는 유출은 아니다(보안 재심에서 확인).
   * **이 배열을 화면·파일·로그에 내보내는 소비자가 생기면 그때 `gated()` 범위에 넣는다** —
   * 소비자가 0인 동안은 축이 닫혀 있고, 하나라도 생기면 즉시 열린다.
   */
  readonly rows: readonly WorkflowDocRowReport[];
  readonly wrote: boolean;
  /** 구조적 실패 — `null`이면 구조는 정상이다. */
  readonly failure: { readonly failureClass: FailureClass; readonly message: string } | null;
  /** 화면에 찍을 줄들. **`gated()`를 거친 값만 여기 들어온다.** */
  readonly lines: readonly string[];
}

const DEFAULT_DOC_RELATIVE = "docs/workflow-assets.md";
/** 저장소 루트 앵커. `git worktree`의 `.git`은 파일이지만 `existsSync`는 true다. */
const REPO_ANCHORS = [".git", "pnpm-workspace.yaml"] as const;
const MAX_UPWARD_DEPTH = 32;

/**
 * ⚠️ **모든 반환은 이 함수를 거친다 (보안 심사 M-2).**
 *
 * 이전에는 "`lines`는 출력 게이트를 통과한 값"이라고 **주석으로 약속**했는데 반환 지점 4개 중
 * **3개가 게이트를 타지 않았다** — 조기 반환들이 `lines`를 직접 만들어 나갔고 그중 하나는
 * `table-locate`가 만든 **문서 원문 60~80자를 그대로 echo**했다(주입 실증: UUID가 출력에 실렸다).
 * 테스트는 `findWorkflowDocLeaks(` **호출 지점**을 셌지 **반환 지점**을 세지 않았다.
 * **약속을 주석이 아니라 타입으로 고정한다** — `lines`를 뺀 형태만 받는다.
 */
function gated(report: Omit<WorkflowDocReport, "lines">, lines: readonly string[]): WorkflowDocReport {
  const leaks = findWorkflowDocLeaks(lines.join("\n"), GENERATED_OUTPUT_AXES);
  return {
    ...report,
    lines:
      leaks.length > 0
        ? [`FAIL 진단 출력에 개인 환경 데이터가 있다: ${[...new Set(leaks.map((l) => l.axis))].join(", ")}`]
        : lines,
  };
}

/**
 * 문서를 찾는다 — **저장소 앵커 안에서만.**
 *
 * ⚠️ **보안 심사 M-1**: 이전에는 cwd에서 **상한 없이** 올라가며 첫 `docs/workflow-assets.md`를
 * 잡았고 심볼릭 링크를 관통해 썼다. 주입 실증: 저장소 밖 다섯 단계 위 파일을 덮어썼고
 * (`exit=2 wrote=true`), 링크를 걸면 링크는 그대로 두고 **대상 파일이 수정**됐다.
 * ⚠️ **`lstat`로 조이는 것은 이 저장소에서 이미 한 번 기능을 죽였다**(링크 스킬 54건). 여기서는
 * 대상이 자기 문서 1개뿐이라 안전하지만, **fail-closed에는 복구 경로를 함께 준다**(안전 원칙 6).
 *
 * (이전 결함도 남긴다) **`import.meta.url` 기준으로 계산하지 않는다.**
 * ⚠️ 처음에 소스 위치(`packages/cli/src/commands`)에서 네 단계를 올라가도록 짰더니 **빌드된
 * `dist/`에서 깊이가 달라 `packages/docs/...`를 열려다 ENOENT로 죽었다.** 타입체크도 단위
 * 테스트도 못 잡는 축이고 **실제로 실행해 본 첫 순간에 드러났다.**
 * cwd에서 위로 올라가며 찾으면 소스·빌드·하위 디렉터리 실행이 모두 성립한다.
 */
function findDocPath(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < MAX_UPWARD_DEPTH; depth += 1) {
    if (REPO_ANCHORS.some((anchor) => existsSync(path.join(dir, anchor)))) {
      const candidate = path.join(dir, DEFAULT_DOC_RELATIVE);
      if (!existsSync(candidate)) break;
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new WorkflowDocError(
          // **경로 통제이지 파싱이 아니다**(재심 경미 7). run-log에서 링크 공격 차단이
          // 표 서식 오류로 보이면 안 된다 — M-3에서 유출 축을 갈라낸 것과 같은 규율이다.
          "workflow_doc_path_rejected",
          `${DEFAULT_DOC_RELATIVE}가 심볼릭 링크다 — 링크를 관통해 쓰지 않는다. 실제 파일을 docPath로 넘긴다`,
        );
      }
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new WorkflowDocError(
    "workflow_doc_path_rejected",
    `${DEFAULT_DOC_RELATIVE}를 저장소 안에서 찾지 못했다 — 저장소 루트에서 실행하거나 docPath로 경로를 넘긴다`,
  );
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
      // ⚠️ **공백만인 값도 `empty_string`이다 (보안 심사 M-5).** `length === 0`만 보면 `"   "`가
      // `found`로 통과하고, 렌더러가 그것을 던져 **`failureClass` 없는 맨 `Error`**로 빠져나가
      // `bin/ctk.ts`의 마지막 fallback에서 **exit 1로 낮춰 보고**된다 — D-3이 막으려던 형태다.
      // **렌더러의 판정 규칙(`folded.length === 0`)과 같은 규칙을 입력 축에 건다.**
      return parsed.description.trim().length === 0
        ? { kind: "empty_string" }
        : { kind: "found", description: parsed.description };
    } catch (err) {
      // ⚠️ **읽지 못한 것은 "설명이 없다"가 아니다 (보안 심사 L-2).** 이전에는 둘을 `field_absent`로
      // 삼켰고, 특히 `assertCatalogSegment`의 경로 순회 거부가 **아무 신호 없이** "설명 없음"이 됐다 —
      // 기밀성 축으로는 fail-safe지만 **관측이 끊긴다.** 경로 거부는 **카탈로그 오염 신호**이므로
      // 단순 읽기 실패와 종료 코드까지 갈린다(3 vs 2).
      return {
        kind: "read_failed",
        reason: err instanceof PathTraversalDetectedError ? "path_rejected" : "io_error",
      };
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
  let docPath: string;
  try {
    docPath = options.docPath ?? findDocPath();
  } catch (err) {
    if (err instanceof WorkflowDocError) {
      return gated(
        { exitCode: 3, summary: null, rows: [], wrote: false, failure: { failureClass: err.failureClass, message: err.message } },
        [`FAIL ${err.failureClass}: ${err.message}`],
      );
    }
    throw err;
  }
  const original = readFileSync(docPath, "utf8");

  const region = findGeneratedRegion(original);
  if (region.kind !== "ok") {
    const failure = markerFailure(region.kind);
    return gated({ exitCode: 3, summary: null, rows: [], wrote: false, failure }, [
      `FAIL ${failure.failureClass}: ${failure.message}`,
    ]);
  }

  let located;
  try {
    located = locateTable(region.text);
  } catch (err) {
    if (err instanceof WorkflowDocError) {
      return gated(
        { exitCode: 3, summary: null, rows: [], wrote: false, failure: { failureClass: err.failureClass, message: err.message } },
        [`FAIL ${err.failureClass}: ${err.message}`],
      );
    }
    throw err;
  }

  const refs = located.rows.flatMap((r) => r.assetRefs);
  const { state, rowsById, root } = readCatalogState(options.catalogRoot);
  const result = resolveWorkflowAssets(refs, state, makeDescribe(root, rowsById));
  const summary = summarizeOutcomes(result);

  /**
   * ⚠️ **입력 축 게이트 (보안 심사 H-2).** 산출물만 검사하면 **절단 뒤의 조각**을 보게 된다 —
   * 상한 경계에 걸친 UUID가 36자 중 30자만 남은 채 게이트를 통과해 `exit=0 wrote=true`가 됐다
   * (주입 실증). `CLAUDE.md`가 이미 적어 둔 형태다: "상한에서 자른 버퍼의 마지막 원소는 줄이
   * 아니라 조각인데 두 판정 함수가 그것을 똑같이 줄로 읽어 게이트가 뚫렸다."
   * **원문에도 건다** — 산출물 게이트는 그대로 둔다(막는 것과 보이는 것은 다른 축).
   * 실측: 오늘의 21건 모집단에 **유출 0건**이라 정상이 위반으로 바뀌지 않는다.
   */
  const rawDescriptions = result.outcomes
    .filter((o): o is Extract<AssetOutcome, { tag: "resolved" }> => o.tag === "resolved")
    .map((o) => o.description);
  const inputLeaks = findWorkflowDocLeaks(rawDescriptions.join("\n"), GENERATED_OUTPUT_AXES);
  if (inputLeaks.length > 0) {
    const axes = [...new Set(inputLeaks.map((l) => l.axis))].join(", ");
    return gated(
      {
        exitCode: 3,
        summary,
        rows: [],
        wrote: false,
        failure: { failureClass: "workflow_doc_leak_detected", message: `자산 설명 원문에 개인 환경 데이터가 있다: ${axes}` },
      },
      [`FAIL workflow_doc_leak_detected: 자산 설명 원문에 개인 환경 데이터가 있다 (${axes})`],
    );
  }

  // 자산 판정을 **행 단위로 다시 묶는다** — 판정은 자산 축, 조립만 행 축이다(D-6).
  // L-4: `table-locate`와 **같은 분할 규칙**을 쓴다(CRLF 문서에서 줄바꿈이 섞이지 않게).
  let cursor = 0;
  const regionLines = region.text.split(/\r?\n/);
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
  // **두 축을 가른다** — 미측정(2)과 구조적 실패(3)는 처방이 다르다(재심 경미 1).
  const unmeasured = summary.exitCode === 2;
  const structuralFailure = summary.exitCode === 3;
  const notes: string[] = [];
  let wrote = false;

  if (options.write === true && drifted && structuralFailure) {
    // ⚠️ **재심 경미 1 — 두 축을 뭉개면 화면이 엉뚱한 처방을 준다.** 이전에는 `exitCode >= 2`
    // 하나로 묶어 `ambiguous`(3, 구조적 실패)에도 "`ctk scan`을 먼저 돌린다"고 말했다.
    // **`ctk scan`은 동명 충돌을 해소하지 못한다.** 차단은 옳았고 어긋난 것은 진단이다 —
    // 이 저장소의 R12("루프를 끊고도 화면이 재시도를 권했다")와 같은 형태다.
    notes.push(
      "판정 불가 자산이 있어 쓰지 않았다 — 같은 (kind, 플러그인, 이름)에 자산이 둘 이상이다. " +
        "`ctk scan`으로는 풀리지 않는다(표의 참조를 좁히거나 상류에서 이름을 갈라야 한다)",
    );
  } else if (options.write === true && drifted && unmeasured && options.allowUnmeasured !== true) {
    // ⚠️ **보안 심사 H-3** — 이전에는 카탈로그가 없어도 썼다(주입 실증: `exit=2 wrote=true`).
    // "미측정"이라 말하면서 16행을 자리표시자로 갈아엎었다. **판정할 수 없음으로 파일을
    // 갈아엎지 않는다.** fail-closed에는 **복구 경로를 함께** 준다(안전 원칙 6).
    // ⚠️ **실재하는 경로만 가리킨다**(재심 경미 2) — `--allow-unmeasured` CLI 플래그는 **없다.**
    // 노출하지 않는 것이 의도이므로 안내는 `ctk scan`만 말한다.
    notes.push("미측정이라 쓰지 않았다 — `ctk scan`을 먼저 돌린다");
  } else if (options.write === true && drifted) {
    const newRegion = regionLines.join("\n");
    // **출력 축 게이트 — 쓰기 전에 통과한다** (D-8).
    const leaks = findWorkflowDocLeaks(newRegion, GENERATED_OUTPUT_AXES);
    if (leaks.length > 0) {
      const axes = [...new Set(leaks.map((l) => l.axis))].join(", ");
      return gated(
        {
          exitCode: 3,
          summary,
          rows: rowReports,
          wrote: false,
          failure: { failureClass: "workflow_doc_leak_detected", message: `생성 구간에 개인 환경 데이터가 있다: ${axes}` },
        },
        [`FAIL workflow_doc_leak_detected: 생성 구간에 개인 환경 데이터가 있다 (${axes})`],
      );
    }
    // **백업 → 원자적 쓰기** (보안 심사 H-3). `actuator`가 아니라는 이유로 안전 원칙 1을
    // 건너뛰었으나 **파괴성은 계층 이름이 아니라 쓰기 여부가 정한다.** `writeFileSync`는
    // truncate 후 write라 중간에 죽으면 문서가 잘린 채 남는다 — 같은 디렉터리 rename은 원자적이다
    // (임시파일이 같은 디렉터리라 EXDEV도 불가능하다).
    const next = original.slice(0, region.start) + newRegion + original.slice(region.end);
    const backupPath = `${docPath}.bak`;
    // ⚠️ **백업을 덮어쓰지 않는다**(재심 경미 6). 두 번 돌리면 두 번째 백업이 첫 번째 산출물이
    // 되어 **생성 이전 원본이 사라진다** — 첫 실행이 잘못 썼는데 확인 전에 다시 돌리면 복구 불가다.
    if (!existsSync(backupPath)) writeFileSync(backupPath, original, "utf8");
    const tmpPath = `${docPath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, next, "utf8");
    renameSync(tmpPath, docPath);
    wrote = true;
    // 백업을 방금 썼거나 이미 있었으므로 여기서 존재는 확정이다 — **도달할 수 없는 분기를
    // 남기지 않는다.**
    notes.push(`백업: ${path.basename(backupPath)} (직전 1회분 — 이미 있으면 덮어쓰지 않는다)`);
  }

  const lines = [
    formatSummary(summary),
    ...notes,
    ...rowReports.filter((r) => r.drifted).map((r) => `  드리프트 ${r.lineIndex}행: "${r.current}" → "${r.expected}"`),
  ];

  // 종료 코드는 **자산 전체의 max**에 드리프트를 얹는다. 실패(3)를 드리프트(1)로 낮추지 않는다.
  const driftCode: 0 | 1 = drifted && !wrote ? 1 : 0;
  const exitCode = (summary.exitCode > driftCode ? summary.exitCode : driftCode) as 0 | 1 | 2 | 3;

  return gated({ exitCode, summary, rows: rowReports, wrote, failure: null }, lines);
}

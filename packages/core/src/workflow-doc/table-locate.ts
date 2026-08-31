import { parseFailed, whitelistOverflow } from "./errors.js";

/**
 * **매칭 전용** 표 위치 탐색 (B4-c · D-1′). 표를 **조립하지 않는다.**
 *
 * ⚠️ **이 파일에 표를 만드는 함수가 없다는 것이 D-1′의 구조적 보장이다.** 파서가 출력 경로에
 * 관여하지 않으므로 1·2열의 정렬 공백·굵게·산문·인라인 코드가 **읽히기만 하고 다시 쓰이지 않는다.**
 * 왕복 안정성을 테스트로 뒤늦게 잡는 대신 알고리즘의 성질로 만든다.
 *
 * ⚠️ **rev1이 틀렸던 곳(F-1)** — 규약이 "마지막 이스케이프되지 않은 `|` **이후** 구간"이었다.
 * 표 행 `| a | b |`에서 마지막 `|`는 **행을 닫는 파이프**이고 그 뒤는 빈 문자열이다. 실측:
 * `docs/workflow-assets.md`의 표 18줄이 **전부 파이프 3개**라, 그대로 짰다면 오늘 16행 전부에서
 * 치환 대상이 빈 구간이었다. **치환할 곳은 마지막 두 파이프 *사이*다.**
 */

/** 동적 화이트리스트의 상한 (D-9). 오늘 21건이다 — 표가 의도와 다르게 커지면 중단한다. */
export const MAX_WHITELIST_ASSETS = 64;

export interface AssetRef {
  /** 문서 표기상의 유형. 카탈로그 `kind`와 다를 수 있다 — `revise-claude-md`는 Skill로 적히지만 kind는 command다. */
  readonly kindLabel: "Skill" | "Agent";
  readonly plugin: string;
  readonly name: string;
  /** 원문 표기 그대로 — 진단 메시지에 쓴다. */
  readonly raw: string;
}

export interface LocatedRow {
  /** 생성 구간 기준 줄 번호(0-based). */
  readonly lineIndex: number;
  readonly line: string;
  /** 마지막 셀 **본문**의 시작 오프셋 — 끝에서 두 번째 `|` **다음** 문자. */
  readonly lastCellStart: number;
  /** 마지막 셀 **본문**의 끝 오프셋 — 행을 닫는 마지막 `|`의 위치. */
  readonly lastCellEnd: number;
  readonly assetRefs: readonly AssetRef[];
}

export interface LocatedTable {
  readonly headerLineIndex: number;
  readonly separatorLineIndex: number;
  /** 데이터 행만 — 헤더·구분자는 치환 대상이 아니다. */
  readonly rows: readonly LocatedRow[];
}

/**
 * 이스케이프되지 않은 `|`의 위치.
 *
 * ⚠️ **GFM에서 백틱은 `|`를 보호하지 않는다 (F-4).** `` | a | `x|y` | b | ``는 **4셀로 렌더된다** —
 * 셀 안에 `|`를 넣는 유일한 방법은 `\|`다. 따라서 **이 스캐너는 백틱을 보지 않는다.**
 * "백틱 안 파이프는 무시"하는 직관적 구현은 **렌더러와 다르게 세어** 전제 가드를 뚫는다.
 */
export function unescapedPipeIndexes(line: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "|") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) backslashes += 1;
    if (backslashes % 2 === 0) positions.push(i);
  }
  return positions;
}

/** 백틱 스팬 하나가 자산 참조로 **완전 일치**할 때만 인정한다. */
const BACKTICK_SPAN = /`([^`]*)`/g;
const ASSET_REF_EXACT = /^(Skill|Agent)\(([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)\)$/;

/**
 * 행에서 자산 참조를 뽑는다.
 *
 * ⚠️ **규칙을 뒤집었다 (M-7).** "`kindLabel`이 `Skill`·`Agent`가 아니면 던진다"는 **오늘 깨진다** —
 * `docs/workflow-assets.md`의 보안 검토 행 2열에는 자산 참조가 아닌 `` `actuator` ``가 있고,
 * 다른 행에는 `— READ-ONLY`·`**필수**` 같은 산문도 있다. **완전 일치하는 스팬만 참조로 보고
 * 나머지는 무시한다.** 대신 **행당 참조가 0건이면 던진다** — 조용한 누락을 막는 자리는 거기다.
 */
export function extractAssetRefs(line: string): AssetRef[] {
  const refs: AssetRef[] = [];
  const re = new RegExp(BACKTICK_SPAN.source, BACKTICK_SPAN.flags);
  let span: RegExpExecArray | null;
  while ((span = re.exec(line)) !== null) {
    const inner = span[1] ?? "";
    const match = ASSET_REF_EXACT.exec(inner);
    if (match === null) continue; // 산문·다른 인라인 코드는 무시한다
    refs.push({
      kindLabel: match[1] as "Skill" | "Agent",
      plugin: match[2] ?? "",
      name: match[3] ?? "",
      raw: inner,
    });
  }
  return refs;
}

/** 구분자 행(`|---|---|`) 판별. */
function isSeparatorRow(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-");
}

/**
 * 전제 가드 — 치환 가능한 행인가.
 *
 * 행이 `|`로 시작하고 `|`로 끝나며 이스케이프되지 않은 `|`가 **4개 이상**일 때만 치환한다.
 * ⚠️ **말미 `|`가 없는 GFM 행도 합법이다.** 그것이 섞이면 "마지막 두 파이프 사이"가 **2열**이
 * 되어 손유지 내용을 지운다 — D-1′에 남은 **유일한 파괴 경로**라 여기서 막는다.
 * 건너뛰지 않고 `parse_failed`를 던지는 이유는 "판정할 수 없음"을 "해당 없음"으로 삼키지
 * 않기 위해서다(안전 원칙 7).
 */
function assertReplaceable(line: string, lineIndex: number, pipes: readonly number[]): void {
  if (!/^\s*\|/.test(line)) {
    throw parseFailed(`${lineIndex}번째 표 행이 \`|\`로 시작하지 않는다(파이프 ${pipes.length}개)`);
  }
  if (!/\|\s*$/.test(line)) {
    throw parseFailed(
      `${lineIndex}번째 표 행이 \`|\`로 끝나지 않는다(파이프 ${pipes.length}개) — 말미 파이프 없는 GFM 행은 마지막 두 파이프 사이가 2열이 되어 손유지 내용을 지운다`,
    );
  }
  if (pipes.length < 4) {
    throw parseFailed(
      `${lineIndex}번째 표 행의 이스케이프되지 않은 파이프가 ${pipes.length}개다 — 3열 골격(4개 이상)이 필요하다. 최초 1회는 사람이 골격을 만든다`,
    );
  }
}

/**
 * 생성 구간 문자열에서 표를 찾는다.
 *
 * @throws `workflow_doc_parse_failed` 표 행이 0개이거나 행 구조가 전제 가드를 벗어났을 때.
 * @throws `workflow_doc_whitelist_overflow` 자산 참조 수가 상한을 넘었을 때.
 */
export function locateTable(regionText: string, maxAssets: number = MAX_WHITELIST_ASSETS): LocatedTable {
  const lines = regionText.split(/\r?\n/);
  const pipeLines = lines
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(({ line }) => /^\s*\|/.test(line));

  if (pipeLines.length === 0) {
    // **"0건 일치"로 삼키지 않는다** — 정규식이 빈손이면 이 모듈 전체가 공허하다.
    throw parseFailed("생성 구간에서 표 행을 하나도 찾지 못했다 — 마커 위치나 표 서식을 확인한다");
  }

  const separatorAt = pipeLines.findIndex(({ line }) => isSeparatorRow(line));
  if (separatorAt === -1) {
    throw parseFailed("표 구분자 행(`|---|---|`)을 찾지 못했다");
  }
  if (separatorAt === 0) {
    throw parseFailed("표에 헤더 행이 없다 — 구분자 행이 첫 표 행이다");
  }

  const headerLineIndex = pipeLines[separatorAt - 1]?.lineIndex ?? 0;
  const separatorLineIndex = pipeLines[separatorAt]?.lineIndex ?? 0;

  const rows: LocatedRow[] = [];
  let refCount = 0;
  for (const { line, lineIndex } of pipeLines.slice(separatorAt + 1)) {
    const pipes = unescapedPipeIndexes(line);
    assertReplaceable(line, lineIndex, pipes);

    const assetRefs = extractAssetRefs(line);
    if (assetRefs.length === 0) {
      throw parseFailed(
        `${lineIndex}번째 데이터 행에서 자산 참조를 하나도 찾지 못했다 — \`Skill(plugin:name)\` 형태의 백틱 스팬이 필요하다`,
      );
    }
    refCount += assetRefs.length;
    if (refCount > maxAssets) throw whitelistOverflow(refCount, maxAssets);

    // ⚠️ **마지막 두 파이프 *사이*가 치환 대상이다** — 마지막 파이프 "이후"가 아니다(F-1).
    const lastPipe = pipes[pipes.length - 1] ?? 0;
    const secondLastPipe = pipes[pipes.length - 2] ?? 0;
    rows.push({
      lineIndex,
      line,
      lastCellStart: secondLastPipe + 1,
      lastCellEnd: lastPipe,
      assetRefs,
    });
  }

  if (rows.length === 0) {
    throw parseFailed("표에 데이터 행이 하나도 없다 — 헤더와 구분자만 있다");
  }

  return { headerLineIndex, separatorLineIndex, rows };
}

/**
 * 한 행의 마지막 셀만 바꾼 새 줄을 만든다 — **접두사와 말미 파이프는 원본 바이트 그대로다.**
 * 이것이 "1·2열을 다시 쓰지 않는다"의 구현이고, 테스트가 아니라 **문자열 슬라이싱이 보장한다.**
 */
export function replaceLastCell(row: LocatedRow, cellText: string): string {
  const prefix = row.line.slice(0, row.lastCellStart);
  const suffix = row.line.slice(row.lastCellEnd);
  return `${prefix} ${cellText} ${suffix}`;
}

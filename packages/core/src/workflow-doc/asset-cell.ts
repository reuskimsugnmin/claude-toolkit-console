import type { Asset } from "../schema/asset.js";
import { WorkflowDocError } from "./errors.js";

/**
 * 문서로 나가는 **모든 문자열의 단일 관문** (B4-c · D-4).
 *
 * ⚠️ **입력 타입이 `Pick<Asset, "description">`인 것이 이 모듈의 보안 설계다.**
 * `id`·`marketplace`·`parent_asset_id`·`source_ref`가 **타입에 아예 없으므로** 미래의 호출자도
 * 그것을 문서에 실을 방법이 없다. public 저장소에 "설치된 툴 목록"을 커밋하지 않는다는 규칙을
 * 게이트가 아니라 **구조로** 지킨다 — `catalog/layout.ts`의 `assertCatalogSegment`가 모든 export를
 * 단일 관문에 태우는 것과 같은 태도다(위생 게이트는 이 축을 못 본다고 스스로 적어 두었다).
 */

/**
 * 자산당 상한(자소 수). **실측 2026-08-31 — 모집단 21건: 최대 172 · 중앙값 73 · 최소 49.**
 * ⚠️ **오늘의 표본은 이 상한에 닿지 않는다** — 절단 경로는 실제 데이터로 태울 수 없고 합성
 * 주입으로만 검증된다. "미측정"이 아니라 "모집단이 상한 아래"이지만, 상류 설명이 길어지면
 * 그때 처음 도는 코드라는 뜻이다. **모집단을 함께 적는다**(안전 원칙 8).
 */
export const DEFAULT_ASSET_CELL_LIMIT = 200;

/**
 * 셀 총합 상한(이스케이프 **후** 문자 수). 오늘 최대 행은 3자산(`debug`·`debugger`·`tracer`)
 * 합 **329자**라 이 상한에도 닿지 않는다.
 *
 * ⚠️ **두 상한의 단위가 다르다.** 자산당은 **이스케이프 전 자소 수**(사람이 읽는 길이),
 * 총합은 **이스케이프 후 문자 수**(실제 셀 폭)다. 절단이 이스케이프보다 **앞**에 오므로
 * (`&` → `&amp;`는 1→5자) 최종 길이는 자산당 상한을 넘을 수 있다 — 마크다운 셀에 길이 제한이
 * 없어 표는 깨지지 않지만, 총합은 가독성을 묶는 값이라 실제 폭으로 재야 한다.
 */
export const DEFAULT_ROW_CELL_LIMIT = 400;

/** 여러 자산을 한 셀에 이을 때의 구분자 — **양쪽 공백 고정**이라 description 안의 `·`와 헷갈리지 않는다. */
export const ASSET_SEPARATOR = " · ";

/**
 * 표 셀은 한 줄이 한 행이다 — 개행을 접고 연속 공백을 하나로 줄인다.
 * (D-4 규칙 1. 이스케이프보다 **먼저** 한다.)
 */
function foldToSingleLine(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(CONTROL_AND_FORMAT, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ⚠️ **보안 심사 H-1 — 이스케이프가 보지 않던 축.** `escapeCell`은 `& \ | < >` 다섯 문자만
 * 다루고 `\s+`는 JS 정의상 **ESC(U+001B)·BEL(U+0007)을 매치하지 않는다.** 그래서 서드파티
 * `description`의 터미널 제어문자가 **문서와 사용자 터미널에 원문 그대로** 나갔다(주입 실증:
 * OSC 8 하이퍼링크 위장 — 표시는 `click`, 링크는 공격자 URL). bidi 오버라이드(Trojan Source)와
 * 제로폭 문자도 같은 구멍으로 통과했다.
 *
 * **치환이 아니라 제거**다 — 표시 가능한 대체 문자를 넣으면 셀 폭 계산이 또 어긋난다.
 * ⚠️ **두 문자를 일부러 뺐다 — 지우면 정당한 것을 죽인다(재심 경미 3·4):**
 * - **U+200D(ZWJ)** — 지우면 ZWJ 이모지가 반토막 나 `truncateByGrapheme`가 지키려는 것을
 *   이 규칙이 죽인다. **두 규칙이 서로를 죽이지 않는지 반대 축 테스트가 본다.**
 * - **U+200C(ZWNJ)** — **페르시아어·힌디어 정서법에 필수**다(빼면 단어 의미가 바뀐다).
 *   보안 위협이 아니고 표를 깨지도 못한다. 처음에는 지우고 있었다 — **과잉 방어였다.**
 *
 * 거꾸로 **U+061C(ARABIC LETTER MARK)를 빠뜨렸었다** — RLM(U+200F)의 아랍어 대응이라
 * RLM/LRM을 덮은 이상 여기만 비는 것은 **축의 누락**이다. 이제 Bidi_Control 12자를 전부 덮는다.
 * `asset-cell.ts`가 `-`/`#`/`-->`를 "축이 아니다"로 옳게 배제했으면서 **실제로 위험한 축인
 * C0/C1·Cf를 열거하지 않은 것**이 이 결함의 형태다.
 */
const CONTROL_AND_FORMAT =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u061C\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/**
 * 자소(grapheme) 경계로 자른다 — `Array.from`(코드 포인트)은 서로게이트만 막고 **ZWJ 이모지·
 * 결합문자·이형 선택자는 반토막 낸다.** 끝에 남은 ZWJ가 뒤이어 붙는 `…`와 결합하기도 한다.
 * (D-4 규칙 2. 이스케이프보다 **먼저** 한다 — 순서가 이 함수의 핵심이다, 아래 참조.)
 */
function truncateByGrapheme(text: string, limit: number): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = Array.from(segmenter.segment(text), (s) => s.segment);
  if (graphemes.length <= limit) return text;
  return `${graphemes.slice(0, limit).join("")}…`;
}

/**
 * 셀 이스케이프 (D-4 규칙 3). **실행 순서가 규칙 자체다:**
 *
 * 1. `&` → `&amp;` **가장 먼저.** 없으면 입력에 든 `&lt;script&gt;`가 3-ii를 그냥 통과하고
 *    **렌더 시점에 `<script>`로 복원된다** — "마크다운은 raw HTML을 통과시킨다"는 근거가 무력화된다.
 * 2. `\` → `\\`를 `|`보다 **먼저.** 뒤집으면 `\|`가 `\\|`로 바뀌어 열이 갈라진다.
 * 3. `|` → `\|`.
 * 4. `<`·`>` → 엔티티.
 *
 * 백틱은 이스케이프하지 않고 **셀을 코드 스팬으로 감싸지도 않는다** — 감싸면 홀수 백틱이 표를 깬다.
 * 셀 선두 `-`/`#`와 `-->`는 **축이 아니다**: 표 셀은 인라인 문맥이라 목록·제목이 되지 않고,
 * `-->`는 규칙 4가 `>`를 잡으므로 HTML 주석 마커를 깨지 못한다. **과잉 방어를 넣지 않는다.**
 */
function escapeCell(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 자산 하나의 설명을 표 셀에 안전한 한 줄로 만든다.
 *
 * **순서: 접기 → 절단 → 이스케이프.** ⚠️ 절단이 이스케이프 **뒤**에 오면 `&gt;`가 `&g`로,
 * `\|`가 `\`로 반토막 난다 — **끝에 남은 홑 `\`가 셀을 닫는 `|`를 이스케이프해 행이 통째로 깨진다.**
 * 이 함수가 가장 막고 싶어하는 사고를 순서 하나로 스스로 만들 수 있다.
 *
 * @throws 설명이 비어 있으면 던진다 — **렌더러는 "비었다"를 만들어 내지 않는다.**
 *         `""`와 필드 부재는 호출부가 **입력 단계에서** `no_description`으로 가른다(D-2).
 */
export function renderWorkflowAssetCell(
  input: Pick<Asset, "description">,
  graphemeLimit: number = DEFAULT_ASSET_CELL_LIMIT,
): string {
  const description = input.description;
  if (description === undefined || description.length === 0) {
    // 맨 `Error`는 `bin/ctk.ts`의 마지막 fallback에 떨어져 **구조적 실패가 exit 1로 낮춰
    // 보고된다**(보안 심사 M-5). `failureClass`를 달아 그 경로를 막는다.
    throw new WorkflowDocError(
      "workflow_doc_parse_failed",
      "renderWorkflowAssetCell에 빈 설명이 들어왔다 — 호출부가 no_description으로 갈랐어야 한다(D-2)",
    );
  }
  const folded = foldToSingleLine(description);
  if (folded.length === 0) {
    throw new WorkflowDocError(
      "workflow_doc_parse_failed",
      "설명이 공백만으로 이루어져 있다 — 호출부가 no_description으로 갈랐어야 한다(D-2)",
    );
  }
  return escapeCell(truncateByGrapheme(folded, graphemeLimit));
}

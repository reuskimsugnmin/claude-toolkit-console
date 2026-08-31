/**
 * 생성 구간 마커 — `docs/workflow-assets.md`의 어디까지가 `ctk workflow-doc`의 영역인가 (B4-c).
 *
 * ⚠️ **마커는 탐색 경계로만 쓴다.** 구간 안이라도 각 행에서 **마지막 두 개의 이스케이프되지 않은
 * `|` 사이**만 치환하고 그 앞 바이트는 다시 쓰지 않는다(D-1′). 마커가 "이 안은 전부 생성물"을
 * 뜻하지 않는 이유다 — 1·2열은 마커 **안에** 있지만 사람이 손으로 유지한다.
 *
 * ⚠️ **이 모듈은 Step 1에 있다.** 마커 판정을 테스트 안에 두면 Step 2의 파서가 그 **사본**을
 * 만들게 되고, 이 저장소는 "단일 관문을 선언해 놓고 사본을 남기면 원본의 정정이 사본에 도달하지
 * 않는다"에 반복해 데였다. **표 파서는 여전히 Step 2에만 있다** — 여기는 문자열 경계 판정뿐이다.
 */

export const GENERATED_REGION_START = "<!-- ctk:generated:workflow-assets:start -->";
export const GENERATED_REGION_END = "<!-- ctk:generated:workflow-assets:end -->";

/**
 * 마커 판정 결과 — **"없음"과 "실패"를 뭉개지 않는다**(안전 원칙 7).
 * 빈 구간을 돌려주고 호출자가 "0행"으로 읽게 두면, 마커가 깨진 문서가 조용히 통과한다.
 */
export type GeneratedRegion =
  | { readonly kind: "ok"; readonly start: number; readonly end: number; readonly text: string }
  | { readonly kind: "marker_missing"; readonly which: "start" | "end" | "both" }
  | { readonly kind: "marker_duplicated"; readonly which: "start" | "end"; readonly count: number }
  | { readonly kind: "marker_out_of_order" };

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * 생성 구간을 찾는다. `text`는 문서 전문이고, 반환의 `start`/`end`는 **구간 본문**의
 * 바이트 오프셋이다(마커 자체는 포함하지 않는다).
 */
export function findGeneratedRegion(text: string): GeneratedRegion {
  const startCount = countOccurrences(text, GENERATED_REGION_START);
  const endCount = countOccurrences(text, GENERATED_REGION_END);

  if (startCount === 0 && endCount === 0) return { kind: "marker_missing", which: "both" };
  if (startCount === 0) return { kind: "marker_missing", which: "start" };
  if (endCount === 0) return { kind: "marker_missing", which: "end" };
  if (startCount > 1) return { kind: "marker_duplicated", which: "start", count: startCount };
  if (endCount > 1) return { kind: "marker_duplicated", which: "end", count: endCount };

  const startIdx = text.indexOf(GENERATED_REGION_START) + GENERATED_REGION_START.length;
  const endIdx = text.indexOf(GENERATED_REGION_END);
  if (endIdx < startIdx) return { kind: "marker_out_of_order" };

  return { kind: "ok", start: startIdx, end: endIdx, text: text.slice(startIdx, endIdx) };
}

/**
 * 구간 밖(앞·뒤)을 잇는다 — 「쓰지 않는 것」 같은 **정책 절이 마커 밖에 있는가**를 검사할 때 쓴다.
 * "문서 어딘가에 있다"가 아니라 **밖에** 있어야 한다. 안에 있으면 다음 `--write`가 지운다.
 */
export function outsideGeneratedRegion(text: string, region: GeneratedRegion): string | null {
  if (region.kind !== "ok") return null;
  return text.slice(0, text.indexOf(GENERATED_REGION_START)) + text.slice(region.end);
}

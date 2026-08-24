/**
 * core/src/view/asset-doc-state.ts — "이 자산의 문서가 왜 없는가"의 4상태와 그 표시 규약.
 *
 * **왜 이 타입이 필요한가.** 콘솔은 문서가 없는 자산을 전부 "문서가 아직 생성되지 않았다"
 * 한 문장으로 보여주고 있었다. 그런데 사유는 셋으로 갈리고 **사용자가 할 일이 각각 다르다** —
 * 실측(2026-08-24) 기준 미실행 117건 · 원본 없음 12건 · 위생 거부 52건. "돈만 내면 되는 것"과
 * "영영 못 만드는 것"이 같은 배지를 달고 있으면 사용자는 무엇을 해야 할지 알 수 없다
 * (안전 원칙 7 — "없음"과 "실패"를 구분한다).
 *
 * **저장하지 않고 계산한다.** 사유 중 둘(`source_missing`·`blocked`)은 **이 머신의 파일
 * 배치**에 대한 사실이다 — 같은 자산이 다른 머신에서는 심볼릭 링크가 아닐 수 있다. 반면
 * 문서 생성 여부는 카탈로그(머신 독립) 사실이다. **공유 카탈로그에 사유를 저장하면 축을
 * 섞는다**(스키마의 척추). 그래서 이 값은 조회 시점에 계산하고 어디에도 쌓지 않는다.
 *
 * 판정은 `gen`의 `classifyAssetDocState`가 **단독으로** 한다. 이 파일은 그 결과를 담는 타입과
 * 표시 문구만 갖는다(I/O 없음).
 */

/** `pending_generation`을 유발한 원인. 셋 다 "`ctk gen`을 돌리면 된다"로 수렴하지만 맥락이 다르다. */
export type AssetDocPendingTrigger =
  | "new" // 만든 적이 없다
  | "changed" // 문서는 있는데 원본이 그 뒤로 바뀌었다
  | "stale"; // 직전 생성이 실패해 다시 만들어야 한다

export type AssetDocState =
  /** 최신 문서가 있다. */
  | { kind: "generated" }
  /** 만들 수 있고 아직 안 만들었다 — 유료 실행이 필요하다. */
  | { kind: "pending_generation"; trigger: AssetDocPendingTrigger }
  /** 자산은 카탈로그에 있는데 원본(`SKILL.md`·`README` 등)을 찾지 못했다 — 드리프트 의심. */
  | { kind: "source_missing" }
  /**
   * 이 자산 **유형**에는 로컬에 읽을 정형 원문 파일이 없다(mcp·cli).
   *
   * ⚠️ **`source_missing`과 섞지 않는다.** 실측(2026-08-24) 12건 중 6건이 이것이었고, 화면은
   * 그 6건에도 "드리프트인지 확인하라"고 말하고 있었다 — **실행 불가능한 조언**이다. 사라진
   * 것이 아니라 애초에 그런 파일이 없다. mcp 4건·cli 2건 전부 `Asset.description`이 비어
   * 있었으므로(유형 전체 0%) 원문의 진짜 소재지는 카탈로그 밖이다(MCP는 서버 런타임
   * instructions, CLI는 `--help`).
   */
  | { kind: "no_local_source" }
  /**
   * 같은 id의 원문이 여러 곳에 있고 **내용이 서로 다르다** — 어느 것이 진짜인지 판정 불가.
   *
   * 내용이 같으면 이 상태가 아니다(그때는 읽어서 생성한다). `location_count`는 이 머신의
   * 파일 배치 사실이므로 계산해서 보여줄 뿐 카탈로그에 저장하지 않는다.
   */
  | { kind: "ambiguous_source"; location_count: number }
  /**
   * 위생 검사가 원문 읽기를 거부했다.
   *
   * ⚠️ `reason`은 `gen`이 **경로를 제거한 뒤** 넘긴 문자열이다. 이 값은 무인증 조회 채널로
   * 브라우저까지 나가므로 절대경로가 섞이면 디렉터리 구조가 노출된다(심사 L-b).
   * 여기서 새로 문자열을 조립할 때도 경로를 만들어 넣지 않는다.
   */
  | { kind: "blocked"; failure_class: string; reason: string };

/**
 * 원문을 구하지 못한 사유. **`AssetDocState`의 kind와 문자열이 같다** — `gen`이 산출한 사유를
 * 화면 상태로 옮길 때 매핑 표를 하나 더 두면 그 표가 조용히 드리프트한다.
 *
 * 이 타입이 `core`에 있는 이유: `gen`(판정)과 `cli`·`web`(표시)이 **같은 라벨**을 써야 하는데,
 * `cli`는 `gen`을 임포트하지만 `web`의 UI 스크립트는 JSON만 받는다. 라벨 출처가 갈리면
 * 같은 자산이 CLI에서는 "원본 없음", 화면에서는 다른 말이 된다.
 */
export type UnresolvedSourceReason = "source_missing" | "no_local_source" | "ambiguous_source";

/**
 * 사유 하나의 배지 문구. **`describeAssetDocState`를 거쳐서** 얻는다 — 라벨을 여기 다시
 * 적으면 두 곳이 갈린다. `location_count`는 label에 쓰이지 않으므로 0을 넣어도 무방하다.
 */
export function unresolvedReasonLabel(reason: UnresolvedSourceReason): string {
  return describeAssetDocState(
    reason === "ambiguous_source" ? { kind: reason, location_count: 0 } : { kind: reason },
  ).label;
}

export interface AssetDocStateDisplay {
  /** 배지 문구 — 짧게. */
  label: string;
  /** 무슨 상태인지. */
  detail: string;
  /** **사용자가 할 일.** 상태마다 다르다 — 이게 이 타입이 존재하는 이유다. */
  action: string;
}

/**
 * 표시 문구를 만든다. **모든 분기가 세 필드를 다 채운다** — `action`이 비면 화면은 다시
 * "없다"만 말하는 상태로 돌아간다(안전 원칙 6 — 진단에는 빠져나갈 길을 함께 준다).
 *
 * 반환값에 경로·자산 이름을 넣지 않는다. 호출자가 이름을 붙이고 싶으면 `textContent`로
 * 따로 넣는다(카탈로그 문서는 서드파티 원문 기반이므로 `innerHTML` 금지).
 */
export function describeAssetDocState(state: AssetDocState): AssetDocStateDisplay {
  switch (state.kind) {
    case "generated":
      return {
        label: "문서 있음",
        detail: "원본과 일치하는 문서가 생성돼 있다.",
        action: "그대로 쓰면 된다.",
      };
    case "pending_generation":
      return {
        label: "생성 대기",
        detail: pendingDetail(state.trigger),
        action: "`ctk gen`으로 생성한다 — 유료 실행이므로 비용 견적과 승인을 거친다. `--max-assets N`으로 나눠 돌릴 수 있다.",
      };
    case "source_missing":
      return {
        label: "원본 없음",
        detail: "자산은 카탈로그에 있는데 문서를 만들 원본(SKILL.md · README 등)을 찾지 못했다.",
        action: "원본이 실제로 지워졌는지(드리프트) 확인한다 — `ctk doctor --drift`. 지워졌다면 생성 대상이 아니라 정리 대상이다.",
      };
    case "no_local_source":
      return {
        label: "유형상 원문 없음",
        detail: "이 자산 유형(MCP 서버 · CLI)은 로컬에 읽을 정형 원문 파일이 없다. 사라진 것이 아니라 애초에 없다.",
        action: "조사할 것이 없다 — 드리프트가 아니다. 이 유형의 설명은 카탈로그 밖(MCP는 서버 런타임, CLI는 `--help`)에 있고 v1은 그것을 읽지 않는다.",
      };
    case "ambiguous_source":
      return {
        label: "중복 설치 · 내용 불일치",
        detail: `같은 이름의 원문이 이 머신 ${state.location_count}곳에 있고 내용이 서로 다르다 — 어느 것이 진짜인지 판정할 수 없다.`,
        action: "중복 중 하나를 지우거나 이름을 갈라 충돌을 없앤다. 내용이 완전히 같아지면 그때는 자동으로 생성 대상이 된다.",
      };
    case "blocked":
      return {
        label: "위생 거부",
        detail: `위생 검사가 원문 읽기를 거부했다 (${state.failure_class}). 스킬 원본이 심볼릭 링크인 경우가 흔한 사유다.`,
        action: "돈을 써도 만들어지지 않는다 — 정책 결정이 필요하다. 링크 대상을 허용할 범위를 정하는 문제이며, 지금은 거부가 안전한 기본값이다.",
      };
  }
}

function pendingDetail(trigger: AssetDocPendingTrigger): string {
  switch (trigger) {
    case "new":
      return "아직 한 번도 생성하지 않았다.";
    case "changed":
      return "문서가 있으나 그 뒤로 원본이 바뀌어 최신이 아니다.";
    case "stale":
      return "직전 생성이 실패해 다시 만들어야 한다.";
  }
}

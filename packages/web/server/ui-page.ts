/**
 * web/server/ui-page.ts — 조회 콘솔의 UI 한 장. **의존성 0**(OQ-5 결정, 2026-08-22).
 *
 * 화면이 3개(자산 목록·자산 상세·사용량)뿐이고 데이터는 이미 JSON API로 나오므로, 빌드
 * 파이프라인과 번들 산출물을 새로 들이는 대신 문자열 한 장을 서빙한다. `web/server`는
 * `node:fs`·`node:path` import가 lint로 금지돼 있어(경로 순회 방지) 파일을 읽을 수도 없다 —
 * UI가 **모듈 안의 상수**인 것이 그 제약과도 맞는다.
 *
 * ## 이 화면이 지키는 것
 *
 * 뷰모델이 애써 구분해 보낸 사실을 화면에서 도로 뭉개지 않는다:
 * - `unmeasured`는 "미측정"으로 쓰고 **0으로 쓰지 않는다.**
 * - MCP의 `unknown`은 "모름"이고 `unset`은 "설정 안 됨"이다. 둘을 같은 배지로 칠하지 않는다.
 * - 순위 자격이 없으면 **순위표보다 먼저** 그 사실을 띄운다.
 * - `repo.url === null`(로컬 출처)은 링크를 만들지 않고 "로컬"이라고 적는다 — 죽은 링크를
 *   렌더하면 사용자는 클릭하고 나서야 없다는 걸 안다.
 *
 * 값은 전부 `textContent`로 넣는다(`innerHTML` 금지). 카탈로그 문서는 서드파티 원문 기반
 * 자동 생성물이므로(gen_source_trust) 그 안의 문자열을 마크업으로 해석하면 안 된다.
 */
import { AssetKindSchema, unresolvedReasonLabel, type UnresolvedSourceReason } from "@ctk/core";

/**
 * 미해결 사유의 배지 문구를 **`core`에서 받아** UI 스크립트에 주입한다.
 *
 * ⚠️ 여기에 문자열을 다시 적지 않는다. UI는 브라우저 스크립트라 `core`를 임포트할 수 없고,
 * 그 틈에 라벨을 복사해 두면 같은 자산이 CLI에서는 한 말, 화면에서는 다른 말이 된다 —
 * 이 저장소가 반복해서 만난 드리프트다. 렌더 시점에 주입하면 출처가 하나로 유지된다.
 */
const UNRESOLVED_LABELS: Record<UnresolvedSourceReason, string> = {
  source_missing: unresolvedReasonLabel("source_missing"),
  no_local_source: unresolvedReasonLabel("no_local_source"),
  ambiguous_source: unresolvedReasonLabel("ambiguous_source"),
};

/**
 * `<select id="kind">`의 종류 옵션 — **B1 Step 2(결정 2 #20)**. 이전에는 `<option>` 4줄이 HTML
 * 문자열에 그대로 박혀 있었다. 타입체크는 문자열 리터럴 안을 보지 않으므로 `AssetKind`가 값을
 * 얻어도 이 목록은 컴파일에서 절대 깨지지 않는다 — **타입 축이 안 닿는 자리다.** `AssetKindSchema`
 * 에서 유도해 렌더 시점에 주입한다(위 `UNRESOLVED_LABELS`와 같은 패턴). 누락 여부는 런타임
 * 테스트(`buildUiPage()`의 결과에 `AssetKindSchema.options` 전 값이 있는지 단언)가 지킨다.
 */
const KIND_OPTIONS_HTML = AssetKindSchema.options.map((kind) => `<option value="${kind}">${kind}</option>`).join("\n        ");

function renderUiHtml(nonce: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ctk — 툴 콘솔</title>
<style>
  /* ── 토큰 (B3 Step 6a) ───────────────────────────────────────────────────
     웹폰트도 외부 이미지도 못 불러온다(CSP에 font-src·img-src가 없어 default-src 'none'으로
     떨어진다). 그래서 개성은 서체가 아니라 **정보 밀도와 상태 체계**가 만든다.

     ⚠️ 대비는 실측했다 — 텍스트/배경 16개 조합(8쌍 × 라이트/다크)이 전부 본문 기준 4.5:1을
     넘는다. **가장 빠듯한 곳은 라이트의 accent on bg로 4.90**이라 여유가 0.4뿐이다.
     \`--accent\`를 밝게 조정하면 그 조합이 가장 먼저 깨진다 — 색을 손대면 다시 잰다. */
  :root {
    --bg: #f6f7f8; --panel: #ffffff; --ink: #14181c; --muted: #626b74; --line: #e2e6ea;
    --accent: #1f7a5c;
    --warn-bg: #fdf3d9; --warn-line: #e3c976; --warn-ink: #7a5b0f;
    /* ⚠️ danger는 **신설**이다. 이전에는 액션 실패(.result.fail)가 warn을 재사용해
       "아직 판정 중"(MCP 모름 · 순위 무의미)과 "확실히 실패"(액션 거부)가 같은 색이었다 —
       색 축에서 「없음과 실패를 구분한다」가 깨져 있었다. */
    --danger-bg: #fbe9e7; --danger-line: #e2a49a; --danger-ink: #8a2f1f;

    --fs-1: 11.5px; --fs-2: 12.5px; --fs-3: 13px; --fs-4: 13.5px;
    --fs-5: 14px; --fs-6: 15px; --fs-7: 17px; --fs-8: 20px;
    --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
    --space-5: 20px; --space-6: 24px; --space-7: 28px; --space-8: 32px;
    --radius-sm: 4px; --radius-md: 6px; --radius-pill: 999px;

    /* ⚠️ **크로스 플랫폼 스택이다.** 이전 스택은 macOS 계열 셋과 로컬 설치가 필요한 한글
       폰트 하나뿐이라 Windows·Linux·ChromeOS 사용자는 전부 브라우저 기본값으로 떨어졌다.
       이 저장소는 public이고 다른 사람이 클론해 자기 머신에서 띄운다. 웹폰트로는 못 고친다. */
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Noto Sans KR",
      "Malgun Gothic", "Apple SD Gothic Neo", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", Consolas,
      "Liberation Mono", Menlo, Monaco, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12151a; --panel: #1a1e24; --ink: #e7e9ec; --muted: #8b93a0; --line: #2b313a;
      --accent: #4fd8a6;
      --warn-bg: #2a2416; --warn-line: #5c4d24; --warn-ink: #e0cd94;
      --danger-bg: #2e1a17; --danger-line: #6b3128; --danger-ink: #f0a898;
    }
  }
  /* 키보드 사용자가 지금 어디에 있는지 보여야 한다 — 이전에는 명시적 포커스 스타일이 없었다. */
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: var(--fs-6)/1.6 var(--font-sans); }
  header { padding: 18px 24px; border-bottom: 1px solid var(--line); display: flex;
    align-items: baseline; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  .meta { color: var(--muted); font-size: 13px; }
  nav { display: flex; gap: 4px; padding: 0 24px; border-bottom: 1px solid var(--line); }
  nav button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted);
    padding: 10px 12px; font: inherit; font-size: 14px; cursor: pointer; }
  nav button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
  main { padding: 20px 24px 60px; max-width: 1100px; }
  .banner { background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn-ink);
    padding: 10px 14px; border-radius: 6px; margin-bottom: 18px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; }
  tbody tr:hover { background: var(--panel); }
  .kind { display: inline-block; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line);
    font-size: 12px; color: var(--muted); margin-inline-end: 4px; }
  /* 설치 칸은 한 열이지만 **두 줄**이다 — 스코프와 활성은 다른 축이라 노드를 나눠 둔다.
     한 문자열로 이어붙이면 두 축이 뭉개진다(B3 Step 3a). */
  /* ⚠️ 두 줄에 **각각 이름**을 붙인다. 이전에는 스코프가 라벨 없는 굵은 줄이었는데,
     최상위 자산 대다수가 스코프 기록이 없어 **첫 줄이 대시 하나(정보 0)이고 실제 값은
     흐린 둘째 줄**에 왔다 — 눈이 빈 값으로 먼저 갔다. 이름을 붙이면 어느 줄이 무슨 축인지
     묻지 않아도 되고, 어느 쪽도 "더 중요한 줄"이 아니게 된다. */
  .install-scope { display: block; font-size: var(--fs-2); }
  .install-enabled { display: block; font-size: var(--fs-2); color: var(--muted); }
  /* D-10 — 토글과 이름이 붙어 보이던 문제. \`.row-link\`의 padding:0은 유지하고 여백만 준다. */
  .twisty { margin-inline-end: 6px; }
  /* 상세 머리의 메타 그리드 — 목록에만 있던 설치·활성·출처를 상세에서도 보여준다(D-5). */
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px 16px; margin: 0 0 18px; padding: 12px 14px; border: 1px solid var(--line);
    border-radius: 6px; background: var(--panel); }
  .meta-grid dt { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em;
    color: var(--muted); margin: 0 0 2px; }
  .meta-grid dd { margin: 0; font-size: 13px; }
  /* frontmatter 접기(D-3). 기본 닫힘이고, 열어야 기계용 메타가 보인다. */
  details { border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px;
    margin: 0 0 12px; background: var(--panel); }
  summary { cursor: pointer; font-size: 13px; color: var(--muted); }
  pre.fm { margin: 12px 0 0; font-size: 12.5px; color: var(--muted);
    white-space: pre-wrap; overflow-x: auto;
    font-family: var(--font-mono); }
  .kidcount { color: var(--muted); font-size: 12px; margin-inline-start: 6px;
    font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 12px; border: 1px solid var(--line); }
  .b-enabled { color: var(--accent); border-color: var(--accent); }
  .b-disabled { color: var(--muted); }
  .b-unknown { color: var(--warn-ink); background: var(--warn-bg); border-color: var(--warn-line); }
  .b-unset { color: var(--muted); border-style: dashed; }
  .muted { color: var(--muted); }
  a { color: var(--accent); }
  .filters { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .filters input, .filters select { padding: 6px 9px; border: 1px solid var(--line); border-radius: 5px;
    background: var(--panel); color: var(--ink); font: inherit; font-size: 14px; }
  .doc { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px;
    white-space: pre-wrap; font-size: 13.5px; overflow-x: auto; }
  /* 마크다운 최소 렌더(D-4). 블록이 노드가 되었으므로 문단 안에서만 개행을 보존한다 —
     \`.doc\`의 pre-wrap을 그대로 두면 블록 사이 빈 줄이 이중으로 벌어진다. */
  .doc h4, .doc h5, .doc h6 { margin: 18px 0 8px; font-weight: 600; }
  .doc h4 { font-size: 15px; } .doc h5 { font-size: 14px; } .doc h6 { font-size: 13.5px; }
  .doc p { margin: 0 0 12px; white-space: pre-wrap; }
  .doc ul, .doc ol { margin: 0 0 12px; padding-inline-start: 20px; }
  .doc li { margin: 2px 0; }
  .doc blockquote { margin: 0 0 14px; padding: 6px 14px; border-inline-start: 2px solid var(--line);
    color: var(--muted); font-size: 13px; white-space: pre-wrap; }
  .doc code { font-size: 12.5px; background: var(--bg); border: 1px solid var(--line);
    border-radius: 4px; padding: 0 4px;
    font-family: var(--font-mono); }
  .doc pre.code { margin: 0 0 12px; padding: 10px 12px; background: var(--bg);
    border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; font-size: 12.5px;
    white-space: pre; font-family: var(--font-mono); }
  /* 인용 표기는 본문에서 가장 흔한 요소라 눌러야 읽힌다 — 다만 지우지는 않는다. */
  /* 좌우 여백을 비대칭으로 준다 — 앞 낱말과는 띄고 **뒤따르는 문장부호와는 붙는다.**
     대칭 패딩이면 "…이다 [칩] ." 처럼 마침표가 떨어져 보였다(Step 5 실측). */
  .cite { font-size: 10px; color: var(--muted); border: 1px solid var(--line);
    border-radius: var(--radius-sm); padding: 0 2px 0 3px; margin-inline-start: 3px;
    white-space: nowrap; font-family: var(--font-mono); vertical-align: baseline; }
  .row-link { background: none; border: none; padding: 0; color: var(--accent); font: inherit; cursor: pointer;
    text-align: left; }
  /* 가시성은 클래스가 아니라 속성이다 — 이 파일에서 요소를 숨기는 유일한 규칙.
     이전에는 \`.hidden{display:none}\`이 \`.actions{display:flex}\` **바로 앞**에 있었고, 둘 다
     클래스 선택자 하나라 명시도가 동률이라 소스 순서상 뒤가 이겼다. 그래서
     \`<div class="actions hidden">\`은 계산된 \`display\`가 flex였다 — 조회 모드인데 액션 바가
     보였다(실측 높이 54.6px). 부주의가 아니라 **규약이 구조를 못 이긴 것**이다.
     \`!important\`는 여기서만 쓴다: 가시성은 어떤 레이아웃 유틸리티와도 명시도 경쟁을 하면
     안 되는 유일한 축이라, 앞으로 규칙이 몇 개가 더 생기든 이길 수 없어야 한다. */
  [hidden] { display: none !important; }
  .action-bar { display: flex; gap: 8px; align-items: center; padding: 10px 24px; border-bottom: 1px solid var(--line);
    flex-wrap: wrap; background: var(--panel); }
  .action-bar button { padding: 5px 12px; border: 1px solid var(--line); border-radius: 5px; background: var(--bg);
    color: var(--ink); font: inherit; font-size: 13.5px; cursor: pointer; }
  .action-bar button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .action-bar button:disabled { opacity: .45; cursor: default; }
  .action-bar .sep { color: var(--muted); font-size: 12px; }
  .confirm { border: 1px solid var(--warn-line); background: var(--warn-bg); color: var(--warn-ink);
    border-radius: 6px; padding: 14px 16px; margin: 14px 0; font-size: 14px; }
  .confirm h3 { margin: 0 0 8px; font-size: 14px; }
  .confirm dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 8px 0 12px; }
  .confirm dt { color: inherit; opacity: .75; }
  .confirm .row { display: flex; gap: 8px; }
  .confirm .hint { margin: 8px 0 0; font-size: 13px; font-weight: 600; }
  .result { border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; margin: 12px 0;
    font-size: 13.5px; white-space: pre-wrap; background: var(--panel); }
  /* ⚠️ 클래스명은 그대로 두고 **가리키는 값만** 바꾼다 — 기존 단언이 클래스명을 본다.
     "아직 판정 중"(warn)과 "확실히 실패"(danger)를 색으로 가른다. */
  .result.fail { border-color: var(--danger-line); background: var(--danger-bg); color: var(--danger-ink); }
</style>
</head>
<body>
<header>
  <h1>ctk — 툴 콘솔</h1>
  <span class="meta" id="freshness"></span>
  <span class="meta" id="counts"></span>
</header>
<nav>
  <button id="tab-assets" aria-selected="true">자산</button>
  <button id="tab-usage" aria-selected="false">사용량</button>
</nav>
<div class="action-bar" id="action-bar" hidden>
  <strong style="font-size:13px">액션</strong>
  <button id="btn-scan" disabled>스캔</button>
  <button id="btn-gen" disabled>문서 생성…</button>
  <button id="btn-rollback" disabled>마지막 조치 되돌리기</button>
  <span class="sep" id="action-note"></span>
</div>
<main>
  <div id="action-area"></div>
  <section id="view-assets">
    <div class="filters">
      <input id="q" type="search" placeholder="이름·id로 거르기" autocomplete="off">
      <select id="kind">
        <option value="">모든 종류</option>
        ${KIND_OPTIONS_HTML}
      </select>
      <!-- ⚠️ **버튼이다. 체크박스·라디오·submit 입력으로 만들지 않는다** —
           \`readonly-server.test.ts\`가 그 세 입력 유형의 부재를 단언한다(MCP 쓰기 UI 부재 가드).
           그 가드는 범위가 넓지만 옳고, 여기서 깨면 정당한 이유 없이 보안 단언이 지워진다.
           (그 정규식을 여기 그대로 옮겨 적지 않는다 — 게이트가 자기 규칙을 적은 주석에
           반응하면 신호가 아니라 잡음이다.) -->
      <button class="row-link" id="btn-expand-all">전체 펼치기</button>
      <span class="meta" id="filter-count"></span>
    </div>
    <table>
      <thead><tr>
        <th>이름</th><th>종류</th><th>설치</th><th>출처</th><th>문서</th>
      </tr></thead>
      <tbody id="assets-body"></tbody>
    </table>
  </section>

  <section id="view-detail" hidden>
    <p><button class="row-link" id="back">← 목록으로</button></p>
    <h2 id="detail-name" style="font-size:16px;margin:.2em 0"></h2>
    <dl class="meta-grid" id="detail-meta-grid"></dl>
    <div id="detail-actions"></div>
    <div id="detail-docs"></div>
  </section>

  <section id="view-usage" hidden>
    <div id="usage-banner"></div>
    <h2 style="font-size:15px">안 쓰는데 비싼 툴</h2>
    <table>
      <thead><tr><th>자산</th><th>상시 점유(idle)</th><th>호출</th><th>마지막 사용</th></tr></thead>
      <tbody id="ranked-body"></tbody>
    </table>
    <h2 style="font-size:15px;margin-top:28px">순위에 넣을 수 없는 자산</h2>
    <p class="meta">점유가 측정되지 않아 비교할 수 없다. 추정치로 채우지 않는다.</p>
    <table>
      <thead><tr><th>자산</th><th>상태</th><th>이유</th></tr></thead>
      <tbody id="unrankable-body"></tbody>
    </table>
  </section>
</main>

<script nonce="${nonce}">
// 사유 배지 문구 — core가 단독 출처다(위 UNRESOLVED_LABELS 주석 참조).
const UNRESOLVED_LABEL = ${JSON.stringify(UNRESOLVED_LABELS)};
const $ = (id) => document.getElementById(id);
let VM = null;

/**
 * 세션 토큰. **프래그먼트에서 한 번 읽고 즉시 주소창·히스토리에서 지운다**(보안 심사 L6) —
 * Chrome은 프래그먼트 포함 URL을 History DB에 저장하므로, 남겨두면 같은 사용자 권한의 다른
 * 로컬 프로세스가 서버 수명 동안 토큰을 회수할 수 있다.
 *
 * 이 값은 **클로저에만** 둔다. window·전역·DOM 어디에도 넣지 않는다 — 그 순간 XSS 하나가
 * 액션 API 전권이 된다.
 */
const SESSION_TOKEN = (() => {
  const raw = new URLSearchParams(location.hash.slice(1)).get("token");
  if (raw !== null) history.replaceState(null, "", location.pathname);
  return raw;
})();

let actionBusy = false;
let CURRENT_ASSET = null;

/**
 * 펼쳐진 부모 자산 id — **모듈 스코프 \`Set\`이다**(B1 Step 6, 결정 7).
 *
 * 브라우저 저장소 API를 쓰지 않는 이유: origin이 포트를 포함하고 포트는 호출자가 고르는 값이라
 * (\`cli/web.ts\`) **신뢰할 수 없는 지속성**이다(그리고 그 API 이름이 페이지에 등장하는 것 자체를
 * \`readonly-server.test.ts\`가 금지한다 — 토큰 유출 축의 회귀 방지다). 서버가 아닌 이유: \`readonly-routes.ts\`가
 * GET/HEAD로 잠겨 있어 토글 하나 때문에 변형 경로를 뚫는 것은 계층 경계 위반이다.
 * 모듈 스코프인 이유: \`renderAssets()\`가 매 렌더에 tbody를 비우므로 DOM에 두면 지워진다 —
 * 같은 파일이 이미 \`VM\`·\`CURRENT_ASSET\`을 이렇게 든다.
 */
const EXPANDED = new Set();

/** \`parent_id\` → 자식 행 목록. 매 렌더에 다시 만든다(정렬 인접성에 기대지 않는 묶기의 근거). */
const CHILDREN = new Map();

/**
 * 열려 있는 확인 패널. **패널은 한 번에 하나만 뜬다.**
 *
 * 처음에는 새 패널이 열릴 때 \`action-area\`를 비웠는데, 그러면 앞 패널의 버튼이 DOM에서
 * 떨어져 나가면서 리스너도 사라진다 — 그 promise는 **영원히 resolve되지 않고** 그것을
 * 기다리던 async 프레임은 깨어나지 않는다(심사 L6). \`gen\` 견적이 그렇게 묶이면 미소비
 * 견적 토큰이 상한(8개)을 채워 TTL 10분 동안 문서 생성이 막힌다 — 조용히 사라지는 것이
 * 아니라 **나중에 엉뚱한 곳에서** 거부로 나타난다.
 *
 * 앞 패널을 취소로 확정하고 새 패널을 여는 방법도 있지만, 그러면 깨어난 앞 프레임이
 * \`showResult\`로 방금 그린 새 패널을 지운다. 그래서 **열기 자체를 막는다** — 취소 버튼이
 * 화면에 그대로 있으므로 빠져나갈 길은 닫히지 않는다(안전 원칙 6).
 */
let pendingConfirm = null;

/**
 * 확인이 열려 있으면 \`true\`. **조용히 무시하지 않는다** — 아무 반응 없는 버튼은 사용자가
 * 고장으로 읽고, 그 다음에 하는 일은 새로고침이다(그러면 견적 토큰이 미소비로 남는다).
 */
function confirmBlocks() {
  if (pendingConfirm === null) return false;
  pendingConfirm.hint.textContent = "먼저 이 확인에 답한다 — 다른 액션은 그 뒤에 실행된다.";
  return true;
}

/** 액션 버튼 전체를 잠근다 — 연타로 겹치면 서버가 409를 내지만 화면도 막아야 한다. */
function setActionsBusy(busy, note) {
  actionBusy = busy;
  for (const id of ["btn-scan", "btn-gen", "btn-rollback"]) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
  for (const el of document.querySelectorAll("[data-action-btn]")) el.disabled = busy;
  $("action-note").textContent = note || "";
}

const FAILURE_TEXT = {
  unauthorized: "세션 토큰이 유효하지 않다 — ctk를 다시 띄워 새 URL을 열어야 한다",
  lock_contended: "다른 ctk 실행이 카탈로그를 점유 중이다 — 끝난 뒤 다시 시도한다",
  estimate_token_invalid: "승인이 만료됐거나 이미 쓰였다 — 비용을 다시 확인하고 승인한다",
  project_index_out_of_range: "선택한 프로젝트가 목록 범위 밖이다 — 다시 스캔한 뒤 시도한다",
  payload_too_large: "요청이 너무 크다",
  bad_request: "요청이 화이트리스트 스키마와 맞지 않거나, 고른 뒤 프로젝트 목록이 바뀌었다",
};

/**
 * 액션 1건을 보낸다. **실패를 성공처럼 표시하지 않는다** — 화면이 "됐다"고 하면 사용자는
 * 확인하지 않는다. 서버가 준 분류 코드를 사람이 읽을 문장으로 바꾸되, 원문 메시지도 함께 남긴다.
 */
async function postAction(body) {
  if (SESSION_TOKEN === null) return { ok: false, code: "unauthorized", message: "액션 모드가 아니다" };
  const res = await fetch("/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ctk-session": SESSION_TOKEN },
    body: JSON.stringify(body),
  });
  let parsed;
  try {
    parsed = await res.json();
  } catch (e) {
    // 파싱 실패를 빈 성공으로 삼키지 않는다.
    return { ok: false, code: "action_failed", message: "응답을 해석하지 못했다 (HTTP " + res.status + ")" };
  }
  return parsed;
}

function showResult(text, failed) {
  const area = $("action-area");
  area.textContent = "";
  const div = document.createElement("div");
  div.className = failed ? "result fail" : "result";
  div.textContent = text;
  area.appendChild(div);
}

function showOutcome(label, outcome) {
  if (outcome.ok) {
    showResult(label + " 완료\\n" + JSON.stringify(outcome.data, null, 2), false);
    return true;
  }
  const why = FAILURE_TEXT[outcome.code] || outcome.code || "알 수 없는 실패";
  showResult(label + " 실패 — " + why + "\\n" + (outcome.message || ""), true);
  return false;
}

/** 확인 패널을 띄우고 사용자가 누른 버튼을 기다린다. 취소가 기본이다. */
function askConfirm(title, rows, confirmLabel) {
  return new Promise((resolve) => {
    const area = $("action-area");
    area.textContent = "";
    const box = document.createElement("div");
    box.className = "confirm";
    const h = document.createElement("h3");
    h.textContent = title;
    box.appendChild(h);

    const dl = document.createElement("dl");
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    box.appendChild(dl);

    const row = document.createElement("div");
    row.className = "row";
    const yes = document.createElement("button");
    yes.textContent = confirmLabel;
    const no = document.createElement("button");
    no.textContent = "취소";
    row.appendChild(yes);
    row.appendChild(no);
    box.appendChild(row);

    // 다른 액션이 막혔을 때 그 이유를 적을 자리. 빈 채로 둔다.
    const hint = document.createElement("p");
    hint.className = "hint";
    box.appendChild(hint);
    area.appendChild(box);

    // 어느 경로로 닫히든 **반드시 한 번은** 응답한다 — 이 promise를 기다리는 프레임이 있다.
    pendingConfirm = { hint };
    const settle = (answer) => {
      pendingConfirm = null;
      area.textContent = "";
      resolve(answer);
    };
    yes.addEventListener("click", () => settle(true));
    no.addEventListener("click", () => settle(false));
  });
}

async function runSimpleAction(label, body, confirmRows) {
  if (actionBusy || confirmBlocks()) return;
  if (confirmRows && !(await askConfirm(label, confirmRows, "실행"))) return;
  setActionsBusy(true, label + " 실행 중…");
  try {
    showOutcome(label, await postAction(body));
  } finally {
    setActionsBusy(false, "");
  }
  await refreshViewModel();
}

/**
 * gen은 2단계다(F6). 견적은 **API 호출도 서브프로세스도 띄우지 않고** 비용만 계산하고,
 * 사용자가 그 화면에서 명시 승인해야 실행된다. 승인 없이는 어떤 유료 호출도 일어나지 않는다.
 */
async function runGenTwoPhase() {
  // 확인이 열려 있는데 견적을 또 내면 미소비 토큰만 쌓인다 — 상한(8개)을 채우는 지름길이다.
  if (actionBusy || confirmBlocks()) return;
  setActionsBusy(true, "견적 계산 중…");
  let est;
  try {
    est = await postAction({ action: "gen_estimate", max_total_usd: 2 });
  } finally {
    setActionsBusy(false, "");
  }
  if (!est.ok) { showOutcome("문서 생성 견적", est); return; }

  const d = est.data;
  const rows = [
    ["생성 대상", d.assetCount + "건"],
    ["claude -p 호출", d.call_count + "회"],
    ["총 지출 상한", "$" + d.max_total_usd],
    ["호출당 상한", "$" + Number(d.per_call_budget_usd).toFixed(4)],
    ["이 세션 잔여 한도", "$" + d.session_remaining_usd],
  ];
  if (d.clamped) rows.push(["참고", "서버 상한에 걸려 요청보다 줄었다"]);
  // 실측 단가 — **상한만 보여주면 그 상한이 현실적인지 알 수 없다.** 실측(2026-08-24) 자산당
  // 중앙값이 기본 총액÷호출수보다 커서 대부분의 호출이 하네스에 사전 거부됐다. 실측이 없으면
  // 없다고 말한다(그럴듯한 값을 지어내지 않는다).
  // ⚠️ 이 화면은 곱하지 않는다. 총액 투사는 서버(core)가 계산해 projected_total_usd로 실어
  // 보낸다 — 브라우저와 CLI가 각자 곱하던 때 둘 다 중앙값을 써서 총액을 10~21% 낮게 말했다.
  // 표시가 산술을 하면 같은 결함이 화면 수만큼 갈라진다.
  // (이 구역은 템플릿 리터럴 안이다 — 주석에도 백틱을 쓰지 않는다.)
  if (d.observed_unit_cost) {
    var oc = d.observed_unit_cost;
    rows.push([
      "실측 단가(지난 실행 " + oc.sample_size + "건)",
      "자산당 평균 $" + oc.mean_usd.toFixed(3) + " · 중앙값 $" + oc.median_usd.toFixed(3) +
        " · 최대 $" + oc.max_usd.toFixed(3) + (oc.partial ? " (일부 미보고, 표본 불완전)" : ""),
    ]);
    rows.push([
      "이번 " + d.call_count + "건 예상 총액",
      "약 $" + oc.projected_total_usd.toFixed(2) + " — 평균 × 건수이며 상한이 아니라 예상치다",
    ]);
    if (Number(d.per_call_budget_usd) < oc.median_usd) {
      rows.push([
        "⚠️ 상한 경고",
        "호출당 상한($" + Number(d.per_call_budget_usd).toFixed(4) + ")이 실측 중앙값보다 낮다 — " +
          "상당수가 사전 거부된다. 총액을 올려야 한다",
      ]);
    }
  } else {
    rows.push(["실측 단가", "없음 — 이 머신의 지난 gen 실행 기록이 없다"]);
  }
  if (d.skipped && d.skipped.length > 0) rows.push(["건너뜀", d.skipped.length + "건 (위생 검사 거부)"]);
  // 사유별로 갈라 보여준다 — 합치면 "드리프트를 조사하라"가 조사할 것 없는 자산에도 붙는다.
  if (d.unresolved && d.unresolved.length > 0) {
    var byReason = {};
    for (var i = 0; i < d.unresolved.length; i++) {
      var r = d.unresolved[i].reason;
      byReason[r] = (byReason[r] || 0) + 1;
    }
    for (var key in byReason) rows.push([UNRESOLVED_LABEL[key] || key, byReason[key] + "건"]);
  }

  if (d.assetCount === 0) {
    showResult("생성할 대상이 없다 — 모든 자산이 최신이거나 원본을 읽을 수 없다.", false);
    return;
  }
  if (!(await askConfirm("문서 생성을 승인하시겠습니까? (유료 세션이 실행됩니다)", rows, "승인하고 실행"))) {
    showResult("승인하지 않아 실행하지 않았다. 유료 호출은 일어나지 않았다.", false);
    return;
  }

  setActionsBusy(true, "문서 생성 중… (수 분 걸릴 수 있다)");
  try {
    showOutcome("문서 생성", await postAction({
      action: "gen_execute",
      max_total_usd: d.max_total_usd,
      max_assets: d.max_assets,
      estimate_token: d.estimate_token,
    }));
  } finally {
    setActionsBusy(false, "");
  }
  await refreshViewModel();
}

async function refreshViewModel() {
  const res = await fetch("/api/view-model");
  if (!res.ok) return;
  VM = await res.json();
  renderHeader();
  renderAssets();
  renderUsage();
  // 상세가 열려 있으면 선택지도 다시 만든다. 안 그리면 드롭다운만 옛 목록을 가리켜
  // **드롭다운·확인문구·실행 대상 셋이 서로 다른 목록을 본다**(재심 M1 갈래 2).
  if (!$("view-detail").hidden && CURRENT_ASSET !== null) renderDetailActions(CURRENT_ASSET);
}

function cell(row, text, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;          // innerHTML 금지 — 문서는 서드파티 원문 기반이다
  row.appendChild(td);
  return td;
}

// MCP 상태를 배지로. unknown과 unset을 같은 모양으로 칠하지 않는다.
const MCP_LABEL = { enabled: "켜짐", disabled: "꺼짐", unset: "설정 안 됨", unknown: "모름", not_applicable: "—" };
const MCP_CLASS = { enabled: "b-enabled", disabled: "b-disabled", unset: "b-unset", unknown: "b-unknown", not_applicable: "muted" };

function mcpBadge(states) {
  const span = document.createElement("span");
  if (states.length === 0) { span.className = "muted"; span.textContent = "—"; return span; }
  const unique = [...new Set(states)];
  span.className = "badge " + (MCP_CLASS[unique[0]] || "");
  span.textContent = unique.map((s) => MCP_LABEL[s] || s).join(" · ");
  return span;
}

/**
 * 출처를 주어진 요소에 채운다 — **스킴 검증의 단일 관문**(B3 Step 4a).
 *
 * 목록의 \`<td>\`와 상세의 \`<dd>\`가 같은 함수를 부른다. 각자 검증하면 한쪽이 뒤처지고,
 * **뒤처진 쪽이 \`javascript:\`를 링크로 만든다** — 이 저장소가 반복해서 만난 사본 문제다.
 * 요소를 만들어 돌려주지 않고 **받아서 채우는** 이유는 호출부의 DOM 모양을 바꾸지 않기
 * 위해서다(목록 셀에 래퍼가 하나 끼면 기존 테스트의 자식 수 단언이 의미를 잃는다).
 */
function applyRepoTo(td, repo) {
  if (repo === null) { td.className = "muted"; td.textContent = "—"; }
  else if (repo.url === null) {
    // 로컬 디렉터리 출처 — 원격 URL이 없다. 죽은 링크를 만들지 않는다.
    td.className = "muted"; td.textContent = "로컬(" + repo.kind + ")";
  } else {
    // 심층 방어: 원천(known-marketplaces.schema.ts)이 이미 스킴을 걸렀지만, 카탈로그가
    // 과거 버전으로 쓰였을 수 있으므로 렌더 직전에 한 번 더 본다. javascript:/data: 는
    // 링크로 만들지 않는다(H3).
    let safe = null;
    try {
      const u = new URL(repo.url);
      if (u.protocol === "https:" || u.protocol === "http:") safe = u.href;
    } catch (e) { safe = null; }
    if (safe === null) {
      td.className = "muted"; td.textContent = "링크 형식 아님(" + repo.kind + ")";
    } else {
      const a = document.createElement("a");
      a.href = safe; a.textContent = repo.kind === "github" ? "GitHub" : "저장소";
      a.target = "_blank"; a.rel = "noopener noreferrer";
      td.appendChild(a);
    }
  }
}

function repoCell(row, repo) {
  const td = document.createElement("td");
  applyRepoTo(td, repo);
  row.appendChild(td);
}

function uniqueJoin(values) {
  const kept = [...new Set(values.filter((v) => v !== null && v !== undefined))];
  return kept.length === 0 ? "—" : kept.join(", ");
}

/**
 * 설치 정보 3-arm(\`AssetInstallationsView\`)을 화면 값으로 편다.
 *
 * ⚠️ \`inherited_unavailable\`을 **빈 배열처럼 그리면 안 된다** — "미설치"로 읽힌다.
 * 부모를 해석하지 못한 것은 "없음"이 아니라 "판정 불가"다(안전 원칙 7).
 */
function installationsOf(a) {
  const v = a.installations;
  if (v.source === "inherited_unavailable") return null;
  return v.installations;
}

/**
 * 설치 칸을 만든다 — **병합이지 융합이 아니다**(B3 Step 3a).
 *
 * 이전에는 \`설치 스코프\`와 \`활성\`이 각각 한 열이었다. 열을 하나로 합치되 **DOM 노드는 둘로
 * 나눈다** — CLAUDE.md의 「설치 스코프와 활성 여부는 다른 축이다」를 화면에서 지키는 자리다.
 * 한 문자열로 이어붙이면 두 축이 시각적으로 뭉개지고, 나중에 어느 쪽이 무엇이었는지 되짚을 수 없다.
 *
 * ⚠️ \`inherited_unavailable\`은 **한 노드 + 배지**다. 빈 값이나 대시로 그리면 "미설치"로 읽히는데,
 * 부모를 해석하지 못한 것은 "없음"이 아니라 "판정 불가"다(안전 원칙 7). 그래서 MCP \`unknown\`과
 * **같은 시각 계열**(\`b-unknown\`)을 공유한다 — 사용자가 할 일이 같다(더 재야 한다).
 */
function installCellNodes(a) {
  const td = document.createElement("td");
  const list = installationsOf(a);

  if (list === null) {
    const badge = document.createElement("span");
    badge.className = "badge b-unknown";
    badge.textContent = "상속 정보 확인 불가";
    td.appendChild(badge);
    return td;
  }

  const inherited = a.installations.source === "inherited_from_parent";
  // ⚠️ **두 줄에 각각 이름을 붙인다**(B3 Step 6a). 이전에는 스코프가 라벨 없는 줄이었는데,
  // 최상위 자산 대다수가 스코프 기록이 없어 **첫 줄이 대시 하나(정보 0)**이고 실제 값은 흐린
  // 둘째 줄에 왔다 — 눈이 빈 값으로 먼저 갔다. 이름이 붙으면 \`스코프: —\`가 "기록 없음"으로
  // 읽히고, 값을 감추지 않으면서 오해도 없앤다.
  const scope = document.createElement("span");
  scope.className = "install-scope";
  const scopeText = uniqueJoin(list.map((i) => i.install_scope));
  // 상속 표시는 **스코프 줄에만** 붙인다. 두 줄에 다 붙이면 같은 사실이 두 번 나오고,
  // 어느 줄도 안 붙이면 자식이 자기 설치를 가진 것처럼 보인다.
  scope.textContent = inherited ? "스코프: " + scopeText + " (부모 상속)" : "스코프: " + scopeText;
  td.appendChild(scope);

  const enabled = document.createElement("span");
  enabled.className = "install-enabled";
  enabled.textContent = "활성: " + uniqueJoin(list.map((i) => i.enabled_at));
  td.appendChild(enabled);
  return td;
}

function assetRow(a, depth) {
  const tr = document.createElement("tr");
  const nameTd = document.createElement("td");

  // 부모 행에는 펼치기 버튼이 **첫 자식**으로 온다(테스트가 nameTd.children[0]으로 집는다).
  const kids = CHILDREN.get(a.id);
  if (depth === 0 && kids && kids.length > 0) {
    const toggle = document.createElement("button");
    // D-10 — \`row-link\`는 \`padding:0\`이라 토글과 이름이 붙어 보였다(\`▸example-plugin\`).
    // 여백은 \`twisty\`가 준다. **연속 appendChild 구조는 그대로 둔다** — 이름 칸의 첫 자식이
    // 펼치기 버튼이라는 결합에 기존 테스트가 기대고 있고, 그 결합은 의도적으로 유지한다.
    toggle.className = "row-link twisty";
    toggle.setAttribute("aria-expanded", String(EXPANDED.has(a.id)));
    toggle.textContent = EXPANDED.has(a.id) ? "▾" : "▸";
    toggle.addEventListener("click", () => {
      if (EXPANDED.has(a.id)) EXPANDED.delete(a.id); else EXPANDED.add(a.id);
      renderAssets();
    });
    nameTd.appendChild(toggle);
  }

  const btn = document.createElement("button");
  btn.className = "row-link";
  btn.textContent = (depth > 0 ? "└ " : "") + a.name;
  btn.addEventListener("click", () => showDetail(a));
  nameTd.appendChild(btn);

  // 자식 수를 **펼치기 전에** 보여준다. 지금은 열어보기 전까지 안에 뭐가 있는지 전혀 알 수
  // 없어서, 46개 부모를 하나씩 눌러봐야 했다. 개수만 있어도 펼칠지 말지 판단이 선다.
  if (depth === 0 && kids && kids.length > 0) {
    const n = document.createElement("span");
    n.className = "kidcount";
    // 괄호를 붙인다 — 맨 숫자는 이름의 일부로 읽힌다(\`example-plugin 12\`).
    n.textContent = "(" + kids.length + ")";
    nameTd.appendChild(n);
  }
  tr.appendChild(nameTd);

  const kindTd = document.createElement("td");
  const kindSpan = document.createElement("span");
  kindSpan.className = "kind"; kindSpan.textContent = a.kind;
  kindTd.appendChild(kindSpan);

  // D-8 — MCP 상태를 **별도 열 대신 종류 칸에 흡수**한다.
  //
  // 이전에는 모든 행이 \`MCP 상태\` 칸을 가졌고, mcp가 아닌 자산은 전부 빈 배지였다
  // (\`toMcpStateView\`가 mcp 외 전 유형에 \`not_applicable\`을 준다 — 실측상 그 열이 의미를
  // 갖는 행은 카탈로그의 0.3%다). 열 자체를 없애면 "빈 배지가 반복된다"는 문제가 **구조적으로**
  // 사라진다. \`a.kind === "mcp"\` 게이트는 \`not_applicable\` 판정과 정확히 같은 축이고, 유형으로
  // 묻는 편이 읽는 사람에게 더 분명하다.
  if (a.kind === "mcp") {
    const own = installationsOf(a);
    kindTd.appendChild(mcpBadge(own === null ? [] : own.map((i) => i.mcp_state)));
  }
  tr.appendChild(kindTd);

  tr.appendChild(installCellNodes(a));

  repoCell(tr, a.repo);
  cell(tr, [a.has_annotation ? "주석" : null, a.has_usage_doc ? "사용법" : null].filter(Boolean).join(" · ") || "—",
    a.has_annotation || a.has_usage_doc ? "" : "muted");
  return tr;
}

/**
 * 부모 id 집합 — \`CHILDREN\`은 매 렌더에 다시 만들어지므로 여기서는 **뷰모델에서 직접** 센다.
 * 렌더 시점 자료구조에 기대면 아직 한 번도 렌더하지 않은 상태에서 버튼이 틀린 말을 한다.
 */
function parentIdsFromVm() {
  const ids = new Set();
  for (const a of VM.assets) {
    if (a.parent_id !== null && a.parent_id !== undefined) ids.add(a.parent_id);
  }
  return ids;
}

/**
 * 부모가 **하나라도 있고** 전부 펼쳐져 있는가.
 *
 * ⚠️ 부모가 0건이면 \`false\`다 — 공집합에 대한 "전부"는 참이지만, 그걸 참으로 두면 부모가
 * 없는 카탈로그에서 버튼이 "전체 접기"라고 말한다(접을 것이 없는데).
 */
function allParentsExpanded() {
  const parents = parentIdsFromVm();
  if (parents.size === 0) return false;
  for (const id of parents) if (!EXPANDED.has(id)) return false;
  return true;
}

function toggleExpandAll() {
  if (allParentsExpanded()) EXPANDED.clear();
  else for (const id of parentIdsFromVm()) EXPANDED.add(id);
  renderAssets();
}

/**
 * 자산 목록을 그린다 — **번들 자식은 부모 아래로 접히고 검색은 계층을 관통한다**(B1 Step 6).
 *
 * ⚠️ **정렬 인접성에 기대지 않는다.** \`view-model\`의 정렬은 \`localeCompare\`이고 \`@\`·\`:\`의
 * 상대 순서는 로케일 의존이다 — 반드시 \`parent_id\`로 묶는다(CHILDREN 맵).
 *
 * ⚠️ \`filter-count\`는 **\`matched.length\`를 센다.** 관통 때문에 컨테이너로 끌려온 부모가
 * 렌더 행에 섞이므로, 렌더 행 수를 세면 숫자가 거짓말한다(안전 원칙 8).
 */
function renderAssets() {
  const q = $("q").value.trim().toLowerCase();
  const kind = $("kind").value;
  const body = $("assets-body");
  body.textContent = "";

  CHILDREN.clear();
  for (const a of VM.assets) {
    if (a.parent_id === null || a.parent_id === undefined) continue;
    const list = CHILDREN.get(a.parent_id);
    if (list === undefined) CHILDREN.set(a.parent_id, [a]); else list.push(a);
  }
  const byId = new Map(VM.assets.map((a) => [a.id, a]));

  const matched = VM.assets.filter((a) =>
    (kind === "" || a.kind === kind) &&
    (q === "" || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)));
  const matchedIds = new Set(matched.map((a) => a.id));
  // 매치된 자식은 부모를 컨테이너로 끌고 온다 — 안 그러면 자식이 매달릴 데가 없다.
  const visibleTops = new Set(matched.map((a) => (a.parent_id === null || a.parent_id === undefined ? a.id : a.parent_id)));

  for (const topId of visibleTops) {
    const top = byId.get(topId);
    // 부모가 카탈로그에 없으면(부재 주입) 자식만이라도 보여준다 — 조용히 사라지게 두지 않는다.
    if (top !== undefined) body.appendChild(assetRow(top, 0));

    const kids = CHILDREN.get(topId);
    if (kids === undefined) continue;
    // 검색 중이면 매치된 자식만 펼쳐 보이고, 검색어가 없으면 EXPANDED일 때만 전부 보인다(접힘 기본).
    const shown = q === "" && kind === ""
      ? (EXPANDED.has(topId) ? kids : [])
      : kids.filter((c) => matchedIds.has(c.id));
    for (const c of shown) body.appendChild(assetRow(c, 1));
  }

  // 세 수가 실재한다 — **각각에 자기 이름을 붙인다**(B3 D-2).
  //
  // 이전에는 \`matched.length + " / " + VM.assets.length\`였고, 필터가 없으면 두 값이 같아
  // 화면에 "1349 / 1349건"이 떴다. 그런데 그 아래 그려진 행은 183개였다 — 어느 숫자도 화면과
  // 맞지 않는데 슬래시 표기가 그 사실을 감췄다. \`matched.length\` **집계는 옳았다.**
  // 틀린 것은 이름표였으므로 집계식은 건드리지 않고 라벨만 나눈다.
  //
  // ⚠️ **렌더된 행 수를 세지 않는다** — 펼친 자식이 섞이면 그것은 또 다른 축이다.
  // \`visibleTops\`는 깊이 0 컨테이너의 수이고, 그것이 "접힌 기본 상태에서 보이는 행"이다.
  //
  // ⚠️ **"필터가 걸렸다"에 종류 선택도 포함된다.** \`q\`만 보면 종류만 고른 화면에서
  // 매치 수가 사라져 그 화면에서만 두 수가 다시 뭉개진다.
  const filtered = q !== "" || kind !== "";
  const tail = "최상위 " + visibleTops.size + "건 · 전체 " + VM.assets.length + "건";
  $("filter-count").textContent = filtered ? "매치 " + matched.length + "건 · " + tail : tail;

  // 접을 것이 없으면 버튼을 숨긴다 — 눌러도 아무 일이 없는 버튼은 사용자가 고장으로 읽는다.
  const expandBtn = $("btn-expand-all");
  expandBtn.hidden = parentIdsFromVm().size === 0;
  expandBtn.textContent = allParentsExpanded() ? "전체 접기" : "전체 펼치기";
}

/**
 * 상세 머리의 메타 그리드 — **D-5**(B3 Step 4a).
 *
 * 이전에는 \`종류 · id · marketplace\` 한 줄이 전부였다. 설치 스코프·활성·출처는 **목록에만
 * 있어서**, 자산 하나를 보다가 그 값을 알려면 목록으로 되돌아가야 했다. 새 데이터 조회는
 * 없다 — 이미 뷰모델이 들고 있는 값이다.
 */
function renderDetailMeta(asset) {
  const dl = $("detail-meta-grid");
  dl.textContent = "";

  // 쌍을 \`<div>\`로 감싼다 — \`<dl>\`에 grid를 걸고 \`dt\`/\`dd\`를 직접 자식으로 두면 둘이
  // **각각 별도 셀**이 되어 라벨과 값이 어긋난다. 감싸면 한 칸 안에서 라벨이 값 위에 온다.
  const add = (label) => {
    const cell = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    cell.appendChild(dt);
    const dd = document.createElement("dd");
    cell.appendChild(dd);
    dl.appendChild(cell);
    return dd;
  };

  add("종류").textContent = asset.kind;
  add("id").textContent = asset.id;
  if (asset.marketplace) add("마켓플레이스").textContent = asset.marketplace;

  const list = installationsOf(asset);
  if (list === null) {
    // ⚠️ 설치와 활성을 **두 행으로 벌리지 않는다** — 둘 다 "부모를 해석하지 못했다"는 **한
    // 사실**의 결과다. 두 행에 같은 배지를 넣으면 서로 다른 두 판정처럼 보인다.
    const dd = add("설치");
    const badge = document.createElement("span");
    badge.className = "badge b-unknown";
    badge.textContent = "상속 정보 확인 불가";
    dd.appendChild(badge);
  } else {
    const inherited = asset.installations.source === "inherited_from_parent";
    const scopeText = uniqueJoin(list.map((i) => i.install_scope));
    add("설치 스코프").textContent = inherited
      ? (scopeText === "—" ? "부모 상속" : scopeText + " (부모 상속)")
      : scopeText;
    add("활성").textContent = uniqueJoin(list.map((i) => i.enabled_at));
  }

  // mcp면 **항상** 한 행을 낸다 — 목록의 칩과 같은 규칙을 쓴다(판정 주체를 둘로 만들지 않는다).
  if (asset.kind === "mcp") {
    add("MCP 상태").appendChild(mcpBadge(list === null ? [] : list.map((i) => i.mcp_state)));
  }

  applyRepoTo(add("출처"), asset.repo);
}

/**
 * 인라인 토큰 — 인라인 코드 · 굵게 · 인용 표기 세 가지.
 *
 * ⚠️ **단일 \`*\` 기울임은 넣지 않는다.** 줄머리 \`* \`가 순서없는 리스트 마커와 같은 문자라
 * 한 문자를 두 축이 판정하게 된다. \`**\`는 그 충돌이 없다(리스트 마커가 될 수 없다).
 * 실측: 굵게 769건 대 기울임 17건 — 흔한 쪽만 취하고 모호한 쪽은 원문 그대로 둔다.
 */
const INLINE_RE = /(\`[^\`]+\`)|(\\*\\*[^*]+\\*\\*)|(\\[\\[cite:[^\\]]+\\]\\])/g;

/** 인라인 토큰을 노드로 편다. **\`innerHTML\`을 쓰지 않는다** — 원문은 서드파티 텍스트다. */
function renderInline(el, text) {
  INLINE_RE.lastIndex = 0;
  if (!INLINE_RE.test(text)) { el.textContent = text; return; }
  INLINE_RE.lastIndex = 0;

  const put = (s) => {
    if (s === "") return;
    const span = document.createElement("span");
    span.textContent = s;
    el.appendChild(span);
  };

  let last = 0;
  let m = INLINE_RE.exec(text);
  while (m !== null) {
    put(text.slice(last, m.index));
    const tok = m[0];
    if (m[1] !== undefined) {
      const code = document.createElement("code");
      code.textContent = tok.slice(1, -1);
      el.appendChild(code);
    } else if (m[2] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = tok.slice(2, -2);
      el.appendChild(strong);
    } else {
      // 인용 표기 — 문서당 평균 열일곱 개로 **본문에서 가장 흔한 요소**다. 읽는 흐름에서
      // 빠지도록 작은 첨자 칩으로 누르되 **지우지는 않는다**(출처 추적이 그 값이다).
      const cite = document.createElement("sup");
      cite.className = "cite";
      // \`[[cite:\`는 **7글자**다(대괄호 둘 + \`cite\` 넷 + 콜론 하나). 8로 자르면 참조의 첫
      // 글자가 조용히 사라진다 — 테스트가 잡았다.
      cite.textContent = tok.slice(7, -2);
      el.appendChild(cite);
    }
    last = m.index + tok.length;
    m = INLINE_RE.exec(text);
  }
  put(text.slice(last));
}

/**
 * 생성 문서의 마크다운을 **최소 범위만** 렌더한다 — **D-4**(B3 Step 5).
 *
 * 범위는 추측이 아니라 **모집단 실측**으로 정했다(주석 174파일·4,695줄 + 사용법 174파일·8,210줄):
 * ATX 헤딩 · 순서없는/있는 리스트 · 인용 · 울타리 코드 · 인라인 코드 · 굵게 · 인용 표기.
 * **표와 기울임은 넣지 않는다** — 각각 12줄·17건이고, 인식하지 못하면 문단으로 그대로 나와
 * **오해될 여지가 없다.**
 *
 * ⚠️ **울타리 코드는 미관이 아니라 오해 방지 때문에 넣는다.** 코드 블록 **안**에 \`#\`·\`-\`로
 * 시작하는 줄이 있으면 헤딩·리스트로 **잘못 해석된다** — 그건 "렌더 안 함"이 아니라 **"틀린
 * 렌더"**다. 울타리 안에서는 파싱을 멈추고 원문 그대로 낸다.
 *
 * ⚠️ **인식하지 못한 줄은 문단으로 그대로 낸다.** "해석 못 함"을 "내용 없음"으로 만들지 않는다.
 *
 * ⚠️ **\`createElement\` + \`textContent\`만 쓴다.** 원문에는 \`<div>\`처럼 **문자 그대로의 태그**가
 * 실재한다(실측 214건) — 마크업으로 해석되면 안 되고, 글자로 보여야 한다. 안전이 파서의
 * 완성도가 아니라 **노드를 만드는 방식**에 걸려 있다.
 */
function renderMarkdownInto(host, text) {
  const lines = text.split("\\n");
  let para = [];
  let quote = [];
  let list = null;
  // ⚠️ 열려 있는 리스트의 종류를 **별도 변수로** 기억한다. \`list.tag\`를 읽으면 테스트 스텁에서만
  // 동작한다 — 실제 DOM 요소에는 \`tag\`가 없고 \`tagName\`이 있다(그리고 대문자다).
  let listTag = null;
  let fence = null;

  const flushPara = () => {
    if (para.length === 0) return;
    const p = document.createElement("p");
    renderInline(p, para.join("\\n"));
    host.appendChild(p);
    para = [];
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    const bq = document.createElement("blockquote");
    renderInline(bq, quote.join("\\n"));
    host.appendChild(bq);
    quote = [];
  };
  const flushList = () => { list = null; listTag = null; };
  const flushAll = () => { flushPara(); flushQuote(); flushList(); };

  for (const line of lines) {
    // ── 울타리 안에서는 아무것도 해석하지 않는다 ──
    if (fence !== null) {
      if (line.startsWith("\`\`\`")) {
        const pre = document.createElement("pre");
        pre.className = "code";
        pre.textContent = fence.join("\\n");
        host.appendChild(pre);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (line.startsWith("\`\`\`")) { flushAll(); fence = []; continue; }

    const heading = /^(#{1,6})\\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushAll();
      // 페이지가 이미 h2(자산명)·h3(문서 제목)를 쓰므로 문서 안의 헤딩은 h4부터 시작한다.
      const h = document.createElement("h" + Math.min(6, heading[1].length + 3));
      renderInline(h, heading[2]);
      host.appendChild(h);
      continue;
    }

    const quoted = /^>\\s?(.*)$/.exec(line);
    if (quoted !== null) { flushPara(); flushList(); quote.push(quoted[1]); continue; }

    const bullet = /^\\s*[-*]\\s+(.*)$/.exec(line);
    const numbered = /^\\s*\\d+\\.\\s+(.*)$/.exec(line);
    if (bullet !== null || numbered !== null) {
      flushPara(); flushQuote();
      const wantTag = bullet !== null ? "ul" : "ol";
      if (list === null || listTag !== wantTag) {
        list = document.createElement(wantTag);
        listTag = wantTag;
        host.appendChild(list);
      }
      const li = document.createElement("li");
      renderInline(li, (bullet !== null ? bullet[1] : numbered[1]));
      list.appendChild(li);
      continue;
    }

    if (line.trim() === "") { flushAll(); continue; }

    flushQuote(); flushList();
    para.push(line);
  }

  flushAll();
  // 닫히지 않은 울타리도 **내용을 잃지 않는다** — 열린 채 끝났다고 삼키지 않는다.
  if (fence !== null && fence.length > 0) {
    const pre = document.createElement("pre");
    pre.className = "code";
    pre.textContent = fence.join("\\n");
    host.appendChild(pre);
  }
}

/**
 * 문서 원문을 frontmatter와 본문으로 가른다 — **D-3**(B3 Step 4b).
 *
 * 생성 문서는 \`---\` 두 줄 사이에 기계용 메타(\`schema_version\`·\`gen_source_trust\` 등)를
 * 담는다. 그것이 본문 맨 위 여덟 줄을 차지해, 정작 읽어야 할 내용은 스크롤 아래에 있었다.
 * 지우지 않고 접는다 — \`gen_source_trust\`처럼 신뢰 판단에 필요한 값이 들어 있어 없애면
 * 확인할 길이 사라진다.
 *
 * ⚠️ **fail-safe.** 여는 \`---\`만 있고 닫는 것이 없으면 \`null\`을 돌려 **원문 전체를 본문으로**
 * 보내게 한다. 조용히 자르면 문서 전체가 frontmatter로 삼켜져 화면이 비고, 사용자는 그것을
 * "본문이 없다"로 읽는다 — 파싱 실패를 빈 결과로 삼키지 않는다(안전 원칙 7).
 *
 * 실측 근거: 생성된 문서 전부가 \`^---$\`를 **정확히 두 줄** 가지며 본문에 \`---\`가 나오는
 * 문서는 0건이다. **다만 그것은 오늘의 표본이므로** 규칙이 어긋나는 문서를 만나도 안전한
 * 쪽으로 떨어지게 해 둔다.
 */
function splitFrontmatter(text) {
  if (!text.startsWith("---\\n")) return { frontmatter: null, body: text };
  const end = text.indexOf("\\n---\\n", 3);
  if (end === -1) return { frontmatter: null, body: text };
  return { frontmatter: text.slice(4, end + 1), body: text.slice(end + 5) };
}

async function showDetail(asset) {
  CURRENT_ASSET = asset;
  $("view-assets").hidden = true;
  $("view-usage").hidden = true;
  $("view-detail").hidden = false;
  $("detail-name").textContent = asset.name;
  renderDetailMeta(asset);

  renderDetailActions(asset);

  const host = $("detail-docs");
  host.textContent = "";

  // 문서 상태를 **먼저** 한 번 조회한다. 이전에는 문서가 없으면 사유와 무관하게 항상 같은
  // 한 문장을 띄웠는데, 사유는 셋으로 갈리고 사용자가 할 일이 각각 다르다 — 돈만 내면 되는
  // 것과 정책을 정해야 하는 것이 같은 배지를 달고 있었다(안전 원칙 7).
  // 문구는 서버가 만들어 보낸다(판정 주체 하나). 여기서는 textContent로 넣기만 한다.
  let docState = null;
  try {
    const sres = await fetch("/api/assets/" + encodeURIComponent(asset.id) + "/doc-state");
    if (sres.ok) docState = await sres.json();
  } catch (e) {
    docState = null; // 조회 실패는 "상태 없음"이지 "문서 있음"이 아니다 — 아래에서 구분해 표시한다
  }

  const banner = document.createElement("div");
  banner.className = "doc muted";
  if (docState && docState.display) {
    const label = document.createElement("strong");
    label.textContent = docState.display.label;
    banner.appendChild(label);
    const detail = document.createElement("div");
    detail.textContent = docState.display.detail;
    banner.appendChild(detail);
    const action = document.createElement("div");
    action.textContent = "할 일: " + docState.display.action;
    banner.appendChild(action);
  } else {
    // 상태를 못 읽은 것과 "문서가 없다"를 뭉개지 않는다.
    banner.textContent = "문서 상태를 확인하지 못했다 (서버 응답 없음) — 문서 유무와는 별개다.";
  }
  host.appendChild(banner);

  for (const which of ["annotation", "usage"]) {
    const title = document.createElement("h3");
    title.style.fontSize = "14px";
    title.textContent = which === "annotation" ? "언제 쓰는가" : "사용법";
    host.appendChild(title);
    const res = await fetch("/api/assets/" + encodeURIComponent(asset.id) + "/doc/" + which);
    if (res.ok) {
      const parts = splitFrontmatter(await res.text());
      if (parts.frontmatter !== null) {
        // **기본 닫힘이다** — \`open\`을 붙이지 않는다. 붙이는 순간 D-3이 그대로 재발한다.
        const det = document.createElement("details");
        const sum = document.createElement("summary");
        sum.textContent = "생성 메타데이터 (frontmatter)";
        det.appendChild(sum);
        const fm = document.createElement("pre");
        fm.className = "fm";
        // frontmatter를 키:값으로 **해석하지 않는다.** 원문 그대로 보여준다 —
        // 해석하면 형식이 조금만 달라도 조용히 다른 것을 보여주게 된다.
        fm.textContent = parts.frontmatter;
        det.appendChild(fm);
        host.appendChild(det);
      }
      const body = document.createElement("div");
      body.className = "doc";
      renderMarkdownInto(body, parts.body);
      host.appendChild(body);
      continue;
    }
    // 404를 빈 문서로 렌더하지 않는다 — "없다"와 "비어 있다"는 다른 사실이다.
    // 사유는 위 배너가 말한다. 여기서는 "이 문서가 없다"는 사실만 적는다.
    const pre = document.createElement("div");
    pre.className = "doc muted";
    pre.textContent = "이 문서는 아직 없다 (사유는 위 상태 참조)";
    host.appendChild(pre);
  }
}

/**
 * 프로젝트 선택 드롭다운. **값은 인덱스이고 라벨은 경로의 마지막 세그먼트뿐이다** —
 * 서버가 이미 잘라서 보냈고 여기서는 경로를 볼 수도 없다.
 *
 * 같은 라벨이 둘 이상이면(실측 16건 중 2종 충돌) 인덱스와 해시 접두를 함께 붙인다.
 * 잘못 고르면 엉뚱한 프로젝트의 설정이 바뀌므로 구분 수단이 없으면 안 된다.
 */
function buildProjectSelect() {
  const select = document.createElement("select");
  for (const p of VM.projects) {
    const opt = document.createElement("option");
    opt.value = String(p.index);
    // 충돌한 항목에만 구별자를 붙인다. parentHint가 있으면 그것을 먼저 쓴다 — 인덱스·해시는
    // "다르다"만 알려주고 "어느 쪽이 내가 원하는 것인가"는 못 알려준다(재심 M4).
    opt.textContent = p.ambiguous
      ? p.label + "  (" + (p.parentHint ? "…/" + p.parentHint + " · " : "#" + p.index + " · ") + p.hashPrefix + ")"
      : p.label;
    select.appendChild(opt);
  }
  return select;
}

function selectedProjectText(select) {
  const choice = VM.projects.find((p) => String(p.index) === select.value);
  if (choice === undefined) return "(선택 없음)";
  if (!choice.ambiguous) return choice.label;
  return choice.label + " (" + (choice.parentHint ? "…/" + choice.parentHint + " · " : "#" + choice.index + " · ") + choice.hashPrefix + ")";
}

/**
 * 상세 화면의 이관 버튼.
 *
 * 대상 프로젝트는 **인덱스로만** 지정한다 — 자유 문자열 경로는 API가 받지 않는다(웹에서 온
 * 문자열이 파일시스템에 닿으면 경로 순회가 재현된다).
 */
function renderDetailActions(asset) {
  const host = $("detail-actions");
  host.textContent = "";
  if (SESSION_TOKEN === null) return;

  const scopes = asset.installations.map((i) => i.enabled_at).filter((x) => x !== null);
  const row = document.createElement("div");
  row.className = "actions";
  row.style.padding = "10px 0";
  row.style.borderBottom = "none";

  if (scopes.some((sc) => sc !== "user")) {
    const toUser = document.createElement("button");
    toUser.setAttribute("data-action-btn", "");
    toUser.textContent = "전역(user)으로 되돌리기";
    toUser.disabled = actionBusy;
    toUser.addEventListener("click", () =>
      runSimpleAction("이관", { action: "move", asset_id: asset.id, to: "user" }, [
        ["대상", asset.name + " (" + asset.kind + ")"],
        ["바뀌는 것", "활성 스코프(enabled_at)를 user로 옮긴다. 설치 스코프는 바뀌지 않는다."],
        ["백업", "실행 전 자동 백업된다 — 실패하면 즉시 롤백된다."],
        ["되돌리는 법", "위의 마지막 조치 되돌리기 버튼 또는 ctk rollback --last"],
      ]),
    );
    row.appendChild(toUser);
  }

  if (VM.projects_unavailable !== null) {
    const note = document.createElement("span");
    note.className = "sep";
    // 세 사유는 사용자가 할 일이 서로 다르다 — 뭉치면 "고칠 것이 있다"와 "내가 껐다"가 같아진다.
    const REASON_TEXT = {
      claude_json_unreadable: "프로젝트 목록을 읽지 못했다 — ctk doctor로 ~/.claude.json을 확인한다",
      disabled_by_flag: "프로젝트 이관은 --no-projects로 꺼져 있다 — CLI의 ctk move를 쓴다",
      label_contains_path_separator: "프로젝트 이름이 규약을 어겨 표시하지 않는다 (내부 결함)",
    };
    note.textContent = REASON_TEXT[VM.projects_unavailable] || VM.projects_unavailable;
    row.appendChild(note);
  } else if (VM.projects.length > 0 && scopes.some((sc) => sc !== "project")) {
    const label = document.createElement("span");
    label.className = "sep";
    label.textContent = "프로젝트로 이관:";
    const select = buildProjectSelect();
    select.setAttribute("data-action-btn", "");
    select.disabled = actionBusy;
    const toProject = document.createElement("button");
    toProject.setAttribute("data-action-btn", "");
    toProject.textContent = "이관";
    toProject.disabled = actionBusy;
    toProject.addEventListener("click", () =>
      runSimpleAction(
        "이관",
        {
          action: "move",
          asset_id: asset.id,
          to: "project",
          to_project_index: Number(select.value),
          // 화면이 그 인덱스에서 **실제로 본** 프로젝트임을 서버가 대조할 수 있게 함께 보낸다.
          to_project_hash_prefix: (VM.projects.find((p) => String(p.index) === select.value) || {}).hashPrefix,
        },
        [
          ["대상", asset.name + " (" + asset.kind + ")"],
          ["옮길 프로젝트", selectedProjectText(select)],
          ["바뀌는 것", "그 프로젝트에서만 켜지도록 활성 스코프를 옮긴다. 설치 스코프는 그대로다."],
          ["백업", "실행 전 자동 백업된다 — 실패하면 즉시 롤백된다."],
          ["되돌리는 법", "위의 마지막 조치 되돌리기 버튼 또는 ctk rollback --last"],
        ],
      ),
    );
    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(toProject);
  }

  if (row.childNodes.length > 0) host.appendChild(row);
}

const QUALITY_TEXT = {
  no_measured_assets: "점유가 측정된 자산이 없다",
  all_measured_are_zero: "점유가 측정된 자산이 전부 0토큰이다",
};

function renderUsage() {
  const u = VM.usage;
  const banner = $("usage-banner");
  banner.textContent = "";
  if (!u.ranking_quality.is_meaningful) {
    const div = document.createElement("div");
    div.className = "banner";
    div.textContent = "이 순위는 아직 결론이 될 수 없다 — " +
      (QUALITY_TEXT[u.ranking_quality.reason] || u.ranking_quality.reason) +
      " (측정 " + u.ranking_quality.measured_count + "건 · 미측정 " + u.ranking_quality.unmeasured_count +
      "건). ctk measure에 count_tokens 크레덴셜이 필요하다.";
    banner.appendChild(div);
  }

  const ranked = $("ranked-body");
  ranked.textContent = "";
  for (const r of u.ranked) {
    const tr = document.createElement("tr");
    cell(tr, r.asset_id);
    cell(tr, String(r.idle_tokens) + " 토큰");
    cell(tr, String(r.call_count));
    cell(tr, r.last_used_at || "기록 없음", r.last_used_at ? "" : "muted");
    ranked.appendChild(tr);
  }

  const un = $("unrankable-body");
  un.textContent = "";
  for (const x of u.unrankable) {
    const tr = document.createElement("tr");
    cell(tr, x.asset_id);
    // 미측정을 0으로 쓰지 않는다.
    cell(tr, x.occupancy_idle.state === "approx_bytes"
      ? "근사(" + x.occupancy_idle.approx_bytes + " 바이트 — 토큰 아님)"
      : "미측정", "muted");
    cell(tr, x.occupancy_idle.reason || "—", "muted");
    un.appendChild(tr);
  }
}

function showTab(which) {
  CURRENT_ASSET = null;
  $("view-detail").hidden = true;
  $("view-assets").hidden = which !== "assets";
  $("view-usage").hidden = which !== "usage";
  $("tab-assets").setAttribute("aria-selected", String(which === "assets"));
  $("tab-usage").setAttribute("aria-selected", String(which === "usage"));
}

function renderHeader() {
  const f = VM.freshness;
  $("freshness").textContent = f.never_scanned
    ? "스캔 기록 없음 — ctk scan 필요"
    : "마지막 스캔 " + (f.days_since_last_scan === null ? "시각 불명" : f.days_since_last_scan + "일 전") +
      (f.is_stale ? " (오래됨)" : "");
  $("counts").textContent = VM.assets.length + "개 자산";
}

async function boot() {
  const res = await fetch("/api/view-model");
  if (!res.ok) {
    document.querySelector("main").textContent = "뷰모델을 불러오지 못했다 (HTTP " + res.status + ")";
    return;
  }
  VM = await res.json();

  renderHeader();
  renderAssets();
  renderUsage();

  if (SESSION_TOKEN !== null) {
    // 버튼은 HTML에서 disabled로 시작해 여기서 푼다 — boot()가 끝나기 전에 누르면 리스너가
    // 아직 없어 아무 일도 일어나지 않는데, 사용자에게는 "눌렀는데 반응이 없다"로 보인다.
    $("action-bar").hidden = false;
    $("btn-scan").addEventListener("click", () => runSimpleAction("스캔", { action: "scan" }));
    $("btn-gen").addEventListener("click", runGenTwoPhase);
    $("btn-rollback").addEventListener("click", () =>
      runSimpleAction("롤백", { action: "rollback" }, [
        ["대상", "가장 최근에 기록된 조치 1건"],
        ["바뀌는 것", "그 조치 이전 상태로 파일을 되돌린다."],
        ["주의", "되돌린 뒤에는 같은 버튼으로 다시 앞으로 갈 수 없다."],
      ]),
    );
    setActionsBusy(false, "");
  }

  $("q").addEventListener("input", renderAssets);
  $("kind").addEventListener("change", renderAssets);
  $("btn-expand-all").addEventListener("click", toggleExpandAll);
  $("tab-assets").addEventListener("click", () => showTab("assets"));
  $("tab-usage").addEventListener("click", () => showTab("usage"));
  $("back").addEventListener("click", () => showTab("assets"));
}

boot();
</script>
</body>
</html>
`;
}

/**
 * CSP nonce를 심어 렌더한다. **`script-src 'unsafe-inline'`을 쓰지 않는 이유가 이것이다** —
 * `unsafe-inline`이 있으면 `javascript:` URI가 CSP 층에서 허용되어, 카탈로그에 심긴 악성
 * `repo_url`이 클릭 한 번으로 실행된다(보안 심사 H3). nonce는 우리가 넣은 그 한 장의
 * 스크립트만 허용한다.
 */
export function buildUiPage(nonce: string): string {
  return renderUiHtml(nonce);
}

/** 테스트·회귀 검사용 — nonce 자리에 고정값을 넣은 렌더 결과. */
export const UI_HTML = renderUiHtml("static-analysis-nonce");

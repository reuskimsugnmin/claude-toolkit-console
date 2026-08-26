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
  :root {
    --bg: #fbfbfa; --panel: #fff; --ink: #1b1b1a; --muted: #6b6b66; --line: #e4e4e0;
    --accent: #2f6f4f; --warn-bg: #fdf6e3; --warn-line: #e0cd94; --warn-ink: #6b5518;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16171a; --panel: #1e2024; --ink: #e8e8e6; --muted: #9a9a95; --line: #2e3138;
      --accent: #7fc0a0; --warn-bg: #2a2416; --warn-line: #5c4d24; --warn-ink: #e0cd94;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Pretendard", "Apple SD Gothic Neo", sans-serif; }
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
    font-size: 12px; color: var(--muted); }
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
  .row-link { background: none; border: none; padding: 0; color: var(--accent); font: inherit; cursor: pointer;
    text-align: left; }
  .hidden { display: none; }
  .actions { display: flex; gap: 8px; align-items: center; padding: 10px 24px; border-bottom: 1px solid var(--line);
    flex-wrap: wrap; background: var(--panel); }
  .actions button { padding: 5px 12px; border: 1px solid var(--line); border-radius: 5px; background: var(--bg);
    color: var(--ink); font: inherit; font-size: 13.5px; cursor: pointer; }
  .actions button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .actions button:disabled { opacity: .45; cursor: default; }
  .actions .sep { color: var(--muted); font-size: 12px; }
  .confirm { border: 1px solid var(--warn-line); background: var(--warn-bg); color: var(--warn-ink);
    border-radius: 6px; padding: 14px 16px; margin: 14px 0; font-size: 14px; }
  .confirm h3 { margin: 0 0 8px; font-size: 14px; }
  .confirm dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 8px 0 12px; }
  .confirm dt { color: inherit; opacity: .75; }
  .confirm .row { display: flex; gap: 8px; }
  .confirm .hint { margin: 8px 0 0; font-size: 13px; font-weight: 600; }
  .result { border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; margin: 12px 0;
    font-size: 13.5px; white-space: pre-wrap; background: var(--panel); }
  .result.fail { border-color: var(--warn-line); background: var(--warn-bg); color: var(--warn-ink); }
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
<div class="actions hidden" id="action-bar">
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
      <span class="meta" id="filter-count"></span>
    </div>
    <table>
      <thead><tr>
        <th>이름</th><th>종류</th><th>설치 스코프</th><th>활성</th><th>MCP 상태</th><th>출처</th><th>문서</th>
      </tr></thead>
      <tbody id="assets-body"></tbody>
    </table>
  </section>

  <section id="view-detail" class="hidden">
    <p><button class="row-link" id="back">← 목록으로</button></p>
    <h2 id="detail-name" style="font-size:16px;margin:.2em 0"></h2>
    <p class="meta" id="detail-meta"></p>
    <div id="detail-actions"></div>
    <div id="detail-docs"></div>
  </section>

  <section id="view-usage" class="hidden">
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
  if (!$("view-detail").classList.contains("hidden") && CURRENT_ASSET !== null) renderDetailActions(CURRENT_ASSET);
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

function repoCell(row, repo) {
  const td = document.createElement("td");
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
  row.appendChild(td);
}

function uniqueJoin(values) {
  const kept = [...new Set(values.filter((v) => v !== null && v !== undefined))];
  return kept.length === 0 ? "—" : kept.join(", ");
}

function renderAssets() {
  const q = $("q").value.trim().toLowerCase();
  const kind = $("kind").value;
  const body = $("assets-body");
  body.textContent = "";
  const rows = VM.assets.filter((a) =>
    (kind === "" || a.kind === kind) &&
    (q === "" || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)));

  for (const a of rows) {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "row-link"; btn.textContent = a.name;
    btn.addEventListener("click", () => showDetail(a));
    nameTd.appendChild(btn);
    tr.appendChild(nameTd);

    const kindTd = document.createElement("td");
    const kindSpan = document.createElement("span");
    kindSpan.className = "kind"; kindSpan.textContent = a.kind;
    kindTd.appendChild(kindSpan); tr.appendChild(kindTd);

    cell(tr, uniqueJoin(a.installations.map((i) => i.install_scope)));
    cell(tr, uniqueJoin(a.installations.map((i) => i.enabled_at)));

    const mcpTd = document.createElement("td");
    mcpTd.appendChild(mcpBadge(a.installations.map((i) => i.mcp_state)));
    tr.appendChild(mcpTd);

    repoCell(tr, a.repo);
    cell(tr, [a.has_annotation ? "주석" : null, a.has_usage_doc ? "사용법" : null].filter(Boolean).join(" · ") || "—",
      a.has_annotation || a.has_usage_doc ? "" : "muted");
    body.appendChild(tr);
  }
  $("filter-count").textContent = rows.length + " / " + VM.assets.length + "건";
}

async function showDetail(asset) {
  CURRENT_ASSET = asset;
  $("view-assets").classList.add("hidden");
  $("view-usage").classList.add("hidden");
  $("view-detail").classList.remove("hidden");
  $("detail-name").textContent = asset.name;
  const bits = [asset.kind, asset.id];
  if (asset.marketplace) bits.push("marketplace: " + asset.marketplace);
  $("detail-meta").textContent = bits.join(" · ");

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
    const pre = document.createElement("div");
    pre.className = "doc";
    const res = await fetch("/api/assets/" + encodeURIComponent(asset.id) + "/doc/" + which);
    // 404를 빈 문서로 렌더하지 않는다 — "없다"와 "비어 있다"는 다른 사실이다.
    // 사유는 위 배너가 말한다. 여기서는 "이 문서가 없다"는 사실만 적는다.
    pre.textContent = res.ok ? await res.text() : "이 문서는 아직 없다 (사유는 위 상태 참조)";
    if (!res.ok) pre.className = "doc muted";
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
  $("view-detail").classList.add("hidden");
  $("view-assets").classList.toggle("hidden", which !== "assets");
  $("view-usage").classList.toggle("hidden", which !== "usage");
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
    $("action-bar").classList.remove("hidden");
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

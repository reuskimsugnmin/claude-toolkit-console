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
<main>
  <section id="view-assets">
    <div class="filters">
      <input id="q" type="search" placeholder="이름·id로 거르기" autocomplete="off">
      <select id="kind">
        <option value="">모든 종류</option>
        <option value="plugin">plugin</option>
        <option value="skill">skill</option>
        <option value="mcp">mcp</option>
        <option value="cli">cli</option>
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
const $ = (id) => document.getElementById(id);
let VM = null;

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
  $("view-assets").classList.add("hidden");
  $("view-usage").classList.add("hidden");
  $("view-detail").classList.remove("hidden");
  $("detail-name").textContent = asset.name;
  const bits = [asset.kind, asset.id];
  if (asset.marketplace) bits.push("marketplace: " + asset.marketplace);
  $("detail-meta").textContent = bits.join(" · ");

  const host = $("detail-docs");
  host.textContent = "";
  for (const which of ["annotation", "usage"]) {
    const title = document.createElement("h3");
    title.style.fontSize = "14px";
    title.textContent = which === "annotation" ? "언제 쓰는가" : "사용법";
    host.appendChild(title);
    const pre = document.createElement("div");
    pre.className = "doc";
    const res = await fetch("/api/assets/" + encodeURIComponent(asset.id) + "/doc/" + which);
    // 404를 빈 문서로 렌더하지 않는다 — "없다"와 "비어 있다"는 다른 사실이다.
    pre.textContent = res.ok ? await res.text() : "문서가 아직 생성되지 않았다 (ctk gen 필요)";
    if (!res.ok) pre.className = "doc muted";
    host.appendChild(pre);
  }
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
  $("view-detail").classList.add("hidden");
  $("view-assets").classList.toggle("hidden", which !== "assets");
  $("view-usage").classList.toggle("hidden", which !== "usage");
  $("tab-assets").setAttribute("aria-selected", String(which === "assets"));
  $("tab-usage").setAttribute("aria-selected", String(which === "usage"));
}

async function boot() {
  const res = await fetch("/api/view-model");
  if (!res.ok) {
    document.querySelector("main").textContent = "뷰모델을 불러오지 못했다 (HTTP " + res.status + ")";
    return;
  }
  VM = await res.json();

  const f = VM.freshness;
  $("freshness").textContent = f.never_scanned
    ? "스캔 기록 없음 — ctk scan 필요"
    : "마지막 스캔 " + (f.days_since_last_scan === null ? "시각 불명" : f.days_since_last_scan + "일 전") +
      (f.is_stale ? " (오래됨)" : "");
  $("counts").textContent = VM.assets.length + "개 자산";

  renderAssets();
  renderUsage();
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

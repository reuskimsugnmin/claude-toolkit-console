import { request as httpRequest } from "node:http";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import type { ConsoleViewModel } from "@ctk/core";
import { LOOPBACK_HOST, matchRoute, startReadonlyServer, type ListeningServer } from "../server/app.js";
import { UI_HTML, buildUiPage } from "../server/ui-page.js";

/**
 * Step 6a 수용 기준의 실행형 검증. **"GET만 등록했다"를 코드로 확인하지 않고 실제 요청을
 * 보내 거부되는지 본다** — 규칙 존재 ≠ 규칙이 막음(CLAUDE.md 검증 절).
 */


/**
 * `fetch`는 `host`를 금지 헤더로 취급해 조용히 무시한다 — Host 검사를 시험하려면 raw HTTP로
 * 직접 보내야 한다. (이걸 모르고 fetch로 쓰면 테스트가 통과해도 아무것도 검증하지 않는다.)
 */
function rawGet(port: number, urlPath: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: urlPath, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

const VIEW_MODEL: ConsoleViewModel = {
  schema_version: 1,
  generated_at: "2026-08-22T00:00:00.000Z",
  machine_id: "m1",
  freshness: { last_scan_at: "2026-08-22T00:00:00.000Z", days_since_last_scan: 0, is_stale: false, never_scanned: false },
  assets: [
    {
      id: "synth-a",
      kind: "skill",
      name: "synth-a",
      marketplace: null,
      description: null,
      repo: null,
      parent_id: null,
      installations: { source: "own", installations: [] },
      has_annotation: true,
      has_usage_doc: false,
    },
  ],
  projects: [{ index: 0, label: "synth-proj", ambiguous: false, hashPrefix: "abc123" }],
  projects_unavailable: null,
  usage: {
    ranked: [],
    unrankable: [],
    total_assets_with_occupancy: 0,
    ranking_quality: { measured_count: 0, unmeasured_count: 0, is_meaningful: false, reason: "no_measured_assets" },
  },
};

const DOCS: Record<string, string> = { "synth-a::annotation": "# 합성 주석\n" };

let running: ListeningServer | null = null;

async function start(): Promise<ListeningServer> {
  running = await startReadonlyServer({
    getViewModel: () => VIEW_MODEL,
    getAssetDoc: (assetId, which) => DOCS[`${assetId}::${which}`] ?? null,
      getAssetDocState: () => null,
  });
  return running;
}

afterEach(async () => {
  if (running !== null) {
    await running.close();
    running = null;
  }
});

describe("메서드 — 쓰기 요청이 실제로 405로 거부된다", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH"])("%s는 405이고 Allow 헤더를 준다", async (method) => {
    const server = await start();
    const res = await fetch(`${server.url}/api/view-model`, { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("쓰기 메서드는 존재하지 않는 경로에도 405다 — 라우팅보다 메서드 검사가 먼저다", async () => {
    const server = await start();
    const res = await fetch(`${server.url}/이런/경로/없음`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("GET은 통과한다 — 위 케이스들이 '서버가 다 막는다'와 구분됨을 보인다", async () => {
    const server = await start();
    const res = await fetch(`${server.url}/api/view-model`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW_MODEL);
  });

  it("HEAD는 본문 없이 200이다", async () => {
    const server = await start();
    const res = await fetch(`${server.url}/api/view-model`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("바인딩 — 루프백 고정", () => {
  it("주소가 127.0.0.1이다", async () => {
    const server = await start();
    const address = server.server.address();
    expect(typeof address === "object" && address !== null ? address.address : null).toBe(LOOPBACK_HOST);
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("호스트를 인자로 열어두지 않는다 — 0.0.0.0을 넣을 자리가 타입에 없다", () => {
    // 컴파일 시점의 계약을 런타임에서도 한 번 못박는다: 상수는 루프백 하나뿐이다.
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
  });
});

describe("라우팅 — URL 문자열이 경로를 만들지 않는다", () => {
  it("문서 라우트는 자산 id를 조회 키로만 쓴다", () => {
    expect(matchRoute("/api/assets/synth-a/doc/annotation")).toEqual({
      kind: "asset-doc",
      assetId: "synth-a",
      doc: "annotation",
    });
  });

  it("경로 순회 문자열이 들어와도 라우트는 그것을 id로만 취급한다 — 조회에 실패하면 404다", async () => {
    const server = await start();
    const res = await fetch(`${server.url}/api/assets/${encodeURIComponent("../../etc/passwd")}/doc/annotation`);
    expect(res.status).toBe(404);
  });

  it("doc 종류는 화이트리스트 밖이면 라우트 자체가 없다", () => {
    expect(matchRoute("/api/assets/synth-a/doc/settings").kind).toBe("not-found");
  });

  it("깨진 퍼센트 인코딩은 원문 그대로 통과시키지 않는다", () => {
    expect(matchRoute("/api/assets/%E0%A4%A/doc/annotation").kind).toBe("not-found");
  });

  it("빈 자산 id는 라우트가 아니다", () => {
    expect(matchRoute("/api/assets//doc/annotation").kind).toBe("not-found");
  });
});

describe("응답 내용", () => {
  it("존재하는 문서는 마크다운으로 준다", async () => {
    const server = await start();
    const res = await fetch(`${server.url}/api/assets/synth-a/doc/annotation`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("# 합성 주석\n");
  });

  it("없는 문서는 404다 — 빈 문자열을 200으로 주지 않는다", async () => {
    const server = await start();
    const res = await fetch(`${server.url}/api/assets/synth-a/doc/usage`);
    expect(res.status).toBe(404);
  });

  it("/api/assets는 자산 목록만 준다", async () => {
    const server = await start();
    expect(await (await fetch(`${server.url}/api/assets`)).json()).toEqual({ assets: VIEW_MODEL.assets });
  });

  it("/api/usage는 사용량 뷰를 순위 자격과 함께 준다", async () => {
    const server = await start();
    const body = (await (await fetch(`${server.url}/api/usage`)).json()) as ConsoleViewModel["usage"];
    expect(body.ranking_quality.is_meaningful).toBe(false);
    expect(body.ranking_quality.reason).toBe("no_measured_assets");
  });

  it("뷰모델 조회가 던지면 500이지 빈 200이 아니다 — '자산 0건'을 정상으로 표시하게 두지 않는다", async () => {
    running = await startReadonlyServer({
      getViewModel: () => {
        throw new Error("카탈로그 읽기 실패");
      },
      getAssetDoc: () => null,
      getAssetDocState: () => null,
    });
    const res = await fetch(`${running.url}/api/view-model`);
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "internal_error" });
  });
});

describe("UI 한 장 — Step 6a 수용 기준의 회귀 테스트", () => {
  it("루트가 HTML을 준다", async () => {
    const server = await start();
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("ctk — 툴 콘솔");
  });

  it("외부 리소스를 하나도 불러오지 않는다 — CSP가 default-src 'none'이다", async () => {
    const server = await start();
    const csp = (await fetch(`${server.url}/`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(UI_HTML).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']https?:/i);

    // ⚠️ **축을 넓힌다(B3 Step 6a).** 위 정규식은 **태그만** 본다 — CSS의 `url(`은 보지 않는다.
    // CSP에는 `font-src`도 `img-src`도 없어 둘 다 `default-src 'none'`으로 떨어지므로,
    // 스타일시트에서 무언가를 불러오면 **조용히 실패한다**(오류도 안 보인다). 토큰 시스템이
    // CSS를 크게 늘리는 이 Step에서 그 축을 추가한다.
    const style = /<style>([\s\S]*?)<\/style>/.exec(UI_HTML)?.[1] ?? "";
    expect(style, "스타일시트가 비었다 — 정규식이 잘못 잡았다").not.toBe("");
    expect(style, "CSS에서 외부 리소스를 불러온다 — CSP가 조용히 막는다").not.toMatch(/url\(/i);
  });

  /**
   * B3 Step 6a — 토큰 시스템. 이 저장소는 **public이고 다른 사람이 클론해 자기 머신에서 띄운다.**
   * 이전 폰트 스택은 macOS 계열 셋과 로컬 설치가 필요한 한글 폰트 하나뿐이라 Windows·Linux·
   * ChromeOS는 전부 브라우저 기본값으로 떨어졌고, **웹폰트로는 고칠 수 없다**(위 CSP).
   */
  it("폰트 스택이 macOS 밖의 플랫폼을 담는다", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(UI_HTML)?.[1] ?? "";
    for (const family of ["Segoe UI", "system-ui", "Noto Sans KR", "Malgun Gothic"]) {
      expect(style, `폰트 스택에 ${family}가 없다`).toContain(family);
    }
  });

  it("danger 토큰이 라이트·다크 **양쪽에** 정의돼 있다 — 한쪽만 있으면 다른 테마에서 색이 사라진다", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(UI_HTML)?.[1] ?? "";
    for (const token of ["--danger-bg", "--danger-line", "--danger-ink"]) {
      const hits = style.match(new RegExp(token.replace("--", "--") + ":", "g")) ?? [];
      expect(hits.length, `${token}이 ${hits.length}번 정의됐다 — 라이트·다크 둘이어야 한다`).toBe(2);
    }
  });

  it("액션 실패가 주의 계열이 아니라 실패 계열 색을 쓴다 — '판정 중'과 '거부됨'을 가른다", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(UI_HTML)?.[1] ?? "";
    const rule = /\.result\.fail\s*\{[^}]*\}/.exec(style)?.[0] ?? "";
    expect(rule, ".result.fail 규칙을 찾지 못했다").not.toBe("");
    expect(rule).toContain("var(--danger-");
    expect(rule, "실패가 아직 주의 색을 재사용한다 — 두 사실이 같은 색으로 보인다").not.toContain("var(--warn-");
  });

  it("MCP 상태를 바꾸는 UI 요소가 없다 — v1에서 MCP 쓰기는 미지원이다", () => {
    // ⚠️ 이 단언의 범위가 6b에서 좁아졌다. 예전에는 "POST가 아예 없다"를 봤는데, 그건 조회
    // 전용이던 6a의 조건이었다. 지금은 화이트리스트 액션이 실제로 POST를 보내므로, 수용
    // 기준이 실제로 요구하는 것(**MCP 상태 토글의 부재**)만 단언한다 — 범위를 넓힌 채 두면
    // 정당한 기능 추가마다 깨지고, 결국 테스트가 지워진다.
    expect(UI_HTML).not.toMatch(/mcp[_-]?(enable|disable|toggle)/i);
    expect(UI_HTML).not.toMatch(/<form\b/i);
    expect(UI_HTML).not.toMatch(/<input[^>]+type=["'](checkbox|radio|submit)/i);
  });

  it("POST는 화이트리스트 액션에만 쓰인다 — 임의 경로로 쓰기를 보내지 않는다", () => {
    const postTargets = [...UI_HTML.matchAll(/fetch\((?:"|')([^"']+)(?:"|')[^)]*method:\s*"POST"/g)].map((m) => m[1]);
    expect(new Set(postTargets)).toEqual(new Set(["/api/actions"]));
  });

  it("액션 본문의 action 값이 전부 화이트리스트 안이다", () => {
    const allowed = new Set(["scan", "rollback", "move", "gen_estimate", "gen_execute"]);
    const used = [...UI_HTML.matchAll(/action:\s*"([a-z_]+)"/g)].map((m) => m[1] ?? "");
    expect(used.length).toBeGreaterThan(0);
    for (const a of used) expect(allowed.has(a)).toBe(true);
  });

  it("unknown과 unset을 서로 다른 라벨·클래스로 표시한다 — 뭉개지 않는다", () => {
    expect(UI_HTML).toContain('unknown: "모름"');
    expect(UI_HTML).toContain('unset: "설정 안 됨"');
    expect(UI_HTML).toContain('unknown: "b-unknown"');
    expect(UI_HTML).toContain('unset: "b-unset"');
  });

  it("미측정을 0으로 쓰지 않는다 — '미측정' 문자열을 쓴다", () => {
    expect(UI_HTML).toContain('"미측정"');
  });

  it("순위 자격이 없을 때 띄울 문구를 갖는다", () => {
    expect(UI_HTML).toContain("이 순위는 아직 결론이 될 수 없다");
  });

  it("값을 innerHTML로 넣지 않는다 — 카탈로그 문서는 서드파티 원문 기반이다", () => {
    // 주석에 등장하는 단어가 아니라 **실제 대입**을 본다(`innerHTML =` / `insertAdjacentHTML`).
    expect(UI_HTML).not.toMatch(/innerHTML\s*=/);
    expect(UI_HTML).not.toContain("insertAdjacentHTML");
    expect(UI_HTML).not.toContain("document.write");
    // 비-공허성: 값 주입에 textContent를 실제로 쓴다.
    expect(UI_HTML).toMatch(/\.textContent\s*=/);
  });

  it("로컬 출처는 링크로 렌더하지 않는다", () => {
    expect(UI_HTML).toContain('td.textContent = "로컬("');
  });
});

describe("H1 회귀 — DNS rebinding은 조회도 표적이다", () => {
  it("Host가 공격자 도메인이면 조회 API도 403이다", async () => {
    const server = await start();
    expect(await rawGet(server.port, "/api/view-model", { host: `evil.example:${server.port}` })).toBe(403);
  });

  it("문서 조회 경로도 같은 관문을 거친다", async () => {
    const server = await start();
    expect(await rawGet(server.port, "/api/assets/synth-a/doc/annotation", { host: `evil.example:${server.port}` })).toBe(403);
  });

  it("UI 페이지도 막힌다", async () => {
    const server = await start();
    expect(await rawGet(server.port, "/", { host: `evil.example:${server.port}` })).toBe(403);
  });

  it("루프백이지만 포트가 다른 Host도 거부한다", async () => {
    const server = await start();
    expect(await rawGet(server.port, "/api/view-model", { host: `127.0.0.1:${server.port + 1}` })).toBe(403);
  });

  it("raw HTTP로 정상 Host를 주면 통과한다 — 위 케이스들이 raw 경로 자체의 실패가 아님을 보인다", async () => {
    const server = await start();
    expect(await rawGet(server.port, "/api/view-model", { host: `127.0.0.1:${server.port}` })).toBe(200);
  });

  it("정상 요청은 통과한다 — 위 케이스들이 '전부 403'과 구분됨을 보인다", async () => {
    const server = await start();
    expect((await fetch(`${server.url}/api/view-model`)).status).toBe(200);
  });
});

describe("H3 회귀 — CSP nonce와 스킴 검증", () => {
  it("script-src에 unsafe-inline이 없다 — 있으면 javascript: URI가 허용된다", async () => {
    const server = await start();
    const csp = (await fetch(`${server.url}/`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("nonce는 응답마다 다르다 — 고정하면 공격자가 그 값을 알고 스크립트를 심는다", async () => {
    const server = await start();
    const a = (await fetch(`${server.url}/`)).headers.get("content-security-policy") ?? "";
    const b = (await fetch(`${server.url}/`)).headers.get("content-security-policy") ?? "";
    expect(a).not.toBe(b);
  });

  it("본문의 script 태그 nonce가 헤더의 nonce와 같다 — 다르면 UI가 아예 안 뜬다", async () => {
    const server = await start();
    const res = await fetch(`${server.url}/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const headerNonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(headerNonce).toBeDefined();
    expect(await res.text()).toContain(`<script nonce="${headerNonce}">`);
  });

  it("frame-ancestors none — default-src가 커버하지 않는 축이다", async () => {
    const server = await start();
    expect((await fetch(`${server.url}/`)).headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("UI가 repo.url을 렌더 전에 스킴 검증한다", () => {
    expect(buildUiPage("n")).toContain('u.protocol === "https:" || u.protocol === "http:"');
    expect(UI_HTML).toContain("링크 형식 아님");
  });
});

describe("액션 UI — 토큰 취급 (심사 L6)", () => {
  it("프래그먼트에서 토큰을 읽은 뒤 히스토리에서 즉시 지운다", () => {
    expect(UI_HTML).toContain("location.hash.slice(1)");
    expect(UI_HTML).toContain("history.replaceState(null,");
  });

  it("토큰을 전역·window·DOM에 넣지 않는다 — XSS 하나가 액션 전권이 되지 않게", () => {
    expect(UI_HTML).not.toMatch(/window\.[A-Za-z_$]*[Tt]oken/);
    expect(UI_HTML).not.toMatch(/localStorage|sessionStorage/);
    // 토큰이 DOM 속성으로 새지 않는다 — 헤더로만 쓴다.
    expect(UI_HTML).not.toMatch(/setAttribute\([^)]*SESSION_TOKEN/);
    expect(UI_HTML).toContain('"x-ctk-session": SESSION_TOKEN');
  });

  // ⚠️ **"토큰이 없으면 액션 바가 숨겨진 채로 남는다"는 `ui-visibility.test.ts`로 옮겼다(B3 Step 1).**
  //
  // 여기 있던 단언은 `<div class="actions hidden" id="action-bar">`라는 **문자열이 있는지**만
  // 봤고, 그래서 그 클래스가 실제로 요소를 숨기는지는 보지 못했다 — `.hidden{display:none}`이
  // `.actions{display:flex}`에 명시도 동률로 져서 조회 모드에서도 액션 바가 보이는 동안
  // **이 테스트는 초록이었다**(CLAUDE.md: 규칙 존재 ≠ 규칙이 막음).
  //
  // 지금은 같은 축을 셋으로 나눠 지킨다: ①마크업이 `hidden` 속성으로 시작하는가 ②토큰 없이
  // 부팅하면 그대로 남는가 ③토큰이 있으면 드러나는가(대조군). **먼저 새 테스트가 초록인 것을
  // 확인한 뒤에** 이 단언을 지웠다 — 순서를 뒤집으면 "승격했다"가 "없앴다"가 된다.
});

describe("액션 UI — 승인 없이는 유료 호출이 없다 (F6)", () => {
  it("gen은 estimate 응답의 토큰으로만 execute한다", () => {
    expect(UI_HTML).toContain('action: "gen_estimate"');
    expect(UI_HTML).toContain("estimate_token: d.estimate_token");
  });

  it("승인 화면이 총액과 호출당 상한을 **따로** 보여준다 — 한 이름으로 뭉치면 H2가 재발한다", () => {
    expect(UI_HTML).toContain("총 지출 상한");
    expect(UI_HTML).toContain("호출당 상한");
  });

  it("취소하면 유료 호출이 없었다는 사실을 말해준다", () => {
    expect(UI_HTML).toContain("유료 호출은 일어나지 않았다");
  });

  it("실패를 성공처럼 표시하지 않는다 — 분류 코드를 사람이 읽을 문장으로 바꾼다", () => {
    expect(UI_HTML).toContain("lock_contended:");
    expect(UI_HTML).toContain("estimate_token_invalid:");
    expect(UI_HTML).toContain('div.className = failed ? "result fail" : "result"');
  });

  it("이관은 영향 요약을 먼저 보여주고 확인받는다", () => {
    expect(UI_HTML).toContain("바뀌는 것");
    expect(UI_HTML).toContain("백업");
    expect(UI_HTML).toContain("되돌리는 법");
  });

  it("실행 중에는 버튼이 잠긴다 — 연타로 겹치지 않게", () => {
    expect(UI_HTML).toContain("setActionsBusy(true");
    expect(UI_HTML).toContain("el.disabled = busy");
  });
});

describe("UI 스크립트가 실제로 파싱되는가", () => {
  /**
   * ⚠️ **이 테스트가 없어서 UI를 두 번 깨뜨렸다.** UI는 TS 템플릿 리터럴 안의 문자열이라
   * 백틱과 백슬래시가 한 단계 더 이스케이프돼야 하는데, 그걸 어기면 **타입체크도 통과하고
   * 752개 테스트도 통과한 채** 브라우저에서만 `SyntaxError`가 난다.
   *
   * 문자열 포함 검사(`toContain`)로는 절대 잡히지 않는다 — 깨진 코드에도 그 문자열은 있다.
   * 서빙되는 스크립트를 **실제로 파싱**해야 한다.
   */
  function extractScript(html: string): string {
    const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
    expect(match, "UI에 nonce가 붙은 script 태그가 있어야 한다").not.toBeNull();
    return match?.[1] ?? "";
  }

  it("서빙되는 스크립트가 유효한 JavaScript다", async () => {
    const server = await start();
    const script = extractScript(await (await fetch(`${server.url}/`)).text());
    expect(script.length).toBeGreaterThan(1000);
    // 파싱만 한다 — 실행하지 않는다(document·fetch가 없다).
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it("이 검사가 공허하지 않다 — 깨진 스크립트는 실제로 걸린다", () => {
    expect(() => new vm.Script('const a = "열린 채 끝난 문자열')).toThrow();
  });

  it("문자열 안의 개행이 실제 개행으로 새지 않는다", async () => {
    const server = await start();
    const script = extractScript(await (await fetch(`${server.url}/`)).text());
    // 따옴표가 홀수인 줄 = 문자열이 그 줄에서 끊겼다는 뜻(주석 제외).
    const broken = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => (line.match(/"/g) ?? []).length % 2 === 1);
    expect(broken).toEqual([]);
  });
});

describe("액션 버튼은 준비되기 전에 눌리지 않는다", () => {
  it("버튼이 disabled로 시작한다 — boot 전에 누르면 리스너가 없어 조용히 아무 일도 없다", () => {
    for (const id of ["btn-scan", "btn-gen", "btn-rollback"]) {
      expect(UI_HTML).toMatch(new RegExp(`<button id="${id}"[^>]*\\bdisabled\\b`));
    }
  });

  it("boot가 리스너를 붙인 뒤 잠금을 푼다", () => {
    expect(UI_HTML).toContain('setActionsBusy(false, "");');
  });
});

describe("프로젝트 선택 UI — 경로가 화면에 닿지 않는다 (안 B)", () => {
  it("뷰모델의 projects가 그대로 전달되고 경로 조각이 없다", async () => {
    const server = await start();
    const body = (await (await fetch(`${server.url}/api/view-model`)).json()) as ConsoleViewModel;
    expect(body.projects).toEqual(VIEW_MODEL.projects);
    expect(JSON.stringify(body.projects)).not.toMatch(/[/\\]/);
  });

  it("UI가 option 값으로 **인덱스**를 쓴다 — 경로를 보내지 않는다", () => {
    expect(UI_HTML).toContain("opt.value = String(p.index)");
    expect(UI_HTML).toContain("to_project_index: Number(select.value)");
  });

  it("UI가 경로 문자열을 조립하지 않는다 — 라벨은 서버가 이미 자른 값이다", () => {
    expect(UI_HTML).not.toMatch(/p\.(path|absolutePath|project_path)\b/);
    expect(UI_HTML).not.toContain("to_project_path");
  });

  it("동명 충돌이면 구별자를 함께 붙인다 — 잘못 고르면 엉뚱한 프로젝트가 바뀐다", () => {
    expect(UI_HTML).toContain("p.ambiguous");
    expect(UI_HTML).toContain("p.hashPrefix");
    // 인덱스·해시는 "다르다"만 알려준다 — 사람이 읽을 구별자(상위 한 칸)를 우선한다(재심 M4).
    expect(UI_HTML).toContain("p.parentHint");
  });

  it("요청에 선택 시점의 해시 접두를 실어 보낸다 — 서버가 대조할 수 있어야 한다 (재심 M1)", () => {
    expect(UI_HTML).toContain("to_project_hash_prefix");
  });

  it("뷰모델이 갱신되면 상세의 선택지도 다시 그린다 — 드롭다운만 옛 목록을 가리키지 않게", () => {
    expect(UI_HTML).toContain("renderDetailActions(CURRENT_ASSET)");
  });

  it("프로젝트 목록을 못 읽은 것을 '0건'으로 위장하지 않는다 (재심 M5)", () => {
    expect(UI_HTML).toContain("projects_unavailable");
    expect(UI_HTML).toContain("프로젝트 목록을 읽지 못했다");
  });

  it("이관 확인 화면이 어느 프로젝트인지 보여준다", () => {
    expect(UI_HTML).toContain("옮길 프로젝트");
    expect(UI_HTML).toContain("selectedProjectText(select)");
  });

  it("프로젝트가 없으면 선택 UI를 만들지 않는다 — 빈 드롭다운을 띄우지 않는다", () => {
    expect(UI_HTML).toContain("VM.projects.length > 0");
  });
});

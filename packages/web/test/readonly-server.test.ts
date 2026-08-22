import { afterEach, describe, expect, it } from "vitest";
import type { ConsoleViewModel } from "@ctk/core";
import { LOOPBACK_HOST, matchRoute, startReadonlyServer, type ListeningServer } from "../server/app.js";

/**
 * Step 6a 수용 기준의 실행형 검증. **"GET만 등록했다"를 코드로 확인하지 않고 실제 요청을
 * 보내 거부되는지 본다** — 규칙 존재 ≠ 규칙이 막음(CLAUDE.md 검증 절).
 */

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
      installations: [],
      has_annotation: true,
      has_usage_doc: false,
    },
  ],
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
    });
    const res = await fetch(`${running.url}/api/view-model`);
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "internal_error" });
  });
});

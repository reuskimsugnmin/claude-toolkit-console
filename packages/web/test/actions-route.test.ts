import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleViewModel } from "@ctk/core";
import { ActionError, startReadonlyServer, type ActionHandlers, type ListeningServer } from "../server/app.js";

/**
 * Step 6b 수용 기준의 실행형 검증.
 *
 * **가장 중요한 것은 첫 블록이다** — 액션 핸들러를 주지 않았을 때 `/api/actions`가 **존재하지
 * 않는지**. 존재하면서 403을 내는 것과 아예 없는 것은 다르다. 6a가 토큰·CSRF를 생략한 근거가
 * "쓰기 경로가 하나도 없다"이므로, 조회 모드에 경로가 생기는 순간 그 근거가 무너진다.
 */

const VIEW_MODEL: ConsoleViewModel = {
  schema_version: 1,
  generated_at: "2026-08-22T00:00:00.000Z",
  machine_id: "m1",
  freshness: { last_scan_at: "2026-08-22T00:00:00.000Z", days_since_last_scan: 0, is_stale: false, never_scanned: false },
  assets: [],
  projects: [],
  projects_unavailable: null,
  usage: {
    ranked: [],
    unrankable: [],
    total_assets_with_occupancy: 0,
    ranking_quality: { measured_count: 0, unmeasured_count: 0, is_meaningful: false, reason: "no_measured_assets" },
  },
};

const TOKEN = "t".repeat(43);

let running: ListeningServer | null = null;

function makeHandlers(overrides: Partial<ActionHandlers> = {}): ActionHandlers {
  return {
    scan: vi.fn(async () => ({ scanned: true })),
    rollback: vi.fn(async () => ({ rolledBack: true })),
    move: vi.fn(async () => ({ moved: true })),
    genEstimate: vi.fn(async () => ({ estimateToken: "est-1", data: { assets: 3, approx_bytes: 100 } })),
    genExecute: vi.fn(async () => ({ generated: 3 })),
    ...overrides,
  };
}

async function startReadonly(): Promise<ListeningServer> {
  running = await startReadonlyServer({ getViewModel: () => VIEW_MODEL, getAssetDoc: () => null });
  return running;
}

/** 액션 모드 서버는 포트를 알아야 관문을 만들 수 있다 — 포트를 먼저 잡고 다시 만든다. */
async function startBoundActions(handlers: ActionHandlers = makeHandlers()): Promise<ListeningServer> {
  const probe = await startReadonlyServer({ getViewModel: () => VIEW_MODEL, getAssetDoc: () => null, port: 0 });
  const port = probe.port;
  await probe.close();
  running = await startReadonlyServer({
    getViewModel: () => VIEW_MODEL,
    getAssetDoc: () => null,
    port,
    actions: { guard: { sessionToken: TOKEN, port }, handlers },
  });
  return running;
}

function actionHeaders(server: ListeningServer, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: `http://127.0.0.1:${server.port}`,
    "x-ctk-session": TOKEN,
    ...overrides,
  };
}

afterEach(async () => {
  if (running !== null) {
    await running.close();
    running = null;
  }
});

describe("조회 모드에는 쓰기 경로가 존재하지 않는다", () => {
  it("액션 핸들러가 없으면 /api/actions POST는 405다 — 경로 자체가 없다", async () => {
    const server = await startReadonly();
    const res = await fetch(`${server.url}/api/actions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("액션 핸들러가 없으면 GET /api/actions는 404다", async () => {
    const server = await startReadonly();
    expect((await fetch(`${server.url}/api/actions`)).status).toBe(404);
  });

  it("액션 모드에서는 같은 경로가 405가 아니다 — 위 케이스가 '전부 막힘'과 구분됨을 보인다", async () => {
    const server = await startBoundActions();
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "scan" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("관문 — 토큰·Origin·Host", () => {
  it("토큰이 없으면 401이고 핸들러가 호출되지 않는다", async () => {
    const handlers = makeHandlers();
    const server = await startBoundActions(handlers);
    const headers = actionHeaders(server);
    delete headers["x-ctk-session"];
    const res = await fetch(`${server.url}/api/actions`, { method: "POST", headers, body: JSON.stringify({ action: "scan" }) });
    expect(res.status).toBe(401);
    expect(handlers.scan).not.toHaveBeenCalled();
  });

  it("Origin이 다른 사이트면 401이다", async () => {
    const handlers = makeHandlers();
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server, { origin: "https://evil.example" }),
      body: JSON.stringify({ action: "scan" }),
    });
    expect(res.status).toBe(401);
    expect(handlers.scan).not.toHaveBeenCalled();
  });

  it("401 응답에 세션 토큰이 실리지 않는다", async () => {
    const server = await startBoundActions();
    const headers = actionHeaders(server, { "x-ctk-session": "wrong" });
    const res = await fetch(`${server.url}/api/actions`, { method: "POST", headers, body: JSON.stringify({ action: "scan" }) });
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("GET으로는 액션을 실행할 수 없다 — 405다", async () => {
    const server = await startBoundActions();
    const res = await fetch(`${server.url}/api/actions`, { headers: actionHeaders(server) });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("화이트리스트 — 자유 문자열이 들어갈 자리가 없다", () => {
  it("목록 밖 액션은 400이다", async () => {
    const server = await startBoundActions();
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "rm_rf" }),
    });
    expect(res.status).toBe(400);
  });

  it("project_path 자유 문자열 주입은 400이다 — 인덱스만 받는다", async () => {
    const server = await startBoundActions();
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "move", asset_id: "a", to: "project", project_path: "/etc/passwd" }),
    });
    expect(res.status).toBe(400);
  });

  it("gen에 catalog 경로를 끼워 넣으면 400이다", async () => {
    const server = await startBoundActions();
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "gen_estimate", max_total_usd: 1, catalog: "/tmp/evil" }),
    });
    expect(res.status).toBe(400);
  });

  it("scan에 파라미터를 붙이면 400이다 — label은 서버가 만든다", async () => {
    const server = await startBoundActions();
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "scan", label: "../../x" }),
    });
    expect(res.status).toBe(400);
  });

  it("400 응답에 스키마 세부가 실리지 않는다 — 되짚어 탐색하는 데 쓰인다", async () => {
    const server = await startBoundActions();
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "move" }),
    });
    const body = await res.text();
    expect(body).not.toContain("asset_id");
    expect(body).not.toContain("zod");
  });

  it("본문이 상한을 넘으면 413이다", async () => {
    const server = await startBoundActions();
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "scan", pad: "x".repeat(9000) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("gen 2-phase — 승인 없이는 어떤 API 호출도 없다 (F6)", () => {
  it("estimate는 genExecute를 부르지 않는다", async () => {
    const handlers = makeHandlers();
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "gen_estimate", max_total_usd: 1 }),
    });
    expect(res.status).toBe(200);
    expect(handlers.genEstimate).toHaveBeenCalledOnce();
    expect(handlers.genExecute).not.toHaveBeenCalled();
    expect((await res.json()) as { data: { estimate_token: string } }).toMatchObject({
      data: { estimate_token: "est-1" },
    });
  });

  it("estimate 토큰 없이 온 execute는 400이고 실행되지 않는다", async () => {
    const handlers = makeHandlers();
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "gen_execute", max_total_usd: 1 }),
    });
    expect(res.status).toBe(400);
    expect(handlers.genExecute).not.toHaveBeenCalled();
  });

  it("핸들러가 토큰을 거부하면 400이고 실행 결과를 만들지 않는다", async () => {
    const handlers = makeHandlers({
      genExecute: vi.fn(async () => {
        throw new ActionError("estimate_token_invalid", "발급된 적 없는 estimate 토큰이다");
      }),
    });
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "gen_execute", max_total_usd: 1, estimate_token: "forged" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "estimate_token_invalid" });
  });

  it("서버 상한을 넘는 예산은 클램프되고 그 사실이 응답에 실린다", async () => {
    const handlers = makeHandlers();
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "gen_estimate", max_total_usd: 999, max_assets: 9999 }),
    });
    expect(handlers.genEstimate).toHaveBeenCalledWith({ maxAssets: 25, maxTotalUsd: 2 });
    expect((await res.json()) as { data: { clamped: boolean } }).toMatchObject({ data: { clamped: true } });
  });
});

describe("실패를 성공으로 삼키지 않는다", () => {
  it("잠금 경합은 409 lock_contended다", async () => {
    const handlers = makeHandlers({
      scan: vi.fn(async () => {
        throw new ActionError("lock_contended", "다른 ctk 실행이 카탈로그를 점유 중이다");
      }),
    });
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "scan" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "lock_contended" });
  });

  it("인덱스 범위 밖은 400 project_index_out_of_range다 — 스키마가 아니라 핸들러가 판정한다", async () => {
    const handlers = makeHandlers({
      move: vi.fn(async () => {
        throw new ActionError("project_index_out_of_range", "프로젝트 인덱스가 목록 범위 밖이다");
      }),
    });
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({
        action: "move",
        asset_id: "a",
        to: "project",
        to_project_index: 999,
        to_project_hash_prefix: "abc123",
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "project_index_out_of_range" });
  });

  it("예상 못한 예외도 200이 되지 않는다", async () => {
    const handlers = makeHandlers({
      rollback: vi.fn(async () => {
        throw new Error("디스크가 가득 찼다");
      }),
    });
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "rollback" }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: false, code: "action_failed" });
  });
});

describe("총액 하한 — 지수 표기가 argv로 흘러들지 않는다 (심사 L-e)", () => {
  it("하한 미만의 총액은 400이고 핸들러가 호출되지 않는다", async () => {
    const handlers = makeHandlers();
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "gen_estimate", max_total_usd: 1e-7 }),
    });
    expect(res.status).toBe(400);
    expect(handlers.genEstimate).not.toHaveBeenCalled();
  });

  it("하한값 자체는 통과한다 — 위 케이스가 '전부 거부'와 구분됨을 보인다", async () => {
    const handlers = makeHandlers();
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "gen_estimate", max_total_usd: 0.01 }),
    });
    expect(res.status).toBe(200);
  });
});

describe("응답에 절대경로가 실리지 않는다 (심사 M1의 나머지 범위)", () => {
  it("핸들러가 경로를 돌려줘도 관문이 가린다 — 새 핸들러가 투영을 빠뜨려도 새지 않게", async () => {
    const handlers = makeHandlers({
      scan: vi.fn(async () => ({
        snapshotPath: "/synthetic/home/.local/share/ctk/catalog/machines/m/snapshots/x.jsonl",
        counts: { plugin: 1 },
      })),
    });
    const server = await startBoundActions(handlers);
    const res = await fetch(`${server.url}/api/actions`, {
      method: "POST",
      headers: actionHeaders(server),
      body: JSON.stringify({ action: "scan" }),
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain("/synthetic/home");
    expect(body).not.toContain(".local/share");
    // 액션이 성공했다는 사실 자체는 유지된다 — 가릴 뿐 실패로 뒤집지 않는다.
    expect(body).toContain('"ok":true');
    expect(body).toContain("plugin");
  });

  it("중첩된 배열·객체 안의 경로도 가린다", async () => {
    const handlers = makeHandlers({
      rollback: vi.fn(async () => ({ files: [{ path: "/etc/passwd" }, { path: "/synthetic/home/.claude/settings.json" }] })),
    });
    const server = await startBoundActions(handlers);
    const body = await (
      await fetch(`${server.url}/api/actions`, {
        method: "POST",
        headers: actionHeaders(server),
        body: JSON.stringify({ action: "rollback" }),
      })
    ).text();
    expect(body).not.toContain("/etc/passwd");
    expect(body).not.toContain("/synthetic/home");
  });

  it("경로가 아닌 값은 건드리지 않는다 — 가리기가 정보를 통째로 지우지 않는다", async () => {
    const handlers = makeHandlers({ scan: vi.fn(async () => ({ count: 42, name: "synth-a", ratio: 0.5 })) });
    const server = await startBoundActions(handlers);
    const body = (await (
      await fetch(`${server.url}/api/actions`, {
        method: "POST",
        headers: actionHeaders(server),
        body: JSON.stringify({ action: "scan" }),
      })
    ).json()) as { data: { count: number; name: string; ratio: number } };
    expect(body.data).toEqual({ count: 42, name: "synth-a", ratio: 0.5 });
  });
});

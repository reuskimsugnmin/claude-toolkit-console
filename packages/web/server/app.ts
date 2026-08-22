import { createServer, type Server } from "node:http";
import { handleReadonlyRequest, type ReadonlyRouteDeps } from "./readonly-routes.js";
import { scrubAbsolutePaths } from "./routes/actions.js";

/**
 * @ctk/web/server — Step 6a 조회 전용 서버. Step 6b(액션 API)는 아직 없다.
 *
 * **`web`은 `cli`를 import하지 않는다.** 카탈로그를 읽어 뷰모델을 만드는 일은 CLI가 하고,
 * 이 모듈은 그 결과를 반환하는 함수만 주입받는다(합성 루트에서의 의존성 주입) — 그래야
 * `ctk web --export-view-model`과 서버가 **같은 조립 코드**를 쓴다는 보장이 유지된다.
 *
 * **바인딩은 127.0.0.1 고정이다.** 카탈로그에는 이 머신에 설치된 툴 목록이 들어 있어
 * 네트워크에 노출하면 정보 유출이다. 호스트를 인자로 받지 않는 이유가 이것이다 — 받으면
 * 언젠가 `0.0.0.0`이 들어온다.
 */

/** 외부 인터페이스에 노출하지 않는다. 상수로 고정하고 인자로 열지 않는다. */
export const LOOPBACK_HOST = "127.0.0.1" as const;

export interface CreateReadonlyServerOptions extends Omit<ReadonlyRouteDeps, "port"> {
  /** 0을 주면 OS가 빈 포트를 고른다(테스트용). 실제 포트는 listen 후 서버에서 조회한다. */
  port?: number;
}

export function createReadonlyServer(options: CreateReadonlyServerOptions): Server {
  const server: Server = createServer((req, res) => {
    try {
      // 포트는 listen 이후에야 확정된다(`port: 0`이면 OS가 고른다) — 요청 시점에 조회한다.
      // 호출자가 명시한 값을 그대로 믿으면 0을 기대값으로 쓰게 되어 Host 검사가 항상 실패한다.
      const address = server.address();
      const actualPort = address !== null && typeof address !== "string" ? address.port : (options.port ?? 0);
      handleReadonlyRequest(req, res, { ...options, port: actualPort });
    } catch (err) {
      // 조회 중 예외를 빈 200으로 삼키지 않는다 — 화면이 "자산 0건"을 정상으로 표시하게 된다.
      // 최상위 catch도 무인증 응답이다 — 원문에 절대경로가 섞여 나가지 않게 한다(재심 M3·M5).
      const message = scrubAbsolutePaths(err instanceof Error ? err.message : String(err)) as string;
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      }
      res.end(`${JSON.stringify({ error: "internal_error", message })}\n`);
    }
  });
  return server;
}

export interface ListeningServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startReadonlyServer(options: CreateReadonlyServerOptions): Promise<ListeningServer> {
  const server = createReadonlyServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("서버 주소를 확인할 수 없다 — 루프백 바인딩을 보장할 수 없으므로 기동을 중단한다");
  }
  return {
    server,
    port: address.port,
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)));
      }),
  };
}

export * from "./readonly-routes.js";
export * from "./origin-guard.js";
export * from "./routes/actions.js";

import { createServer, type Server } from "node:http";
import { handleReadonlyRequest, type ReadonlyRouteDeps } from "./readonly-routes.js";

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

export interface CreateReadonlyServerOptions extends ReadonlyRouteDeps {
  /** 0을 주면 OS가 빈 포트를 고른다(테스트용). */
  port?: number;
}

export function createReadonlyServer(options: CreateReadonlyServerOptions): Server {
  return createServer((req, res) => {
    try {
      handleReadonlyRequest(req, res, options);
    } catch (err) {
      // 조회 중 예외를 빈 200으로 삼키지 않는다 — 화면이 "자산 0건"을 정상으로 표시하게 된다.
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      }
      res.end(`${JSON.stringify({ error: "internal_error", message })}\n`);
    }
  });
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

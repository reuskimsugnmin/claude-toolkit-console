import { describe, expect, it } from "vitest";
import { McpJsonShapeError, parseMcpJson, redactMcpServerSecrets } from "../src/harness/mcp-json.schema.js";

/**
 * core/test/mcp-json-schema.test.ts — B4-a-1.
 *
 * ⚠️ **정본에 적힌 판별 방법이 틀렸고, 코드를 짜기 전에 재서 잡혔다.**
 * `docs/harness-facts.md`의 원래 관측 방법은 "최상위 키가 `mcpServers` 하나뿐인지"였는데,
 * 실측 래퍼형 14건 중 **3건이 추가 최상위 키를 함께 갖는다**(`recommendedCategories`).
 * 그 규칙을 따르면 이 3건이 평면형으로 오분류되고 파서가 `mcpServers`·`recommendedCategories`를
 * **서버 이름으로 읽어 쓰레기 자산 2개를 만든다** — "0건"(누락)과 "허위 건수"(과잉)가 같은
 * 틀린 규칙에서 나온다.
 */

describe("parseMcpJson — 두 형태를 가른다", () => {
  it("래퍼형 — mcpServers 안의 키만 서버다", () => {
    const r = parseMcpJson({ mcpServers: { alpha: { command: "npx" }, beta: { command: "uvx" } } });
    expect(r.shape).toBe("wrapper");
    expect([...r.servers.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(r.ignoredTopLevelKeys).toEqual([]);
  });

  it("⚠️ 래퍼형에 추가 최상위 키가 있어도 래퍼형이다 — 실측 3건이 이 모양이다", () => {
    const r = parseMcpJson({
      mcpServers: { alpha: { command: "npx" } },
      recommendedCategories: ["docs"],
    });
    expect(r.shape, "추가 키 때문에 평면형으로 오분류됐다 — 정본에 적힌 옛 규칙의 결함이다").toBe("wrapper");
    // 핵심 단언 — 추가 키가 **서버로 둔갑하지 않는다.**
    expect([...r.servers.keys()]).toEqual(["alpha"]);
    expect([...r.servers.keys()]).not.toContain("recommendedCategories");
    expect([...r.servers.keys()]).not.toContain("mcpServers");
    // 무시한 키는 조용히 버리지 않는다 — 하네스가 형태를 바꾸면 여기가 먼저 커진다.
    expect(r.ignoredTopLevelKeys).toEqual(["recommendedCategories"]);
  });

  it("평면형 — 최상위 키가 곧 서버다", () => {
    const r = parseMcpJson({ alpha: { command: "npx" }, beta: { command: "uvx" } });
    expect(r.shape).toBe("flat");
    expect([...r.servers.keys()].sort()).toEqual(["alpha", "beta"]);
  });

  it("빈 객체는 평면형 0건이다 — 형태 오류가 아니다(MCP를 번들하지 않는 파일)", () => {
    const r = parseMcpJson({});
    expect(r.shape).toBe("flat");
    expect(r.servers.size).toBe(0);
  });

  it("빈 래퍼도 서버 0건이다 — '없음'이지 '실패'가 아니다", () => {
    const r = parseMcpJson({ mcpServers: {} });
    expect(r.shape).toBe("wrapper");
    expect(r.servers.size).toBe(0);
  });
});

describe("parseMcpJson — 어느 형태도 아니면 던진다(빈 결과로 삼키지 않는다)", () => {
  it.each([
    ["최상위가 배열", [] as unknown],
    ["최상위가 문자열", "x" as unknown],
    ["최상위가 null", null as unknown],
  ])("%s이면 McpJsonShapeError", (_label, raw) => {
    expect(() => parseMcpJson(raw)).toThrow(McpJsonShapeError);
  });

  it("mcpServers 키가 있는데 값이 객체가 아니면 던진다 — 평면형으로 읽으면 그 키가 서버가 된다", () => {
    // ⚠️ 이것이 "허위 건수"가 태어나는 정확한 지점이다. 조용히 평면형으로 흘리면
    // `mcpServers`라는 이름의 자산이 생긴다.
    expect(() => parseMcpJson({ mcpServers: "oops" })).toThrow(McpJsonShapeError);
  });

  it("평면형인데 값이 객체가 아닌 항목이 섞이면 던진다", () => {
    expect(() => parseMcpJson({ alpha: { command: "npx" }, beta: 3 })).toThrow(McpJsonShapeError);
  });

  it("에러 메시지에 원문 값이 실리지 않는다 — 이 문자열은 warnings를 타고 브라우저까지 간다", () => {
    try {
      parseMcpJson({ mcpServers: "secret-looking-value" });
      expect.unreachable("던지지 않았다");
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-looking-value");
      expect((err as Error & { failureClass: string }).failureClass).toBe("parse_schema_mismatch");
    }
  });
});

/**
 * ⚠️ **README와 등급이 다른 유출면이다.** `.mcp.json`의 `env`·`headers`는 **원래 자격증명을 담는
 * 자리**이고, `gen`은 이 내용을 프롬프트에 싣고 그 결과가 카탈로그 문서가 되어 **동기화 저장소로
 * 나간다.** 실측상 이 머신에는 리터럴 토큰이 없었지만(토큰류 키 3건 전부 `${...}` 보간),
 * **그 안전은 우연이다** — 구조로 막는다.
 */
/**
 * ⚠️ **보안 재심 H-1 — 첫 구현이 8개 형태 중 6개에서 뚫렸다.** 아래 표는 심사가 실제로 주입한
 * 형태를 그대로 고정한 것이다. 대조군 A(가려져야 함)와 H(살아야 함)를 함께 두어 **프로브가
 * 동어반복이 아님**을 보인다 — 전부 가리기만 해도 통과하는 테스트가 아니다.
 */
describe("redactMcpServerSecrets — 심사가 뚫은 8개 형태(H-1 회귀)", () => {
  function leaked(def: Record<string, unknown>, needle: string): boolean {
    return JSON.stringify(redactMcpServerSecrets(def).definition).includes(needle);
  }

  it("A(대조군) 순수 리터럴은 가려진다", () => {
    const r = redactMcpServerSecrets({ env: { K: "sk-live-SECRET" } });
    expect(r.redactedCount).toBe(1);
    expect(leaked({ env: { K: "sk-live-SECRET" } }, "sk-live-SECRET")).toBe(false);
  });

  it("B — `$`와 글자를 담은 리터럴도 가려진다(부분 일치 통과가 결함이었다)", () => {
    expect(leaked({ env: { K: "sk-live-SECRET$abc" } }, "sk-live-SECRET")).toBe(false);
  });

  it("C — 비밀번호에 `$`가 든 DB URL도 가려진다", () => {
    expect(leaked({ env: { DB: "postgres://u:p$aw0rd@h/db" } }, "p$aw0rd")).toBe(false);
  });

  it("D — env 값이 배열이어도 안쪽까지 가린다(컨테이너는 값의 그릇이다)", () => {
    expect(leaked({ env: { K: ["sk-live-SECRET"] } }, "sk-live-SECRET")).toBe(false);
  });

  it("E — env 값이 중첩 객체여도 안쪽까지 가린다", () => {
    expect(leaked({ env: { K: { inner: "sk-live-SECRET" } } }, "sk-live-SECRET")).toBe(false);
  });

  it("F — args의 `--flag=value` 오른쪽이 가려진다", () => {
    expect(leaked({ args: ["--api-key=sk-live-SECRET"] }, "sk-live-SECRET")).toBe(false);
  });

  it("G — url의 쿼리가 제거된다(실측상 url이 23개 중 19개로 가장 흔한 자리다)", () => {
    const def = { url: "https://mcp.example.com/sse?key=sk-live-SECRET" };
    expect(leaked(def, "sk-live-SECRET")).toBe(false);
    // 호스트·경로는 남는다 — "무엇에 붙는 서버인가"는 문서에 필요하다.
    const out = redactMcpServerSecrets(def).definition.url as string;
    expect(out).toContain("mcp.example.com");
    expect(out).toContain("/sse");
  });

  it("H(대조군) 순수 참조는 살아남는다 — 전부 가리기만 하는 구현은 여기서 실패한다", () => {
    const r = redactMcpServerSecrets({ env: { K: "${GITHUB_TOKEN}" } });
    expect((r.definition.env as Record<string, unknown>).K).toBe("${GITHUB_TOKEN}");
    expect(r.redactedCount).toBe(0);
  });

  it("`$VAR`(중괄호 없는 형태)도 참조로 본다", () => {
    expect(redactMcpServerSecrets({ env: { K: "$GITHUB_TOKEN" } }).redactedCount).toBe(0);
  });

  it("⚠️ 못 잡는 축을 명시한다 — 별도 토큰으로 준 자격증명은 남는다(측정한 결정이지 누락이 아니다)", () => {
    // 이름 패턴으로 잡으려면 패턴에 없는 이름을 놓친다. 잡는 척하지 않고 사실을 고정한다.
    expect(leaked({ args: ["--api-key", "sk-live-SECRET"] }, "sk-live-SECRET")).toBe(true);
  });

  it("가리지 않기로 한 자리는 그대로다 — command·title·description은 문서의 알맹이다", () => {
    const r = redactMcpServerSecrets({ command: "npx", title: "Alpha", description: "설명" });
    expect(r.definition).toMatchObject({ command: "npx", title: "Alpha", description: "설명" });
    expect(r.redactedCount).toBe(0);
  });

  it("url이 파싱되지 않으면 통째로 가린다(fail-closed)", () => {
    const r = redactMcpServerSecrets({ url: "not a url ?key=sk-live-SECRET" });
    expect(r.definition.url).toBe("<redacted>");
    expect(r.redactedCount).toBe(1);
  });

  it("쿼리가 없는 url은 그대로 남는다 — 과잉 가림이 아니다", () => {
    const r = redactMcpServerSecrets({ url: "https://mcp.example.com/sse" });
    expect(r.definition.url).toBe("https://mcp.example.com/sse");
    expect(r.redactedCount).toBe(0);
  });

  it("npx 인자는 남는다 — 문서가 무엇을 실행하는 서버인지 말할 수 있어야 한다", () => {
    const r = redactMcpServerSecrets({ command: "npx", args: ["-y", "some-server@1.0"] });
    expect(r.definition.args).toEqual(["-y", "some-server@1.0"]);
    expect(r.redactedCount).toBe(0);
  });
});

describe("redactMcpServerSecrets — 키는 남기고 값만 가린다", () => {
  it("env의 리터럴 값을 가리고 건수를 돌려준다", () => {
    const r = redactMcpServerSecrets({ command: "npx", env: { API_KEY: "sk-live-abcdef123456" } });
    const env = r.definition.env as Record<string, unknown>;
    expect(env.API_KEY).toBe("<redacted>");
    expect(r.redactedCount).toBe(1);
    // 키는 남는다 — "이 서버는 API_KEY를 요구한다"는 유용한 정보다.
    expect(Object.keys(env)).toEqual(["API_KEY"]);
    // 값이 어디에도 남지 않는다.
    expect(JSON.stringify(r.definition)).not.toContain("sk-live-abcdef123456");
  });

  it("headers의 Authorization도 가린다 — env만 보지 않는다", () => {
    const r = redactMcpServerSecrets({ headers: { Authorization: "Bearer secret-token-value" } });
    expect(JSON.stringify(r.definition)).not.toContain("secret-token-value");
    expect(r.redactedCount).toBe(1);
  });

  it("`${VAR}` 보간은 가리지 않는다 — 값이 아니라 참조이고, 어떤 변수를 요구하는지가 유용하다", () => {
    const r = redactMcpServerSecrets({ env: { TOKEN: "${GITHUB_TOKEN}" } });
    expect((r.definition.env as Record<string, unknown>).TOKEN).toBe("${GITHUB_TOKEN}");
    expect(r.redactedCount).toBe(0);
  });

  it("⚠️ 길이도 싣지 않는다 — 토큰 길이는 어떤 서비스인지 좁히는 단서다", () => {
    const r = redactMcpServerSecrets({ env: { A: "x".repeat(40), B: "y".repeat(64) } });
    const env = r.definition.env as Record<string, unknown>;
    expect(env.A).toBe("<redacted>");
    expect(env.B).toBe("<redacted>");
    expect(env.A).toBe(env.B); // 길이 차이가 드러나지 않는다
  });

  it("env가 없으면 가릴 것이 없고, 형태가 이상하면 가린다(fail-closed)", () => {
    expect(redactMcpServerSecrets({ command: "npx" }).redactedCount).toBe(0);
    // ⚠️ 이 단언은 원래 `toBe(0)`이었고 **옛 fail-open 동작을 고정하고 있었다**(보안 재심 H-1).
    // `env`가 객체가 아닌 것은 정상 형태가 아니므로 "모르면 남기지 않는다"가 옳다.
    expect(redactMcpServerSecrets({ env: "weird" }).redactedCount).toBe(1);
    // null·숫자·불리언은 자격증명일 수 없으므로 세지 않는다.
    expect(redactMcpServerSecrets({ env: null }).redactedCount).toBe(0);
  });
});

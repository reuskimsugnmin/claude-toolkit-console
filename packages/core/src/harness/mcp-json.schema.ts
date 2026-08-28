import { z } from "zod";

/**
 * `<플러그인 installPath>/.mcp.json` 파서 — B4-a-1.
 *
 * ## 두 형태가 공존한다 (실측 2026-08-26 · 재측정 2026-08-28)
 *
 * ```
 * 래퍼형   { "mcpServers": { "<서버명>": {...} }, ...추가 키 }
 * 평면형   { "<서버명>": {...} }
 * ```
 *
 * 설치 플러그인 66개 중 `.mcp.json` 보유 17개 — **래퍼형 14 · 평면형 3 · 총 서버 정의 23개**.
 *
 * ## ⚠️ 판별 규칙이 정본에 틀리게 적혀 있었다
 *
 * `docs/harness-facts.md`의 원래 관측 방법은 **"최상위 키가 `mcpServers` 하나뿐인지"** 였다.
 * 그런데 실측 14건의 래퍼형 중 **3건이 추가 최상위 키를 함께 갖는다**(`recommendedCategories`).
 * 그 규칙을 따르면 이 3건이 **평면형으로 오분류되고**, 파서는 `mcpServers`와
 * `recommendedCategories`를 **서버 이름으로 읽어 쓰레기 자산 2개를 만든다.**
 *
 * **"0건"(누락)과 "허위 건수"(과잉)가 같은 틀린 규칙에서 나온다** — 문서는 전자만 경고하고
 * 있었다. 올바른 판별은 **`mcpServers` 키가 있고 그 값이 객체인가**이고, 래퍼형에서 나머지
 * 최상위 키는 **서버가 아니다.**
 *
 * ## 어느 형태도 아니면 던진다
 *
 * 최상위가 객체가 아니거나 평면형인데 값이 객체가 아닌 항목이 섞이면 `McpJsonShapeError`다 —
 * **빈 결과로 삼키지 않는다**(안전 원칙 7). 실측상 0건이지만 그 전제에 기대지 않는다:
 * 조용한 0건은 "이 플러그인은 MCP를 번들하지 않는다"와 구별되지 않는다.
 */

/** 서버 정의 본문. 필드는 하네스가 정하므로 **강제하지 않고 통과시킨다**(R13 드리프트 방어). */
export const McpServerDefinitionSchema = z.record(z.string(), z.unknown());
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;

/** 이 파일이 어느 형태였는지. **판정을 버리지 않는다** — 진단과 실측 재확인에 쓴다. */
export type McpJsonShape = "wrapper" | "flat";

export interface ParsedMcpJson {
  shape: McpJsonShape;
  /** 서버명 → 정의. 래퍼형에서 `mcpServers` **밖의** 최상위 키는 여기 들어오지 않는다. */
  servers: Map<string, McpServerDefinition>;
  /**
   * 래퍼형에서 무시한 추가 최상위 키(실측 3건의 `recommendedCategories` 등).
   * **조용히 버리지 않는다** — 하네스가 형태를 바꾸면 여기가 먼저 커진다(R13 조기 신호).
   */
  ignoredTopLevelKeys: string[];
}

/**
 * `.mcp.json`이 두 형태 중 어느 쪽도 아니다. `parse_schema_mismatch`로 분류한다 — 하네스 출력이
 * 알던 스키마와 어긋났다는 뜻이고, 그것은 "없음"이 아니라 "실패"다.
 */
export class McpJsonShapeError extends Error {
  readonly failureClass = "parse_schema_mismatch" as const;
  constructor(reason: string) {
    // ⚠️ 경로도 원문도 메시지에 넣지 않는다 — 이 문자열은 `scan` warnings를 타고 브라우저까지 간다.
    super(`.mcp.json이 알려진 두 형태(mcpServers 래퍼 · 평면) 중 어느 쪽도 아니다: ${reason}`);
    this.name = "McpJsonShapeError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseMcpJson(raw: unknown): ParsedMcpJson {
  if (!isPlainObject(raw)) {
    throw new McpJsonShapeError("최상위가 객체가 아니다");
  }

  // ⚠️ **키 개수를 세지 않는다.** `mcpServers`가 객체로 있으면 래퍼형이고, 그 밖의 최상위 키는
  // 서버가 아니라 부가 메타데이터다(실측: 래퍼형 14건 중 3건이 그렇다).
  const wrapped = raw["mcpServers"];
  if (isPlainObject(wrapped)) {
    const servers = new Map<string, McpServerDefinition>();
    for (const [name, def] of Object.entries(wrapped)) {
      if (!isPlainObject(def)) {
        throw new McpJsonShapeError(`mcpServers의 항목 하나가 객체가 아니다(서버 ${servers.size + 1}번째)`);
      }
      servers.set(name, def);
    }
    return {
      shape: "wrapper",
      servers,
      ignoredTopLevelKeys: Object.keys(raw).filter((k) => k !== "mcpServers"),
    };
  }

  // `mcpServers`가 있는데 객체가 아니면 래퍼형이 깨진 것이다 — 평면형으로 읽어 그 키를 서버로
  // 삼으면 정확히 위에서 경계한 "허위 건수"가 된다.
  if (Object.prototype.hasOwnProperty.call(raw, "mcpServers")) {
    throw new McpJsonShapeError("mcpServers 키가 있으나 값이 객체가 아니다");
  }

  const servers = new Map<string, McpServerDefinition>();
  for (const [name, def] of Object.entries(raw)) {
    if (!isPlainObject(def)) {
      throw new McpJsonShapeError(`평면형인데 최상위 항목의 값이 객체가 아니다(항목 ${servers.size + 1}번째)`);
    }
    servers.set(name, def);
  }
  return { shape: "flat", servers, ignoredTopLevelKeys: [] };
}


/**
 * `.mcp.json` 서버 정의에서 **자격증명이 담기는 자리의 값을 가린다**(B4-a-1 · 보안 재심 H-1로 재작성).
 *
 * ## 왜 필요한가
 *
 * `gen`은 이 정의를 프롬프트에 싣고 그 결과가 카탈로그 문서가 되어 **동기화 저장소로 나간다.**
 * README에는 시크릿이 잘 들어가지 않지만 **MCP 설정 파일은 원래 자격증명을 담는 자리다.**
 *
 * ⚠️ **첫 구현이 8개 형태 중 6개에서 뚫렸다**(보안 재심 H-1이 실증). 세 결함이 겹쳤다:
 * ① `isEnvReference`가 **부분 일치**라 `$`와 글자를 어딘가 담기만 하면 통째로 통과했다
 *    (`sk-live-SECRET$abc` · `postgres://u:p$aw0rd@h/db`).
 * ② **문자열이 아닌 값**(배열·객체)을 그대로 흘렸다 — 컨테이너는 값이 아니라 **값의 그릇**이다.
 * ③ **자리를 잘못 골랐다.** "키 이름이 아니라 위치로 정한다"고 적어 놓고 `env`·`headers`만 봤는데,
 *    실측 23개 정의의 분포는 **`url` 19 · `title` 9 · `description` 9 · `headers` 5 ·
 *    `command` 4 · `args` 4 · `env` 0**이었다. 고른 두 자리가 5/23만 덮었다.
 *
 * 그리고 뚫릴 때마다 `redactedCount`가 0이라 **"깨끗해서 0"과 "우회당해서 0"이 구별되지 않았다.**
 *
 * ## 지금 규칙 — 통과 축을 완전 일치로 좁히고, 자리는 실측으로 고른다
 *
 * | 자리 | 처리 | 근거 |
 * |---|---|---|
 * | `env` · `headers` | 값 전부 가림(컨테이너는 재귀) | 자격증명의 지정석 |
 * | `url` | **쿼리·프래그먼트만** 제거, 호스트·경로는 남김 | `?key=` 는 문서화된 MCP 인증 관행. 호스트는 "무엇을 붙는 서버인가"라 문서에 필요하다 |
 * | `args` | `-flag=value` 꼴의 **오른쪽만** 가림 | `npx -y pkg@1.0`은 남아야 문서가 쓸모 있다 |
 * | `command` · `title` · `description` · 그 외 | **가리지 않는다** | 실측상 자격증명이 오는 자리가 아니고, 가리면 문서가 무의미해진다 |
 *
 * ⚠️ **`command`와 args의 맨 토큰을 가리지 않는 것은 측정해서 내린 결정이지 누락이 아니다.**
 * 별도 토큰으로 주는 자격증명(`["--api-key", "sk-..."]`)은 이 규칙이 못 잡는다 — 이름 패턴으로
 * 잡으려면 패턴에 없는 이름을 놓치므로, **못 잡는 축을 여기 적어 두고** 잡는 척하지 않는다.
 *
 * ⚠️ **통과시키는 유일한 축은 "값 전체가 환경변수 참조"일 때다**(`${VAR}` 또는 `$VAR`).
 * 참조는 값이 아니라 **어떤 변수를 요구하는지**를 말해 주므로 문서에 필요하다.
 *
 * **가린 건수를 돌려주고, 호출자가 그것을 기록한다** — 세어 놓고 아무도 안 읽으면 미배선이다.
 */
export interface RedactedMcpDefinition {
  definition: McpServerDefinition;
  /** 값이 가려진 항목 수. 0이면 가린 것이 **없다는 사실**이지 "검사 안 함"이 아니다. */
  redactedCount: number;
}

/** 값 전체가 환경변수 참조일 때만 통과 — **부분 일치가 아니라 완전 일치다**(H-1 ①). */
const PURE_ENV_REFERENCE = /^\s*(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)\s*$/;

const REDACTED = "<redacted>";

/** 값 하나를 가린다 — **컨테이너는 재귀한다**(H-1 ②). 숫자·불리언·null은 자격증명이 아니다. */
function redactValue(value: unknown, counter: { n: number }): unknown {
  if (typeof value === "string") {
    if (PURE_ENV_REFERENCE.test(value)) return value;
    counter.n++;
    // ⚠️ 길이도 싣지 않는다 — 토큰 길이는 그 자체로 어떤 서비스인지 좁히는 단서다.
    return REDACTED;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, counter));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, counter)]));
  }
  return value;
}

/** `url`의 쿼리·프래그먼트를 잘라낸다. 파싱 불가면 **통째로 가린다**(fail-closed). */
function redactUrl(value: unknown, counter: { n: number }): unknown {
  if (typeof value !== "string") return redactValue(value, counter);
  if (PURE_ENV_REFERENCE.test(value)) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    counter.n++;
    return REDACTED; // 형태를 모르면 남기지 않는다.
  }
  if (parsed.search === "" && parsed.hash === "") return value; // 가릴 것이 없다.
  counter.n++;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** `-flag=value` 꼴의 오른쪽만 가린다. 맨 토큰(`npx` · `pkg@1.0`)은 문서에 필요하므로 남긴다. */
function redactArgs(value: unknown, counter: { n: number }): unknown {
  if (!Array.isArray(value)) return redactValue(value, counter);
  return value.map((token) => {
    if (typeof token !== "string" || !token.startsWith("-")) return token;
    const eq = token.indexOf("=");
    if (eq === -1) return token;
    const rhs = token.slice(eq + 1);
    if (rhs.length === 0 || PURE_ENV_REFERENCE.test(rhs)) return token;
    counter.n++;
    return `${token.slice(0, eq)}=${REDACTED}`;
  });
}

export function redactMcpServerSecrets(definition: McpServerDefinition): RedactedMcpDefinition {
  const counter = { n: 0 };
  const out: Record<string, unknown> = { ...definition };

  for (const key of ["env", "headers"] as const) {
    if (!(key in definition)) continue;
    out[key] = redactValue(definition[key], counter);
  }
  if ("url" in definition) out["url"] = redactUrl(definition["url"], counter);
  if ("args" in definition) out["args"] = redactArgs(definition["args"], counter);

  return { definition: out, redactedCount: counter.n };
}

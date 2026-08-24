import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { OccupancyFailureKind, OccupancyValue } from "@ctk/core";
import type { TokenCacheStore } from "../cache/cache-store.js";

/**
 * probe/src/occupancy/count-tokens.ts — 5A(§1.3 결정 5, ADR-005) `messages.countTokens` 실측.
 * **승인 목록 신규 등재 대상 (착수 조건 C5, iter 8 L1)**: `@anthropic-ai/sdk`는 계획 ADR-002/005가
 * 명시한 토큰 측정 수단이다("토큰 측정은 @anthropic-ai/sdk의 messages.countTokens") — Step 1
 * 시점엔 `core`가 아직 없어 "런타임 의존성 0개"로 관측됐을 뿐, 이 SDK 자체는 계획이 처음부터
 * 승인한 항목이다(catalog-config.ts의 zod와 동급). `pnpm ls -r --prod`의 "승인 목록 외 0개"
 * 불변식에 이 패키지를 새 승인 항목으로 추가한다 — probe 하나에만 존재하고, 크레덴셜이 없으면
 * (이 환경) 호출 자체를 시도하지 않고 `unmeasured`로 열화한다(AC-4.5).
 *
 * **크레덴셜 감지를 `ANTHROPIC_API_KEY` 유무로 판단하지 않는다(2026-08-24 정정).** 이 파일은
 * 한때 "env 하나만 본다"고 적혀 있었고 `measure` 커맨드의 게이트가 그 옛 가정에 배선돼 있었다 —
 * 그 결과 `ant auth login` 프로파일로 **측정 가능한 사용자가 `credential_missing`으로 거부**됐다.
 * 아래 `countTokensMeasured`가 SDK의 전체 해석 체인에 위임하고, 게이트도 그 결과로 판정한다
 * (cli/commands/measure.ts). `claude` CLI의 구독 OAuth는 여전히 별개 표면이다 —
 * `@anthropic-ai/sdk`는 그 키체인 인증을 공유하지 않는다(docs/harness-facts.md).
 */

export interface CountTokensOptions {
  text: string;
  tokenizerModel: string;
  cache: TokenCacheStore;
  /** 테스트 주입용. 기본값은 `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string | undefined;
  /** 테스트 주입용 — 실제 네트워크 호출 없이 Anthropic 클라이언트를 흉내낼 수 있게 한다. */
  client?: Pick<Anthropic["messages"], "countTokens">;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 텍스트 하나를 3상태로 측정한다. 캐시 히트면 네트워크 호출 없이 `measured`를 즉시 반환한다.
 *
 * ⚠️ **`ANTHROPIC_API_KEY` 미설정이 "크레덴셜 없음"을 뜻하지 않는다.** SDK는 네 단계로 해석한다 —
 * `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ant auth login` 프로파일 → Workload Identity
 * Federation. 따라서 env 하나만 보고 포기하면 `ant` 프로파일을 쓰는 사용자가 측정 가능한데도
 * `unmeasured`로 떨어진다. **인자 없는 생성자에 해석을 맡기고, 실패했을 때 그 원인을 구분한다**
 * (안전 원칙 5 — "없음"과 "실패"를 구분한다: 크레덴셜 부재와 호출 실패는 다른 상태다).
 *
 * AC-4.5는 그대로 유지된다 — 어느 경로로도 크레덴셜이 없으면 `unmeasured`이고 추정치는 넣지 않는다.
 */
export async function countTokensMeasured(options: CountTokensOptions): Promise<OccupancyValue> {
  const { text, tokenizerModel, cache } = options;
  const contentSha256 = sha256(text);

  const cached = cache.get({ content_sha256: contentSha256, tokenizer_model: tokenizerModel });
  if (cached !== undefined) {
    return { state: "measured", value_tokens: cached, tokenizer_model: tokenizerModel, measured_at: new Date().toISOString() };
  }

  // 명시 키가 있으면 그것을 쓰고, 없으면 **인자 없는 생성자**로 SDK의 전체 크레덴셜 체인에 맡긴다.
  // 생성자 자체가 던지는 경우(해석 가능한 크레덴셜이 하나도 없음)만 `credential_missing`이다.
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  let client = options.client;
  if (client === undefined) {
    try {
      client = (apiKey !== undefined && apiKey.length > 0 ? new Anthropic({ apiKey }) : new Anthropic())
        .messages;
    } catch {
      return { state: "unmeasured", value_tokens: null, reason: "credential_missing" };
    }
  }

  try {
    const result = await client.countTokens({
      model: tokenizerModel,
      messages: [{ role: "user", content: text }],
    });
    cache.set({ content_sha256: contentSha256, tokenizer_model: tokenizerModel }, result.input_tokens);
    return {
      state: "measured",
      value_tokens: result.input_tokens,
      tokenizer_model: tokenizerModel,
      measured_at: new Date().toISOString(),
    };
  } catch (err) {
    if (isCredentialAbsence(err)) {
      return { state: "unmeasured", value_tokens: null, reason: "credential_missing" };
    }
    return {
      state: "unmeasured",
      value_tokens: null,
      reason: "measurement_failed",
      failure_kind: classifyMeasurementFailure(err),
    };
  }
}

/** TLS 체인 검증 실패로 판정하는 OpenSSL 오류 코드 — Node가 번들 CA로 검증에 실패할 때 나온다. */
const TLS_CHAIN_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
]);

/** 연결 자체가 성립하지 않은 경우 — 오프라인·DNS 실패·방화벽. */
const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * 오류 객체의 `cause` 사슬을 끝까지 걸어 `code` 문자열을 모은다.
 *
 * ⚠️ **한 겹만 봐서는 못 잡는다.** 실측(2026-08-24): SDK가 던진 `APIConnectionError`의
 * `.message`는 `"Connection error."`, `.cause`는 `TypeError("fetch failed")`였고, 실제 원인
 * 코드(`SELF_SIGNED_CERT_IN_CHAIN`)는 **그 아래 한 겹 더**에 있었다. `err.cause.code`만
 * 확인하는 구현은 이 케이스를 조용히 `unclassified`로 떨어뜨린다.
 *
 * 순환 참조가 있어도 멈추도록 방문 집합과 깊이 상한을 둔다.
 */
function collectErrorCodes(err: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/**
 * `measurement_failed`의 원인을 분류한다(안전 원칙 6 — 진단 없는 fail-closed는 사용자를
 * 가드 우회로 몰아간다). **판정할 수 없으면 `unclassified`이며, 그럴듯한 분류를 만들지 않는다.**
 *
 * 반환값은 분류 열거값뿐이다 — 오류 원문은 URL·헤더 조각을 품을 수 있어 카탈로그에 넣지 않는다.
 */
export function classifyMeasurementFailure(err: unknown): OccupancyFailureKind {
  if (err instanceof Anthropic.RateLimitError) return "rate_limited";
  const codes = collectErrorCodes(err);
  if (codes.some((c) => TLS_CHAIN_ERROR_CODES.has(c))) return "tls_chain_untrusted";
  if (codes.some((c) => NETWORK_ERROR_CODES.has(c))) return "network_unreachable";
  if (err instanceof Anthropic.APIConnectionError) return "network_unreachable";
  if (err instanceof Anthropic.APIError) return "api_error";
  return "unclassified";
}

/**
 * 크레덴셜 부재와 그 밖의 측정 실패를 구분한다(안전 원칙 5 — 두 상태를 뭉개면 사용자가 무엇을
 * 고쳐야 하는지 알 수 없다: 전자는 "로그인해라", 후자는 "네트워크·레이트리밋을 봐라"다).
 *
 * ⚠️ **SDK는 크레덴셜 미해석을 타입으로 알려주지 않는다** — 실측 결과 `AuthenticationError`도
 * `AnthropicError`도 아닌 **평범한 `Error`**를 던지고, 구분 가능한 신호는 메시지 문자열뿐이다
 * ("Could not resolve authentication method. Expected one of apiKey, authToken, ..."). 문자열
 * 매칭은 SDK 버전이 오르면 깨지는 취약한 판정이므로, **깨지면 `measurement_failed`로 열화할 뿐
 * 잘못된 값을 만들지는 않는다**(안전한 방향의 실패). 401 응답은 `AuthenticationError`로 오므로
 * 그쪽은 타입으로 잡는다.
 */
function isCredentialAbsence(err: unknown): boolean {
  if (err instanceof Anthropic.AuthenticationError) return true;
  return err instanceof Error && /could not resolve authentication/i.test(err.message);
}

/** 측정 대상 텍스트가 없는 경우(예: cli 자산의 idle/loaded) — 호출 자체를 생략하는 지름길. */
export function notApplicableOccupancyValue(): OccupancyValue {
  return { state: "unmeasured", value_tokens: null, reason: "not_applicable" };
}

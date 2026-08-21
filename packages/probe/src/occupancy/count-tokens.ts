import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { OccupancyValue } from "@ctk/core";
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
 * **크레덴셜 감지는 `ANTHROPIC_API_KEY` 환경변수 존재 여부로만 판단한다.** OAuth/키체인 인증은
 * `claude` CLI 서브프로세스 전용이며(docs/harness-facts.md), `@anthropic-ai/sdk`는 그 인증을
 * 공유하지 않는다 — API 키가 따로 필요하다(이 환경엔 없다, §4 Step 3 지시사항과 일치).
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
    return {
      state: "unmeasured",
      value_tokens: null,
      reason: isCredentialAbsence(err) ? "credential_missing" : "measurement_failed",
    };
  }
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

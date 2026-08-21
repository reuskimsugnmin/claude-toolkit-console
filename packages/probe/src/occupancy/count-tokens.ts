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
 * 크레덴셜이 없으면 호출을 시도조차 하지 않고 `unmeasured(reason: credential_missing)`(AC-4.5 —
 * "크레덴셜 없는 환경에서 occupancy가 unmeasured로 표기되고 추정치가 들어가지 않는다").
 */
export async function countTokensMeasured(options: CountTokensOptions): Promise<OccupancyValue> {
  const { text, tokenizerModel, cache } = options;
  const contentSha256 = sha256(text);

  const cached = cache.get({ content_sha256: contentSha256, tokenizer_model: tokenizerModel });
  if (cached !== undefined) {
    return { state: "measured", value_tokens: cached, tokenizer_model: tokenizerModel, measured_at: new Date().toISOString() };
  }

  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    return { state: "unmeasured", value_tokens: null, reason: "credential_missing" };
  }

  const client = options.client ?? new Anthropic({ apiKey }).messages;
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
  } catch {
    return { state: "unmeasured", value_tokens: null, reason: "measurement_failed" };
  }
}

/** 측정 대상 텍스트가 없는 경우(예: cli 자산의 idle/loaded) — 호출 자체를 생략하는 지름길. */
export function notApplicableOccupancyValue(): OccupancyValue {
  return { state: "unmeasured", value_tokens: null, reason: "not_applicable" };
}

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { countTokensMeasured, notApplicableOccupancyValue, classifyMeasurementFailure } from "../src/occupancy/count-tokens.js";
import { createMapTokenCacheStore } from "../src/cache/cache-store.js";

function sha256Of(text: string): string {
  // count-tokens.ts와 동일한 해시 규약(sha256 hex, node:crypto)을 테스트에서 재현한다.
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("probe/occupancy/count-tokens — 3상태 실측(ADR-005, AC-4.5)", () => {
  /**
   * ⚠️ **이 테스트는 한때 환경을 단언하고 있었다(2026-08-24 정정).** 원래는 `apiKey: undefined`에
   * `client` 주입 없이 호출하고 "네트워크를 시도하지 않는다"고 주장했다 — 그러나 그 경로는 실제로
   * `new Anthropic()`을 만들어 SDK 전체 크레덴셜 체인에 위임한다. **실행 머신에 크레덴셜이 하나도
   * 없을 때만 우연히 통과**하던 테스트였고, `ant auth login` 프로파일이 생기자 같은 코드가
   * 1.7초짜리 실제 네트워크 호출로 바뀌면서 단언이 무너졌다.
   *
   * 이제 크레덴셜 미해석을 **주입으로 재현**한다 — 픽스처가 결과를 지배해야 통과가 코드에 대한
   * 진술이 된다.
   */
  it("SDK 체인이 크레덴셜을 하나도 해석하지 못하면 unmeasured(credential_missing)로 남고 캐시를 더럽히지 않는다", async () => {
    const cache = createMapTokenCacheStore();
    const unresolvableClient = {
      countTokens: async () => {
        // SDK가 실제로 던지는 형태 — 전용 에러 타입이 아니라 평범한 Error에 이 문구가 실린다.
        throw new Error(
          "Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.",
        );
      },
    };
    const result = await countTokensMeasured({
      text: "hello world",
      tokenizerModel: "claude-demo",
      cache,
      apiKey: undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: unresolvableClient as any,
    });
    expect(result).toEqual({ state: "unmeasured", value_tokens: null, reason: "credential_missing" });
    // credential_missing에는 failure_kind를 달지 않는다 — 사유 자체가 원인이다.
    expect("failure_kind" in result).toBe(false);
    expect(cache.dirty.size).toBe(0);
  });

  it("캐시 히트면 크레덴셜 없이도 measured를 반환한다(네트워크 호출 불필요)", async () => {
    const cache = createMapTokenCacheStore(new Map([[`${sha256Of("hello world")} claude-demo`, 7]]));
    const result = await countTokensMeasured({ text: "hello world", tokenizerModel: "claude-demo", cache, apiKey: undefined });
    expect(result.state).toBe("measured");
    if (result.state === "measured") {
      expect(result.value_tokens).toBe(7);
      expect(result.tokenizer_model).toBe("claude-demo");
    }
  });

  it("크레덴셜이 있고 캐시 미스면 주입된 client.countTokens를 호출하고 결과를 캐시에 쓴다(모킹 — 실제 네트워크 없음)", async () => {
    const cache = createMapTokenCacheStore();
    let calledWith: unknown = null;
    const fakeClient = {
      countTokens: async (params: unknown) => {
        calledWith = params;
        return { input_tokens: 123 };
      },
    };
    const result = await countTokensMeasured({
      text: "measure me",
      tokenizerModel: "claude-demo",
      cache,
      apiKey: "fake-key-for-test",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: fakeClient as any,
    });
    expect(result).toMatchObject({ state: "measured", value_tokens: 123, tokenizer_model: "claude-demo" });
    expect(calledWith).toMatchObject({ model: "claude-demo" });
    expect(cache.dirty.size).toBe(1);
  });

  it("client.countTokens가 실패하면 unmeasured(measurement_failed)로 열화한다(추정치를 채우지 않는다)", async () => {
    const cache = createMapTokenCacheStore();
    const failingClient = {
      countTokens: async () => {
        throw new Error("network down");
      },
    };
    const result = await countTokensMeasured({
      text: "x",
      tokenizerModel: "claude-demo",
      cache,
      apiKey: "fake-key-for-test",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: failingClient as any,
    });
    // 분류 단서가 없는 오류다 — 그럴듯한 분류를 지어내지 않고 unclassified로 남긴다(안전 원칙 7).
    expect(result).toEqual({
      state: "unmeasured",
      value_tokens: null,
      reason: "measurement_failed",
      failure_kind: "unclassified",
    });
  });

  it("notApplicableOccupancyValue — 측정 대상이 없는 경우의 지름길", () => {
    expect(notApplicableOccupancyValue()).toEqual({ state: "unmeasured", value_tokens: null, reason: "not_applicable" });
  });
});

describe("classifyMeasurementFailure — measurement_failed 원인 분류 (안전 원칙 6: 진단)", () => {
  /**
   * ⚠️ **한 겹만 보면 놓친다.** 2026-08-24 실측에서 SDK가 던진 오류의 형태는 정확히 이랬다 —
   * `APIConnectionError("Connection error.")` → `.cause = TypeError("fetch failed")` →
   * `.cause.cause.code = "SELF_SIGNED_CERT_IN_CHAIN"`. `err.cause.code`만 확인하는 구현은
   * 이 픽스처에서 `unclassified`를 돌려주므로 이 테스트가 그 구현을 걸러낸다.
   */
  function nestedTlsError(): Error {
    const root = Object.assign(new Error("self signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    const fetchFailed = new TypeError("fetch failed", { cause: root });
    return new Error("Connection error.", { cause: fetchFailed });
  }

  it("중첩된 cause 사슬 아래의 TLS 코드를 찾아낸다", () => {
    expect(classifyMeasurementFailure(nestedTlsError())).toBe("tls_chain_untrusted");
  });

  it("cause 한 겹만 있는 네트워크 오류를 분류한다", () => {
    const err = new Error("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
    expect(classifyMeasurementFailure(err)).toBe("network_unreachable");
  });

  it("분류할 수 없으면 그럴듯한 값을 지어내지 않고 unclassified로 남긴다(안전 원칙 7)", () => {
    expect(classifyMeasurementFailure(new Error("뭔가 잘못됐다"))).toBe("unclassified");
    expect(classifyMeasurementFailure("문자열 throw")).toBe("unclassified");
  });

  it("cause가 순환 참조여도 멈춘다", () => {
    const a: { cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    expect(classifyMeasurementFailure(a)).toBe("unclassified");
  });
});

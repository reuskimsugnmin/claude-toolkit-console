import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { countTokensMeasured, notApplicableOccupancyValue } from "../src/occupancy/count-tokens.js";
import { createMapTokenCacheStore } from "../src/cache/cache-store.js";

function sha256Of(text: string): string {
  // count-tokens.ts와 동일한 해시 규약(sha256 hex, node:crypto)을 테스트에서 재현한다.
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("probe/occupancy/count-tokens — 3상태 실측(ADR-005, AC-4.5)", () => {
  it("크레덴셜(apiKey)이 없으면 네트워크를 시도하지 않고 unmeasured(credential_missing)를 반환한다", async () => {
    const cache = createMapTokenCacheStore();
    const result = await countTokensMeasured({
      text: "hello world",
      tokenizerModel: "claude-demo",
      cache,
      apiKey: undefined,
    });
    expect(result).toEqual({ state: "unmeasured", value_tokens: null, reason: "credential_missing" });
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
    expect(result).toEqual({ state: "unmeasured", value_tokens: null, reason: "measurement_failed" });
  });

  it("notApplicableOccupancyValue — 측정 대상이 없는 경우의 지름길", () => {
    expect(notApplicableOccupancyValue()).toEqual({ state: "unmeasured", value_tokens: null, reason: "not_applicable" });
  });
});

import { describe, expect, it } from "vitest";
import { verdictPreflightVersion } from "../src/guard/preflight-version.js";

describe("core/guard/preflight-version — iter 8 · B5 (순수 함수)", () => {
  it("검증 버전과 실제 버전이 같으면 허용한다", () => {
    const verdict = verdictPreflightVersion("2.1.238", "2.1.238", false);
    expect(verdict).toEqual({ match: "match", allowed: true });
  });

  it("버전이 다르지만 라우팅 신호가 재현되면 허용한다", () => {
    const verdict = verdictPreflightVersion("2.1.237", "2.1.238", true);
    expect(verdict).toEqual({ match: "mismatch_routing_reproduced", allowed: true });
  });

  it("버전이 다르고 라우팅 신호 재현도 실패하면 거부한다 (seal_unverified_cli)", () => {
    const verdict = verdictPreflightVersion("2.1.237", "2.1.238", false);
    expect(verdict).toEqual({ match: "mismatch_rejected", allowed: false });
  });

  it("경고가 아니라 거부다 — allowed:false는 예외 없이 spawn을 막아야 한다", () => {
    const verdict = verdictPreflightVersion("1.0.0", "9.9.9", false);
    expect(verdict.allowed).toBe(false);
  });
});

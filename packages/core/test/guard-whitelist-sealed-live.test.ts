import { describe, expect, it } from "vitest";
import { matchesAllowlist } from "../src/guard/whitelist.js";
import {
  SEALED_LIVE_CLAUDE_JSON_ALLOWED_CHURN_KEYS,
  TIER2_CHURN_ALLOWLIST,
  TIER2_CHURN_ALLOWLIST_SEALED_LIVE,
} from "../src/guard/whitelist.js";
import { claudeJsonSemanticVerdict } from "../src/guard/claude-json-semantic.js";

describe("core/guard/whitelist — TIER2_CHURN_ALLOWLIST_SEALED_LIVE (iter 8 · B3, AC-0.11 실측)", () => {
  it("AC-0.11이 실측한 세 종류(.claude.json · sessions/<pid>.json · sessions/<pid>.<hash>.key)는 허용된다", () => {
    expect(matchesAllowlist(".claude.json", TIER2_CHURN_ALLOWLIST_SEALED_LIVE)).toBeDefined();
    expect(matchesAllowlist("sessions/12345.json", TIER2_CHURN_ALLOWLIST_SEALED_LIVE)).toBeDefined();
    expect(matchesAllowlist("sessions/12345.abcdef01.key", TIER2_CHURN_ALLOWLIST_SEALED_LIVE)).toBeDefined();
  });

  it("--no-session-persistence로 사라지는 projects/ churn은 이 목록에 없다 — 실제로 안 나타날 churn을 미리 허용하지 않는다", () => {
    expect(matchesAllowlist("projects/-Users-x-proj/session.jsonl", TIER2_CHURN_ALLOWLIST_SEALED_LIVE)).toBeUndefined();
  });

  it("AC-0.8(격리 홈 · plugin 명령) 전용 목록을 전용하지 않는다 — 두 목록은 별개 배열이다", () => {
    expect(TIER2_CHURN_ALLOWLIST_SEALED_LIVE).not.toBe(TIER2_CHURN_ALLOWLIST);
  });

  it("무관한 경로(CLAUDE.md 등)는 여전히 위반이다", () => {
    expect(matchesAllowlist("CLAUDE.md", TIER2_CHURN_ALLOWLIST_SEALED_LIVE)).toBeUndefined();
  });

  it(".claude.json 의미 diff는 cachedGrowthBookFeaturesAt 한 키만 허용한다(AC-0.11 실측)", () => {
    const before = { cachedGrowthBookFeaturesAt: 1, projects: { "/x": { mcpServers: {} } } };
    const after = { cachedGrowthBookFeaturesAt: 2, projects: { "/x": { mcpServers: {} } } };
    const verdict = claudeJsonSemanticVerdict(before, after, SEALED_LIVE_CLAUDE_JSON_ALLOWED_CHURN_KEYS);
    expect(verdict.overallStatus).toBe("allowed_churn");
  });

  it("허용 키 밖의 최상위 키가 바뀌면 위반이다 — sealed-live에서도 화이트리스트 방향을 유지한다", () => {
    const before = { cachedGrowthBookFeaturesAt: 1, numStartups: 5 };
    const after = { cachedGrowthBookFeaturesAt: 1, numStartups: 6 };
    const verdict = claudeJsonSemanticVerdict(before, after, SEALED_LIVE_CLAUDE_JSON_ALLOWED_CHURN_KEYS);
    expect(verdict.overallStatus).toBe("violation");
  });
});

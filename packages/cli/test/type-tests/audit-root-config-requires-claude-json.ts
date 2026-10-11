// 컴파일 전용 테스트 — 실행되지 않는다. `allowTier2Churn: true`(config 루트)인데 `claudeJsonAbs`가
// 없으면 컴파일 오류여야 한다(L3: 경로 누락이 런타임 가드가 아니라 타입에서 막힌다).
import type { AuditRootConfig } from "@ctk/actuator";

// @ts-expect-error claudeJsonAbs 없이 Tier-2 churn을 열 수 없다
export const missing: AuditRootConfig = { rootAbs: "/x", tier1: [], allowTier2Churn: true };

export const ok: AuditRootConfig = { rootAbs: "/x", tier1: [], allowTier2Churn: true, claudeJsonAbs: "/x/.claude.json" };
export const project: AuditRootConfig = { rootAbs: "/x", tier1: [], allowTier2Churn: false };

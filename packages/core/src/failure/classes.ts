import { z } from "zod";

/**
 * failure_class 열거값 (§7 관측 가능성). run-log.ts가 참조한다.
 * 각 값은 계획서에서 구체적으로 정의된 실패 모드에 대응한다 — 새 실패 모드가 생기면
 * 여기 먼저 추가하고 조용히 "unclassified"로 뭉개지 않는다.
 */
export const FAILURE_CLASSES = [
  "isolation_violation", // test-isolated 프로파일 격리 판정 실패 (부록 항목 1)
  "seal_profile_missing", // spawnClaude() profile 인자 누락
  "credential_missing", // --no-credentials-ok 없이 크레덴셜 부재 (AC-4.5)
  "budget_exceeded", // --max-budget-usd 초과, gen --resume 대상
  "remote_catalog_unsupported", // ctk init에 원격 URL (OQ-1 안 C)
  "mcp_state_unverified", // enabledMcpjsonServers/disabledMcpjsonServers 판정불가 (AC-0.4ⓑ③)
  "tmp_leftover", // Tier-2 tmp 파일이 종료 후에도 잔존 (착수 조건 C3)
  "subagent_attribution_unresolved", // isSidechain:true 0건인데 Agent tool_use 존재 (R17)
  "managed_policy_present", // Admin/policy(managed) 설정 존재 — sealed-live 봉인 불완전 가능성 (R15)
  "duplicate_path_input", // tree-diff verdict()에 동일 경로가 2회 이상 입력됨 — 수집 버그 신호 (P2, test-engineer 발견)
  "unclassified",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const FailureClassSchema = z.enum(FAILURE_CLASSES);

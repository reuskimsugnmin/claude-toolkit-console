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
  "duplicate_snapshot_key", // diffById()에 동일 (asset_id, install_scope, project_path_hash) 키가 2회 이상 입력됨 (P2, test-engineer 발견 — Step 2 실환경 검증에서 collectSkills 프론트매터 name 충돌로 재현)
  "parse_schema_mismatch", // 하네스 출력이 zod strict 스키마와 불일치 (R13) — Step 2
  "lock_contended", // 다른 ctk 실행이 <catalog>/.ctk.lock을 보유 중 (§7.4) — Step 2
  "path_normalize_failed", // 경로를 ~/… 상대화도 path_hash도 할 수 없어 기록 불가 (F4) — Step 2
  "seal_env_leak", // 허용목록 밖 환경변수가 자식 프로세스에 도달함 (iter 8 · B2) — Step 2
  "seal_timeout", // 서브프로세스가 --timeout-sec 벽시계를 초과 (iter 8 · M4) — Step 2
  "whitelist_violation", // ctk가 쓰지 않은 경로가 churn 허용목록 밖에서 변경됨 (AC-2.7) — Step 5
  "forbidden_path_write", // 금지 목록 경로(CLAUDE.md·installed_plugins.json·MCP 서브트리 등) 변경 — 최우선 경보 (AC-2.7-c) — Step 5
  "verify_mismatch", // 조치 후 probe 재실측이 기대와 다름 — 자동 롤백 (AC-2.6) — Step 5
  "rollback_failed", // 롤백 자체가 실패 — 최악, 백업 경로 그대로 출력 + 수동 복구 절차 안내 — Step 5
  "unclassified",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const FailureClassSchema = z.enum(FAILURE_CLASSES);

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
  "duplicate_asset_id", // cli/commands/scan.ts의 mergeAssets()에 동일 Asset.id가 2회 이상 입력됨 — B1 Step 3(AC-2). 이전에는 first-wins로 조용히 삼켰다(diffById와 같은 결함 모양)
  "parse_schema_mismatch", // 하네스 출력이 zod strict 스키마와 불일치 (R13) — Step 2
  "lock_contended", // 다른 ctk 실행이 <catalog>/.ctk.lock을 보유 중 (§7.4) — Step 2
  "path_normalize_failed", // 경로를 ~/… 상대화도 path_hash도 할 수 없어 기록 불가 (F4) — Step 2
  "seal_env_leak", // 허용목록 밖 환경변수가 자식 프로세스에 도달함 (iter 8 · B2) — Step 2
  "seal_timeout", // 서브프로세스가 --timeout-sec 벽시계를 초과 (iter 8 · M4) — Step 2
  "seal_tools_not_empty", // sealed-live argv에 --tools ""가 없거나 도구가 활성 (iter 8 · B4) — Step 4
  "seal_unverified_cli", // spawn 직전 claude --version이 검증 버전과 다르고 0원 라우팅 신호 재현도 실패 (iter 8 · B5) — Step 4
  "seal_cwd_ancestor_config", // agent-probe cwd 상위에 CLAUDE.md/.claude/가 존재 (iter 8 · M2) — Step 4
  "injection_pattern_detected", // gen 산출물 후검증 4규칙 위반 — sync 쓰기 이전에 거부 (iter 8 · B1-3 · R18) — Step 4
  "managed_policy_blocked", // managed 정책에 위험 키가 있는데 비대화형 실행이고 --allow-managed-policy 미지정 (iter 8 · M1) — Step 4
  "whitelist_violation", // ctk가 쓰지 않은 경로가 churn 허용목록 밖에서 변경됨 (AC-2.7) — Step 5
  "forbidden_path_write", // 금지 목록 경로(CLAUDE.md·installed_plugins.json·MCP 서브트리 등) 변경 — 최우선 경보 (AC-2.7-c) — Step 5
  "verify_mismatch", // 조치 후 probe 재실측이 기대와 다름 — 자동 롤백 (AC-2.6) — Step 5
  "rollback_failed", // 롤백 자체가 실패 — 최악, 백업 경로 그대로 출력 + 수동 복구 절차 안내 — Step 5
  "path_traversal_detected", // 외부 입력 유래 문자열(자산 id·이름 등)에 ../ 등이 존재 — 공격 시도, path_normalize_failed와 분리(H2) — Step 5 e2e에서 실제로 재현(악성 SKILL.md frontmatter name)
  "backup_manifest_tampered", // 롤백 시 manifest.json의 실측 sha256이 journal에 기록된 값과 다르다 — 백업 저장소 자체가 변조됐을 가능성(H2/AC-2.13) — Step 5 보안 심사 수정
  "config_clobbered", // 백업~롤백 사이 사용자가 대상 파일을 별도로 바꿔 lost update 위험(M8) — 복원 직전 재확인 — Step 5 보안 심사 수정
  "skill_location_ambiguous", // 스킬 자산 id(frontmatter name)에 대응하는 실제 디렉터리가 0개 또는 2개 이상(H6) — Step 5 보안 심사 수정

  // ── B1 보안 심사 L-D(2026-08-28) — **던져지고 있었는데 등재만 빠져 있던 6건.**
  // 심사가 지적한 것은 `asset_source_not_a_file` 하나였지만 세어 보니 여섯이었다(범위로 닫는다).
  // 미등재의 대가는 "기록 안 됨"이 아니라 **오분류**다 — `extractFailureClass`(cli/scan.ts ·
  // move.ts · rollback.ts)가 `FAILURE_CLASS_SET.has()`로 거르므로 미등재 클래스를 던지면
  // run-log의 `failure_class`가 조용히 `null`이 된다. **"실패"가 "분류 없음"으로 삼켜졌다**
  // (안전 원칙 7). 등재가 곧 배선인 자리다.
  "asset_source_missing", // gen 위생: existsSync 확인과 읽기 사이에 원문이 사라졌다(경합·마운트 변경·깨진 링크)
  "asset_source_too_large", // gen 위생: 자산 원문이 DEFAULT_MAX_ASSET_SOURCE_BYTES(200KB) 초과
  "asset_source_not_a_file", // gen 위생: 자산 원문 경로가 FIFO·소켓·디바이스 — 열면 영구 블록된다(M-1, EXIT=124로 실증)
  "dirty_catalog_repo", // sync: 구 레이아웃 경로 이전 직전 카탈로그 저장소에 커밋되지 않은 변경이 있다
  "project_list_changed", // actuator/move: 조치 도중 known projects 목록이 바뀌어 검증 모집단이 흔들렸다
  "skill_source_not_found", // cli/verify-ac3: AC-3 게이트가 대조할 스킬 원문을 찾지 못했다 — 미측정이지 통과가 아니다

  // B1 보안 심사 M-B(2026-08-28) — installed_plugins.json의 installPath가 절대경로가 아니거나
  // realpath 해소 후 <config>/plugins 밖을 가리킨다. **"없음"과 다른 축이다** — 부재는 드리프트
  // 조사이고 이것은 설정 파일 오염 신호다(gen이 임의 경로 README를 카탈로그로 내보낼 수 있었다).
  "install_path_rejected",

  // ── B4-c(2026-08-31) — `ctk workflow-doc`. **등재가 곧 배선이다**(L-D의 교훈): 미등재
  // 클래스를 던지면 `extractFailureClass`가 `FAILURE_CLASS_SET.has()`로 걸러 run-log의
  // `failure_class`가 조용히 `null`이 된다 — "실패"가 "분류 없음"으로 삼켜진다.
  "workflow_doc_parse_failed", // 생성 구간에서 표 행을 0개 찾았거나 행 구조가 전제 가드를 벗어났다 — "0건 일치"로 삼키지 않는다
  "workflow_doc_marker_absent", // :start 또는 :end 마커가 없다
  "workflow_doc_marker_duplicated", // 마커가 2회 이상 나온다 — 조용히 첫 것을 고르지 않는다
  "workflow_doc_marker_out_of_order", // :end가 :start보다 앞에 있다
  "workflow_doc_whitelist_overflow", // 표에서 뽑은 자산 참조 수가 상한을 넘었다 — 동적 화이트리스트의 상한(D-9)
  "workflow_doc_leak_detected", // 자산 설명 원문 또는 산출물에 개인 환경 데이터가 있어 차단했다 — 표 파싱 오류로 오분류하지 않는다(보안 심사 M-3)
  "workflow_doc_path_rejected", // 문서 경로가 저장소 앵커 밖이거나 심볼릭 링크다 — **경로 통제**이지 파싱이 아니다(재심 경미 7)
  "unclassified",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const FailureClassSchema = z.enum(FAILURE_CLASSES);

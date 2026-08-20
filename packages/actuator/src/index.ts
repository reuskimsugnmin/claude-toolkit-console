// @ctk/actuator — 로컬 설정 쓰기 전용, 위험도 높음 (CLAUDE.md 안전 원칙: 백업→수정→검증→롤백).
// Step 5에서 채운다. security-reviewer 승인 없이 완료 불가.
//
// 예정 구조 (plan §4.1):
//   src/guard/atomic-write.ts   temp write → fsync → rename + 재파싱 (쓰기 책임만 — 판정은 core)
//   src/backup.ts
//   src/apply/{plugin-enablement,skill-dir}.ts
//   src/audit.ts                probe/tree-collect 수집 → core/guard 판정 호출 → 결과 해석
//   src/verify.ts               probe 재실행으로 실측 검증
//   src/rollback.ts
//   src/journal.ts              ★ 레코드를 반환만 한다. 저장소 쓰기 없음 (P1-5)
//
// 계층 lint가 core/guard의 판정 로직 재구현(tree-diff/whitelist/forbidden 파일명 재등장)을
// 이미 차단한다(ctk/no-guard-duplication).

export const ACTUATOR_PACKAGE_PLACEHOLDER = true;

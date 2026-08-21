// @ctk/actuator — 로컬 설정 쓰기 전용, 위험도 높음 (CLAUDE.md 안전 원칙: 백업→수정→검증→롤백).
// Step 5(§4 plan). security-reviewer 승인 없이 완료 불가.
//
// 판정 로직은 core/guard/*를 그대로 쓴다(H1) — 이 패키지는 쓰기 책임(temp write·백업·적용·
// 실측 검증·롤백)만 진다. `ctk move`/`ctk rollback`의 오케스트레이션(백업→적용→감사→검증→
// 실패 시 롤백 순서 배선, journal append)은 `cli/src/commands/{move,rollback}.ts`가 한다 —
// cli가 probe·sync·actuator를 조합하는 계층이라는 기존 경계(scan.ts와 동형)를 그대로 따른다.

export * from "./guard/atomic-write.js";
export * from "./backup.js";
export * from "./apply/plugin-enablement.js";
export * from "./apply/skill-dir.js";
export * from "./apply/mcp-reject.js";
export * from "./audit.js";
export * from "./verify.js";
export * from "./rollback.js";
export * from "./journal.js";

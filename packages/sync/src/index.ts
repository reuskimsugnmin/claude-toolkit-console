// @ctk/sync — 어댑터 · 카탈로그 저장소 쓰기의 유일한 주체 (CLAUDE.md 계층 경계).
// v1 = local-git-repo 어댑터만 (OQ-1 안 C — 로컬 전용, push/pull 미구현).
//
// 예정 구조 (plan §4.1):
//   src/adapter.ts               sync 어댑터 경계 (나중에 Supabase 어댑터 추가 시 이 인터페이스로 이행)
//   src/local-git-repo.ts
//   src/{snapshot,journal,run-log,token-cache,offset-cache}-store.ts
//   src/lock.ts                  <catalog>/.ctk.lock 동시 실행 가드 (§7.4)

export const SYNC_PACKAGE_PLACEHOLDER = true;

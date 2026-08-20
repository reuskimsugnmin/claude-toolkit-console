// @ctk/probe — 로컬 설정 읽기 전용 (CLAUDE.md 계층 경계). Step 2에서 채운다.
//
// 예정 구조 (plan §4.1):
//   src/home.ts                  CTK_HOME / CTK_CONFIG_DIR 단일 관문
//   src/harness/spawn-claude.ts  claude 단일 래퍼 (profile 인자 필수: test-isolated | sealed-live)
//   src/harness/seal-profiles.ts 두 프로파일의 인자·env 조합
//   src/tree-collect.ts          config 트리 수집(I/O) — 판정은 core/guard에 위임
//   src/sources/{settings,plugins,skills,mcp,cli-path}.ts
//   src/transcripts/{iterate,extract}.ts
//   src/occupancy/count-tokens.ts
//   src/cache/cache-store.ts     인터페이스만 (구현·쓰기는 cli/sync)
//
// 계층 lint(eslint.config.js)가 이미 이 패키지의 경계를 강제한다 — core만 import 가능,
// fs 쓰기 계열 호출 금지, child_process 직접 사용 금지(harness/spawn-claude.ts만 예외).

export const PROBE_PACKAGE_PLACEHOLDER = true;

// @ctk/gen — AI 문서 생성, 위험도 중간(비용)·파괴도는 봉인 전제 하 낮음 (결정 4).
// Step 4에서 채운다. security-reviewer 필수 게이트 (P0-5 — claude -p 서브프로세스 봉인).
//
// gen은 카탈로그 저장소 외 어떤 경로에도 직접 쓰지 않는다 — 쓰기는 전부 @ctk/sync에 위임한다
// (계층 lint가 fs 쓰기 계열 호출을 이미 차단한다). 봉인 프로파일은 test-isolated | sealed-live
// 둘뿐이며 --bare는 전 경로에서 폐기됐다(Step 0 실측, AC-0.10ⓑ).
//
// 예정 구조 (plan §4.1):
//   src/{plan,estimate,run-claude-p,extract-frontmatter,citation-check,agent-probe}.ts
//   src/rule-extract.ts   --no-llm 폴백 계층 (frontmatter·README 헤딩·plugin.json)

export const GEN_PACKAGE_PLACEHOLDER = true;

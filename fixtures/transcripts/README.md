# 합성 트랜스크립트 픽스처

Step 1 산출물 (plan §4.1 `fixtures/` 목록). 전부 익명 합성 데이터 — 실제 세션 내용이 아니다.
행 구조·필드는 `spikes/results/AC-0.6a.md` / `AC-0.6b.md` 실측값(CLI 2.1.237, 2026-08-20)과
일치시켰다(F2 — 불일치를 검출하는 단언은 `packages/core/test/harness-schema.test.ts` 참조).

`attribution*`(attributionSkill/attributionPlugin/attributionMcpServer/attributionMcpTool)
필드의 존재/부재를 3가지 원인으로 나눠 표시한다(H2, AC-0.6a 폴백 값 `attribution_cause`):

| 파일 | attribution_cause | 시나리오 |
|---|---|---|
| `attribution-present.jsonl` | (해당 없음 — 있음) | tool_use에 `attributionSkill`/`attributionPlugin`이 실려 있다 |
| `attribution-absent-harness_version.jsonl` | `harness_version` | tool_use는 있지만 이 하네스 버전이 attribution* 필드 자체를 기록하지 않는다 |
| `attribution-absent-session_option_bare.jsonl` | `session_option_bare` | `--bare` 세션이라 애초에 tool_use가 없다(스킬/플러그인 무력화 — AC-0.10ⓑ) |
| `attribution-absent-unverified.jsonl` | `unverified` | tool_use는 있으나 attribution* 부재의 원인을 이 표본만으로 판정할 수 없다(AC-0.6a 폴백) |

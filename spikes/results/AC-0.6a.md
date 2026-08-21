# AC-0.6a 결과 — `attribution*` 필드 부재의 원인 (`--bare` 유/무 대조)

**성격: 정보.** 착수를 막지 않으며, 폴백 값을 기재하고 Step 3에서 해소한다.

## 시도한 것과 막힌 것

계획된 절차는 "동일 프롬프트를 `--bare` 있는 세션 / 없는 세션 각 1회씩 돌려 트랜스크립트의
`attribution*` 존재율을 대조"였다. 실제로 시도한 결과:

1. **`--bare` 세션 자체가 이 환경에서 실행 불가** — AC-0.10ⓒ에서 확정한 그대로,
   `--bare`는 `ANTHROPIC_API_KEY`/`apiKeyHelper`를 요구하는데 이 환경엔 둘 다 없다.
   따라서 "`--bare` 있음" 쪽 절반이 원천적으로 측정 불가능하다.
2. **"`--bare` 없음" 쪽은 실측했다** (real HOME, 실제 인증 사용 — 비용 실지출 $0.0479,
   session_id `6b712191-…`, 트랜스크립트를 직접 열어 확인):
   ```
   $ echo "Reply with exactly the word PONG and nothing else." \
       | claude -p --max-budget-usd 0.05 --output-format json --disallowedTools "*"
   ```
   결과 트랜스크립트의 모든 행(`queue-operation`·`attachment`·`user`·`assistant`·`atis-latch`·
   `last-prompt`)을 순회해 `attribution*`로 시작하는 키를 찾았으나 **0건**이었다.

## 왜 이 결과가 결론으로 쓰기엔 불충분한가

이 테스트 프롬프트는 **어떤 스킬·플러그인·MCP 툴도 호출하지 않았다**(`--disallowedTools "*"`로
막아뒀고, 애초에 "PONG이라고만 답하라"는 프롬프트라 툴 호출 유인도 없었다). `attribution*` 필드는
plan §3 AC-4 귀속 규칙 ①에 따르면 **tool_use 행에 실리는 값**으로 추정되므로, 애초에 tool_use가
하나도 없는 이 트랜스크립트에 필드가 없는 것은 "부재의 원인이 하네스 버전/세션 옵션이다"를
증명하지 못한다 — **"애초에 실릴 자리가 없었다"는 세 번째 설명과 구분이 안 된다.**

## 판정: **폴백 적용** — `attribution_cause: "unverified"`

- 절반(`--bare` 있음)은 이 환경에서 API 키 없이는 원천적으로 측정 불가.
- 나머지 절반(`--bare` 없음)도 이번 시도의 프롬프트 설계가 부적절해(tool_use 无) 결론에 못 미친다.
- **폴백대로 진행한다:** `attribution_cause = "unverified"`로 파일 단위 기록, 귀속은 `prefix_rule`로.
- **해소는 Step 3 내 작업** (plan 지정대로). 재시도 시 필요 조건: ① API 키 보유 환경(또는
  `--bare` 실행 가능 환경) ② 프롬프트가 최소 1개의 스킬/플러그인/MCP tool_use를 확실히
  유발하도록 설계(예: 합성 플러그인의 `/synth:synth-probe`를 **인증되는 환경에서** 실제로
  실행해 그 tool_use 행의 attribution 필드 유무를 본다).

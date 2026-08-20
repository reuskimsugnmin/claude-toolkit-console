# AC-0.7 결과 — MCP/hooks가 세션 초기 컨텍스트를 실제로 점유하는가

**성격: 정보.** 착수를 막지 않으며, 폴백 값을 기재하고 Step 3에서 해소한다.

## 시도한 것

3구성 대조(ⓐ MCP 0/hooks 0 · ⓑ MCP 1 · ⓒ hook 1)를 **실제(비격리) 환경에서, 영속 파일은 전혀
건드리지 않는 세션 한정 플래그만으로** 시도했다(`--mcp-config`/`--strict-mcp-config`로 세션
한정 MCP 서버 주입, 실제 `~/.claude`는 무수정) — 격리 홈에서는 AC-0.10ⓒ가 확정한 대로 인증
자체가 안 되므로 이 경로만 남는다.

```
$ echo "Reply with exactly the word PONG and nothing else." \
    | claude -p --max-budget-usd 0.1 --output-format json --disallowedTools "*" --strict-mcp-config
  → usage.cache_creation_input_tokens = 6585   (콜드 캐시 — 이번 세션이 최초로 캐싱한 토큰 수)

$ echo "Reply with exactly the word PONG and nothing else." \
    | claude -p --max-budget-usd 0.1 --output-format json --disallowedTools "*" \
      --strict-mcp-config --mcp-config '{"mcpServers":{"ctk-spike-mcp":{"command":"true","args":[]}}}'
  → usage.cache_read_input_tokens = 6585, cache_creation_input_tokens = 0   (콘텍스트 캐시 재사용)
```

## 방법론적 발견 (부수 성과)

**`message.usage.input_tokens`는 세션 초기 컨텍스트 크기의 대리값으로 쓰기에 부적절하다** —
두 구성 모두 `input_tokens = 2`로 동일했다(사용자 턴 자체의 토큰 수일 뿐). **실제로 세션
초기(시스템 프롬프트+툴 정의) 크기를 반영하는 값은 `cache_creation_input_tokens`
(콜드/최초 캐싱 시) 또는 그 캐시를 재사용한 `cache_read_input_tokens`다.** plan §3 AC-0.7의
절차 서술("input_tokens 대조")은 **이 필드명으로는 실제로 아무것도 구분하지 못한다** —
**Step 3 구현 시 `cache_creation_input_tokens`/`cache_read_input_tokens` 합으로 대체해야 한다**
(설계 정정 필요 항목).

## 왜 결론에 못 미치는가

`--mcp-config '{"mcpServers":{"ctk-spike-mcp":{"command":"true","args":[]}}}'`의 `command: "true"`는
**유효한 MCP stdio 서버가 아니다**(핸드셰이크 없이 즉시 종료) — 그래서 두 세션의 캐시 크기가
정확히 같았다(6585 그대로 재사용). 이것은 "MCP가 idle을 점유하지 않는다"는 증거가 아니라
**"애초에 등록에 실패한 MCP 서버는 당연히 점유하지 않는다"는 무의미한 결과다.** 실제 핸드셰이크에
응답하는 최소 stdio MCP 서버(예: 1개 툴만 advertise하는 수십 줄짜리 Node 스크립트)를 만들어
재시도해야 유효한 측정이 된다 — 이번 스파이크에서는 시간 예산상 만들지 않았다.

hook(ⓒ) 구성은 이번 라운드에서 아예 시도하지 못했다(MCP 결과가 무효라는 걸 확인한 시점에
예산을 정보 항목에 더 쓰지 않기로 판단).

## 판정: **폴백 적용, 사유 명시(직행 아님)**

절차를 시도했으나(사유 없는 직행이 아님) 유효한 MCP 서버 스텁 부재로 결론에 이르지 못했다.
plan이 지정한 대로 폴백:

- **`idle_definition = "harness-parity"`로 확정** — 하네스 자체가 `plugin details` 출력에서
  MCP를 "tool schemas resolved at runtime; not counted", hooks를 "harness-only — no model
  context cost"로 이미 명시하고 있고(AC-0.5에서 재확인 완료 — plan 인용과 정확히 일치),
  이번 스파이크가 그 판정을 반증할 유효한 반대 증거를 만들지 못했다. P6(하네스가 답을 주면
  받아쓴다)에 따라 하네스 판정을 그대로 채택한다.
- **해소는 Step 3 내 작업.** 재시도 시 필요 조건: 실제 handshake에 응답하는 최소 MCP stdio
  서버 스텁 + `cache_creation_input_tokens`/`cache_read_input_tokens` 기준 비교로 절차 갱신.

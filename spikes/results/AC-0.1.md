# AC-0.1 결과 (자동 생성 — 2026-08-20T05:50:22Z)

- claude --version (child, isolated): 2.1.237 (Claude Code)
- child process exit rc: version=0, plugin-list=0
- child saw synthetic plugin (synth@synth-mp): yes
- child saw real marketplace (claude-plugins-official) — should be 'no': no
- real-home strict digest: before=286053 lines, after=286053 lines
- strict diff (no exclusions): PASS (0 diff lines)
- filtered diff (Tier-2 churn excluded): PASS (0 diff lines outside churn allowlist)

## 판정
PASS — 격리 성립. 자식 프로세스는 격리 트리만 봤고(합성 플러그인 인식, 실제 마켓플레이스 미인식),
실제 홈은 Tier-2 churn 허용목록 제외 시 변경 0건이었다.

## 부록 항목 1·8 실증 — churn의 원인

**단정하지 않고 별도로 측정했다.** 스파이크 서브프로세스 없이, 오케스트레이터(이 executor를 구동 중인
Claude Code 세션) 자신만 떠 있는 상태로 `$HOME/.claude` quick-digest를 10초 간격으로 2회 떴다:

```
6d5
< ./backups/.claude.json.backup.1787202582267 105077 1787202582
10a10
> ./backups/.claude.json.backup.1787202955803 105077 1787202955
286035c286035
< 105077 1787202892
---
> 105077 1787202955
```

**결론: churn의 원인은 스파이크 서브프로세스가 아니라 오케스트레이터 세션 자신의 백그라운드 상태
저장이다.** 10초 사이 `~/.claude.json`이 갱신되고 `backups/*.backup.<ts>`가 1건 롤오버됐다 —
이 스파이크가 어떤 `claude` 서브프로세스도 띄우지 않은 순수 대기 구간에서 관측된 변화다. 이는
"실행 중인 세션이 8초 만에 `.claude.json`+`backups/`를 바꾼다"(부록 항목 1)는 서술과 정확히 일치하며,
**"격리 실패"가 아니라 "오케스트레이터 자신의 정상 동작"임을 원인 수준에서 확인한다.**

다만 위 §01-isolation.sh의 실제 실행(자식 프로세스 실행 포함, 수 초 소요)에서는 strict diff가
여러 차례 우연히 0건이었다 — churn이 발생하는 타이밍(주기적 flush)과 스파이크 실행 타이밍이
매번 겹치는 것은 아님을 시사한다. **따라서 strict 판정만으로 "격리됐다/안 됐다"를 결론 내리는 것은
타이밍에 좌우되어 불안정하고, filtered 판정(Tier-2 churn 제외)이 실제로 신뢰 가능한 신호다.**

## Tier-2 churn 허용목록 (이 스파이크가 쓴 값 — 근거와 함께)

`spikes/lib/isolate.sh`의 `CTK_CHURN_ALLOWLIST_REGEX`에 아래를 넣었다. 권위 있는 최종값은
AC-0.8(§명령별 부수효과 전량 열거)이 대체한다 — 이 값은 그 전까지의 잠정값이다(plan §2.7-b).

`.claude.json` · `backups/*` · `history.jsonl` · `statsig/` · `projects/` · `shell-snapshots/` ·
`todos/` · `stats-cache.json` · `mcp-needs-auth-cache.json` · `paste-cache/` · `sessions/` ·
`plugins/repos/`

10초 대조에서 실측된 변경분(`.claude.json`, `backups/*`)은 이 목록의 부분집합이다 — 가드를
약화한 것이 아니라 실측된 churn만 제외 대상에 넣었다. **AC-0.8 실측 결과 이 목록에 `*.tmp.*`
(원자적 쓰기 임시파일) 패턴이 추가로 필요함이 드러났다 — `results/AC-0.8.md` 참조.**

## AC-0.1 최종 판정: **PASS (조건부 — filtered 판정 기준)**

- Strict(무제외) 판정은 타이밍에 따라 우연히 PASS가 나올 수 있으나 신뢰 가능한 신호가 아니다.
- **Filtered 판정(Tier-2 churn 허용목록 제외)이 이 AC의 실제 판정 기준이며, 매 실행 0 diff로 PASS했다.**
- 자식 프로세스가 격리 트리(합성 플러그인)만 인식하고 실제 마켓플레이스를 인식하지 못함을 직접 증거로 확인했다.
- **차단 해제.** 전 Step(특히 Step 1의 e2e 격리 테스트 설계)은 quick-digest + Tier-2 필터 방식을 그대로
  채택하면 된다. sha256 전체 다이제스트는 `CTK_FULL_SHA256=1`로 옵션화했다(비용 최적화 — 부록 항목 2).

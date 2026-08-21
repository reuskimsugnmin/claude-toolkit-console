# Step 0 스파이크 — ctk v1 하네스 전제 실증

`.omc/plans/ctk-v1-consensus-plan.md` §3 AC-0 / §6.3의 11개 항목(0.1~0.5·0.6a·0.6b·0.7~0.10)을
실제로 실행해 관측값을 수집한 스파이크 모음. **프로덕션 패키지가 아니다** — Step 1이 재사용 가치가
있는 픽스처만 `fixtures/`로 승격한다.

관측값·판정·근거는 `results/AC-0.*.md`에 있다. 이 파일은 **어떻게 재현하는지**만 설명한다.

## 전제

- `claude` CLI가 PATH에 있어야 한다(이 스파이크는 `2.1.237 (Claude Code)`로 검증 — `results/AC-0.9.md`).
- 이 환경은 **구독(OAuth) 인증 전용이며 `ANTHROPIC_API_KEY`/`apiKeyHelper`가 없다.** 이 사실 자체가
  `results/AC-0.10.md`의 핵심 발견(격리 홈에서 OAuth가 깨진다)의 전제이니, API 키가 있는 환경에서
  재실행하면 다른 결과가 나올 수 있다 — 그 경우 `results/AC-0.10.md`·`AC-0.6a.md`·`AC-0.7.md`를
  갱신할 것.
- 실제 사용자 `~/.claude`·`~/.claude.json`은 **읽기만 한다.** 쓰기가 필요한 모든 스파이크는
  `spikes/lib/isolate.sh`의 `ctk_isolate`로 만든 `mktemp -d` 격리 트리에서만 쓴다.

## 격리 라이브러리 (`spikes/lib/`)

- `isolate.sh` — `ctk_isolate` / `ctk_assert_isolated` / `ctk_assert_isolated_filtered` / `ctk_teardown`.
  plan §6.0 원문 셸 스크립트를 기반으로 하되, **quick digest(경로+크기+mtime) 기본 + `CTK_FULL_SHA256=1`일
  때만 전체 sha256**으로 비용을 낮췄다(실측 `~/.claude` = 285,948파일/7.3GB — 부록 항목 2). 또한
  이 셸 프로세스 자신의 `$HOME`은 절대 바꾸지 않는다(바꾸면 "실제 홈" 측정이 자기참조가 되는 버그를
  방지 — 원본 plan 스니펫엔 없던 보강).
- `spawn-claude.sh` — `ctk_spawn_claude` / `ctk_spawn_claude_in_cwd`. 프로덕션의
  `packages/probe/src/harness/spawn-claude.ts`에 대응하는 스파이크 버전 — 모든 `claude` 서브프로세스
  호출은 이 파일을 거친다(직접 spawn 금지, plan 결정 6).
- `patch-fixture.sh` — `ctk_install_synth_plugin`. 합성 마켓플레이스/플러그인을 **손으로 JSON을
  조작하지 않고** 실제 `claude plugin marketplace add` + `claude plugin install`로 격리 홈에
  설치한다(손으로 조작한 최초 시도는 실패했다 — 이유는 파일 상단 주석 참조).

## 픽스처 (`spikes/fixtures/`)

- `home/.claude/` — 격리 홈에 복사되는 기본 트리. `CLAUDE.md`(AC-0.10ⓓ 탐지용 마커) ·
  `hooks/leak-marker.sh`(SessionStart 훅, 발화 시 마커 파일 기록) · `skills/loose-skill/`(플러그인이
  아닌 느슨한 스킬) · `settings.json`(SessionStart 훅 등록만 — 마켓플레이스/플러그인 등록은 실제
  CLI가 설치 시 채운다).
- `marketplace-source/synth-mp/` — 합성 마켓플레이스 소스(설치 전 원본, 미등록 상태). 1개 플러그인
  `synth`(커맨드 `/synth:synth-probe` + 스킬 `synth-skill`)을 담는다.
- `project/.claude/settings.json` — `enabledPlugins: {"synth@synth-mp": false}` (AC-0.2 본측정용).

## 실행

```bash
cd spikes

# 차단 항목
bash 01-isolation.sh                 # AC-0.1
bash 02-project-plugins.sh           # AC-0.2 (대조군ⓓ 포함)
node 03-plugin-schema.mjs            # AC-0.3 (실제 환경, 읽기 전용)
bash 08-cli-side-effects.sh          # AC-0.8
claude --version | tee ../.omc/state/verified-cli-version.txt   # AC-0.9
python3 06-transcript-shape.py 30    # AC-0.6b (실제 트랜스크립트 30개 표본, 읽기 전용)
# AC-0.10은 단일 스크립트가 아니다 — 10-bare-skill-discovery.md와 results/AC-0.10.md 참조
# (ⓒ의 발견이 ⓐ의 측정 방법 자체를 바꿔서 즉흥 명령으로 진행했다. 모든 명령은 그 파일에 원문 그대로 있다)

# 정보 항목
python3 04-mcp-files.py <(claude mcp list)   # AC-0.4 (mcp list 캡처를 인자로 주면 ⓐ 자동 대조)
node 05-alwayson.mjs                          # AC-0.5 (실제 환경, 읽기 전용)
# AC-0.6a·AC-0.7은 실행 스크립트가 아니라 results/AC-0.6a.md·AC-0.7.md에 원문 명령+결과가 있다
# (양쪽 다 폴백으로 귀결 — 이유는 각 파일 참조)
```

각 스크립트는 `spikes/results/AC-0.*.md`를 (재)생성한다. **비용:** `claude -p` 호출이 있는 항목
(0.2·0.10·0.6a·0.7)은 전부 소액 `--max-budget-usd` 상한을 걸었고, 0.2·0.10ⓑ는 사전 인증 단계에서
라우팅이 판가름나는 신호를 발견해 실질적으로 $0에 판정했다(자세한 내용은 `results/AC-0.2.md` "방법론").
그 외 실제로 API를 호출한 것은 0.6a·0.7의 진단 호출들뿐이며 합계 실지출은 $0.2 미만이었다.

## 알려진 한계 (재실행 시 먼저 읽을 것)

`results/AC-0.10.md`의 "종합 판정"과 이 스파이크 실행을 위임한 상위 보고서를 함께 읽을 것 —
이 환경(API 키 없음)에서는 격리 홈의 라이브 모델 세션이 원천적으로 막혀 있어 AC-0.10ⓐ·AC-0.6a의
`--bare` 대조군·AC-0.7의 hook 구성을 완료하지 못했다. API 키가 있는 환경에서 이 스파이크들만
재실행하면 된다 — 격리 인프라(`lib/`)와 픽스처는 그대로 재사용 가능하다.

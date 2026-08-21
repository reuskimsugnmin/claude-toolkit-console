# AC-0.10 결과 — 4축 (ⓐ 자율 발견 · ⓑ `/이름` 명시 호출 · ⓒ 격리 홈 OAuth · ⓓ 격리 홈 훅/CLAUDE.md 미로드)

**성격: 차단.** 아래 ⓒ가 실패했고, 그 실패가 ⓐ의 측정 방법 자체를 봉쇄했다. 상세 근거는
각 축 아래에 원문 명령·출력과 함께 남긴다.

## 환경 전제

- `env | grep -i anthropic` → 결과 없음. `~/.claude/settings.json`에 `apiKeyHelper` 없음.
  → **이 환경은 구독(OAuth) 인증 전용이며 API 키가 전혀 없다.**
- `claude --help`의 `--bare` 설명(원문): "Anthropic auth is strictly ANTHROPIC_API_KEY or
  apiKeyHelper via --settings (OAuth and keychain are never read)." → **API 키가 없는 이 환경에서는
  `--bare` 세션 자체가 원천적으로 인증 불가능하다.** 이는 plan의 OQ-10 안 A 채택 근거와 정확히
  일치하는 실측이다.

## ⓒ 격리 홈에서 키체인 기반 OAuth 인증이 동작하는가 — **실패 (FAIL)**

### 실측 1 — 순수 격리(빈 HOME/CLAUDE_CONFIG_DIR)

```
$ (isolated: HOME=$CTK_HOME, CLAUDE_CONFIG_DIR=$CTK_HOME/.claude, 합성 픽스처만 존재)
$ echo "Reply with exactly the word PONG and nothing else." | claude -p --max-budget-usd 0.02 ...
Not logged in · Please run /login
```

### 실측 2 — 실제 `~/.claude.json`(`oauthAccount` 포함)을 격리 HOME에 임시 복사해도 동일

**주의: 이 복사본은 `/tmp` 안에서만 존재했고 실행 직후 삭제했다. `spikes/`(공개 저장소) 어디에도
실제 계정 정보를 쓰지 않았다 — CLAUDE.md 위생 규칙 준수.**

```
$ cp "$HOME/.claude.json" "$CTK_HOME/.claude.json"   # 런타임 한정, git 미추적 /tmp 경로
$ echo "..." | claude -p ...
Not logged in · Please run /login
```

→ `oauthAccount`(계정 참조)를 복사해도 실패 — **인증 정보를 찾는 메커니즘이 `.claude.json`의
계정 참조가 아니라 다른 무언가에 묶여 있다.**

### 실측 3 — 실제 HOME은 그대로 두고 `CLAUDE_CONFIG_DIR`만 격리(빈 새 디렉터리)

```
$ env -i HOME="$REAL_HOME" CLAUDE_CONFIG_DIR="$FAKE_CONFIG_DIR" ... claude -p ...
Not logged in · Please run /login
```

→ **실제 HOME을 유지해도 `CLAUDE_CONFIG_DIR`만 바꾸면 인증이 깨진다.** 즉 인증 자격 증명 조회는
**HOME이 아니라 `CLAUDE_CONFIG_DIR`(그 경로 자체 또는 그 경로에서 파생된 무언가)에 묶여 있다.**

### 근거 자료 — macOS 키체인 서비스 이름 패턴

```
$ security dump-keychain 2>/dev/null | grep -i -B2 "claude" | grep svce | head
"svce"<blob>="Claude Safe Storage"
"svce"<blob>="Claude Code-credentials-2273ffd2"
"svce"<blob>="Claude Code-credentials-9d4f390b"
... (이 머신에서 서로 다른 해시 접미사를 가진 다수의 항목 확인)
```

`Claude Code-credentials-<8자리 hex>` 형태 — **접미사 해시가 설치/설정 위치별로 다르다는 강한
정황 증거.** (해시 산출 알고리즘 자체는 소스가 없어 역산하지 않았다 — 이 이상은 추측이 된다.)

### ⓒ 판정: **FAIL.** 격리된(또는 단지 다른) `CLAUDE_CONFIG_DIR`은 키체인 자격 증명을 찾지 못한다 —
**실제 HOME이 유지돼도 마찬가지다.** "macOS 키체인은 계정 기반이라 읽힐 것"이라는 plan의 낙관적
가정(§1.3 결정6 하단)은 **반증됐다.**

### 폴백 (plan 지정 — 안 C)

키가 있으면 `--bare`, 없으면 "A 경로 + 경고"로 자동 전환하라고 명시돼 있다. **이 환경은 키가
없으므로 "A 경로 + 경고"다.** 그런데 A 경로(격리 다중화) 자체가 **바로 이 실패 때문에 라이브
모델 세션을 전혀 띄울 수 없다** — 폴백이 폴백을 요구하는 순환이 발생한다. **이것이 이번
스파이크의 가장 중요한 발견이다:** 이 환경 구성(구독 전용, API 키 없음)에서는 **`gen`이 완전
격리된 `CLAUDE_CONFIG_DIR`로는 어떤 라이브 `claude -p` 세션도 실행할 수 없다** — `--bare`(키 필요)도,
A안 격리 다중화(이번에 키체인이 안 됨을 확인)도 안 된다.

## ⓐ 자율 발견 — **판정불가 (환경 제약, ⓒ의 직접적 귀결)**

ⓐ를 측정하려면 실제 모델 완료(completion)가 필요하다(자연어 질의에 모델이 스스로 스킬을
호출하는지 관측). ⓒ가 실패한 이상 격리 홈에서는 애초에 모델까지 도달하지 못한다. 두 가지
대안을 검토했으나 둘 다 기각했다:

1. **실제(비격리) 환경에서 테스트** — 합성 플러그인을 **실제 `~/.claude`에 설치**해야 하므로
   "실제 사용자 환경을 절대 수정하지 마세요"(과업 제약)를 정면 위반한다. **기각.**
2. **`--plugin-dir`로 세션 한정 로딩** — 실제 HOME/CONFIG_DIR(인증 정상)을 유지한 채
   `--plugin-dir <합성 플러그인 경로>`로 세션에만 임시로 얹으려 시도했으나, **`/synth-probe`도
   `/synth:synth-probe`도 인식되지 않았다**(`Unknown command`) — `--plugin-dir`이 커맨드를
   등록하는 조건을 이번 스파이크에서 규명하지 못했다(문서화된 스키마 없이 시행착오만 함).
   설령 규명했더라도 실제 HOME을 쓰므로 **AC-0.10이 원래 요구하는 "격리 홈에서" 조건을 만족하지
   못한다.** **채택하지 않음.**

**결론: ⓐ는 이번 스파이크에서 측정 불가.** API 키가 있는 환경에서 재실행(그러면 `--bare`가
정상 동작해 A안·B안 양쪽 비교가 모두 가능해진다)하거나, ⓒ의 키체인 바인딩 메커니즘을 규명해
격리 `CLAUDE_CONFIG_DIR`에서도 인증이 되게 만든 뒤 재시도해야 한다.

## ⓑ `/이름` 명시 호출 — **부분 측정 (제약 있음, 유의미한 신호 확보)**

인증까지 갈 필요 없이 **"커맨드가 라우팅 테이블에 있는가"만으로 판정 가능**하다는 것을
AC-0.2에서 발견한 것과 같은 방법으로 측정했다 — `Unknown command`(미인식) vs `Not logged in`
(인식됨, 인증 단계에서만 막힘)이 그 신호다. **모델 호출 없이 0원.**

| 세션 구성 | `/synth:synth-probe`(플러그인 커맨드) | `/loose-skill`(느슨한 skills/ 디렉터리 스킬) |
|---|---|---|
| 격리 홈, `--bare` 없음 | `Not logged in`(**인식됨**) | `Not logged in`(**인식됨**) |
| 격리 홈, `--bare` 있음 | `Unknown command`(**미인식**) | `Unknown command`(**미인식**) |

### ⓑ 판정: **`--bare`는 플러그인 커맨드와 느슨한(loose) 스킬 커맨드 양쪽 모두 무력화한다.**

`claude --help`의 `--bare` 설명 "Skills still resolve via /skill-name"은 **이번 실측과 배치된다** —
플러그인 제공 커맨드(`/synth:synth-probe`)와 `~/.claude/skills/`에 직접 놓인 느슨한 스킬
(`/loose-skill`) 둘 다 `--bare` 아래서 `Unknown command`였다. **문서와 실측이 다른 사례 —
CLAUDE.md의 "자동 스캐너는 부정문을 오독한다"는 원문 재확인 원칙을 사람이 쓴 도움말 문구에도
적용해야 한다는 교훈이다.** (이 문구가 의도한 다른 "skill-name" 형태 — 예컨대 `--allowedTools`로
명시 화이트리스트된 경우 — 가 있을 수도 있으나 이번 스파이크 예산으로는 추가 조사하지 않았다.)

**plan의 예측("--help가 그렇게 적으므로 ⓑ만 살고 ⓐ가 죽는 결과가 가장 유력")과 다른 결과다:**
실측상 **ⓑ도 `--bare` 아래서는 죽는다.** (단 `--bare` 아닌 세션에서는 ⓑ가 라우팅 단계까지는
살아있음을 확인했다 — 위 표의 "인식됨" 행.)

## ⓓ 격리 홈에 심은 훅·CLAUDE.md 미로드 — **혼재된 결과, 해석 갈림 — 사용자/architect 판단 필요**

### 실측 (재현 가능)

```
$ (isolated, --bare 없음) echo "hello" | claude -p ...
Not logged in · Please run /login
$ cat "$CTK_HOME/.hook-fired-marker"
CTK_SPIKE_HOOK_FIRED at 2026-08-20T05:30:07Z    ← 훅이 실행됐다
```

```
$ (isolated, --bare 있음) echo "hello" | claude -p --bare ...
Unknown command / (또는 동일 인증 오류 없이 조기 종료)
$ [ -f "$CTK_HOME/.hook-fired-marker" ] && echo FIRED || echo "did NOT fire"
did NOT fire   ← --bare 아래서는 훅이 실행되지 않았다
```

**CLAUDE.md 로드 여부는 직접 확인하지 못했다** — 마커 문구를 모델이 되뇌는 것으로 판정하려
했으나 ⓒ의 인증 실패로 모델 응답 자체를 받지 못했다. 훅 발화(파일시스템 부수효과, 인증 불필요)만
관측 가능했다.

### 두 가지 상반된 해석 — **executor가 임의로 하나를 고르지 않는다 (과업 지시 준수)**

**해석 A (안전 — "이건 기대된 동작"):** 격리 트리에 **우리가 스스로 심어둔** 훅이 실행된 것은
"실제 사용자의 훅/CLAUDE.md가 격리를 뚫고 새어 들어온다"는 뜻이 아니다. AC-0.1에서 실제 홈이
자식 프로세스 실행 중 전혀 건드려지지 않음을(필터링 후 diff 0건) 이미 확인했다 — 즉 로딩 소스는
`CLAUDE_CONFIG_DIR`이 가리키는 곳으로 정확히 결정되고, 실제 홈으로 새지 않는다. `gen`의 실제
운영 시나리오에서는 격리 트리를 **훅·CLAUDE.md 없이 비워두면** 그만이므로 이 결과는 오히려
"메커니즘이 우리가 넣은 대로 정직하게 반응한다"는 긍정적 증거로 읽을 수 있다.

**해석 B (plan 원문 그대로 — "이건 실패 신호"):** plan §11은 이 항목의 판정 신호를 "심어둔
훅/CLAUDE.md가 로드되지 않는가"로 명시했고 "**로드되면 A안의 전제가 깨진다**"고 못박았다.
실측상 (비-bare) 격리 세션에서 심어둔 훅이 **로드됐다.** 문언 그대로 읽으면 **ⓓ FAIL**이고,
"ⓓ 실패 시에는 폴백 없이 중단하고 사용자에게 올린다"가 적용된다.

### ⓓ 판정: **문언 기준으로는 FAIL로 기록한다 (안전측 선택).** 위 해석 A가 타당할 가능성이
높다고 executor는 판단하지만(§AC-0.1의 교차 증거 때문), **계획 문서가 명시적으로 "로드=실패"라고
정의했고 이 판정이 Step 4 전체의 착수 여부를 가르는 게이트이므로, 해석을 자의로 낙관 쪽으로
바꾸지 않는다.** 아래 "설계 변경 필요" 절에서 이 해석 갈림을 명시적 의사결정 항목으로 올린다.

## 종합 판정: **AC-0.10 = 차단 유지. Step 4 및 AC-3.3 착수 보류.**

- ⓒ FAIL → 안 C 폴백조차 이 환경에서는 실행 불가(순환).
- ⓐ 판정불가(환경 제약) → AC-3.3(자율 발견 의존)을 실행할 근거가 없다.
- ⓑ `--bare`에서 무력화됨(부분 측정) → plan의 "ⓑ만 산다"는 예측이 틀렸다는 것 자체가 설계
  재검토 신호다.
- ⓓ 문언 기준 FAIL, 실질 해석은 사용자/architect 판단 필요.

**사용자에게 올리는 구체적 질문 (부록 항목 9·10 요구사항 준수):**
1. ⓓ를 "해석 A"(안전, 격리 성립)로 확정할지, "해석 B"(문언대로 실패)로 유지하고 Step 4를
   재설계할지.
2. ⓐ·ⓒ를 측정하려면 **API 키가 있는 별도 환경에서 이 스파이크(spikes/02, spikes/10 관련 명령)를
   재실행**하는 것이 유일하게 확인된 경로다 — 이걸 언제·어떻게 할지.
3. `gen`이 이 머신(OAuth 전용, 키 없음)에서는 원천적으로 라이브 세션을 못 띄운다는 것이 v1
   스코프에 어떤 영향을 주는지(예: `gen`을 "API 키 보유 환경 전용" 기능으로 명시할지).

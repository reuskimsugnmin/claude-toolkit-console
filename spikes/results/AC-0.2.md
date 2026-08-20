# AC-0.2 결과 (자동 생성 — 2026-08-20T05:46:57Z)

## 방법론 (실측으로 확정 — 최초 설계에서 변경됨)

`/synth-probe`(bare)는 항상 `Unknown command`였다 — 플러그인 커맨드는
`/<plugin-name>:<command-name>` 형식(예: `/synth:synth-probe`)으로만 라우팅된다는
것을 실측으로 발견했다. 이 형식은 **인증 이전에 라우팅이 결정된다** — 격리 홈에서
OAuth가 깨져 있어도(AC-0.10ⓒ 참조) `Unknown command`(미인식) vs `Not logged in`
(인식됨, 인증 단계에서만 막힘)을 구분할 수 있다. 이 신호로 **모델 호출 없이 0원**으로
AC-0.2를 판정한다.

## 결과

- 대조군ⓓ (설치 기본값 true, 프로젝트 오버라이드 없음): **recognized_blocked_by_auth**
- 본측정 1 (프로젝트 enabledPlugins: false): **not_recognized**
- 본측정 2: **not_recognized**
- 본측정 3: **not_recognized**

## 판정: **존중 (respected)** — 3회 전원 일치

대조군에서는 인식되고(auth 단계까지 도달), 프로젝트 `enabledPlugins:false`가 걸리자
3회 모두 `Unknown command`로 뒤집혔다. **프로젝트 `enabledPlugins`가 user-scope
설치를 실제로 존중한다.**

## 참고 — 이 판정이 완전한 라운드트립(실제 모델 실행)은 아니다

이 환경(OAuth 전용 구독, API 키 없음)에서는 격리 홈의 인증이 깨져 있어(AC-0.10ⓒ 참조)
`recognized_and_ran`(실제로 커맨드가 모델까지 도달해 실행)까지는 관측하지 못했다.
다만 AC-0.2가 요구하는 신호는 "커맨드 열거/인식 여부"이며, `Unknown command`(라우팅 테이블에
없음) vs `Not logged in`(라우팅은 통과했고 인증 단계에서만 막힘)은 **완전히 다른 코드 경로**이므로
이 구분만으로 "프로젝트 설정이 라우팅 단계에 반영되는가"를 판정하는 데는 충분하다. API 키가 있는
환경에서 재실행하면 `recognized_and_ran`까지 관측해 이 판정을 한 단계 더 강화할 수 있다(Step 5
착수를 막지 않는 보강 항목으로 기록).

## 판정: **PASS — Step 5 차단 해제.** 대조군ⓓ 통과, 본측정 3/3 일치, invalid_fixture 아님.

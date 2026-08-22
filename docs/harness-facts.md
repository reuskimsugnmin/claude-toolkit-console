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
- 배경 churn(ctk와 무관한, 실행 중인 다른 세션에 의한 변경)은 8초 관측에서 0건이었다 —
  상황에 따라 다르므로 격리 판정은 여전히 허용목록 기준으로 한다.

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

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
- `~/.claude.json`에 `skillUsage`·`pluginUsage`(`{usageCount, lastUsedAt}`)가 이미 있다.
- 세션 트랜스크립트에 `attributionSkill`·`attributionPlugin`·`attributionMcpServer` 필드가
  **이미 있다.** 귀속을 접두어 매칭으로 재발명하기 전에 이 필드를 먼저 본다. 단 모든 세션에
  있지는 않으므로, 부재의 **원인**(구버전인가 `--bare`인가)을 확인하기 전에는 단정하지 않는다.
- `tool_result` 블록은 `user` 행에만 있다(`tool_use`는 `assistant` 행). 서브에이전트 스폰
  도구명은 `Agent`다.
- **서브에이전트 기록은 같은 트랜스크립트 파일 안에 `isSidechain: true` 행으로 들어간다**
  (전수 실측: 663개 중 324개 파일에 존재). Step 0이 "표본 79,420행에서 0건"으로 관측한 것은
  **한 파일만 본 표본 편향**이었다 — 부재를 단정하기 전에 전수를 확인한다.
- sidechain 행은 사용량 귀속에 필요한 것을 전부 갖는다: `assistant` 행에 `usage`가 실리고,
  **`attributionAgent`** 필드가 스폰된 에이전트를 지목하며(값은 `general-purpose` 또는
  `oh-my-claudecode:critic`처럼 **자산 id와 그대로 대응**), `agentId`로 같은 실행을 묶을 수 있다.
  즉 귀속 필드는 넷이다 — `attributionSkill`·`attributionPlugin`·`attributionMcpServer`·`attributionAgent`.

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

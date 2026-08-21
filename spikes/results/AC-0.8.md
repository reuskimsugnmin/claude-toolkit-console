# AC-0.8 결과 (자동 생성 — 2026-08-20T05:48:02Z)

각 명령을 **독립된 격리 홈**(합성 마켓플레이스+플러그인 픽스처 포함)에서 1회씩 실행하고,
실행 전후 $CLAUDE_CONFIG_DIR 트리 전체(작아서 sha256 전량 — 실제 홈이 아님)를 대조했다.

### `plugin list --json` (exit rc=0)

- command: `claude plugin list --json`
- installed_plugins.json sha256 unchanged: **yes** (before=e868fbabb83922a1222843a16ce1e2dfd73fa1464b31c1e5c055e094ca3406e6, after=e868fbabb83922a1222843a16ce1e2dfd73fa1464b31c1e5c055e094ca3406e6)
- changed paths (added/removed/modified, relative to $CLAUDE_CONFIG_DIR):
  - (none)
- stdout (first 15 lines):
```
[
  {
    "id": "synth@synth-mp",
    "version": "0.0.1",
    "scope": "user",
    "enabled": true,
    "installPath": "/var/folders/tf/_rztx0tj7bq_dyxq0thrny000000gn/T/tmp.0HQK5MFjef/.claude/plugins/cache/synth-mp/synth/0.0.1",
    "installedAt": "2026-08-20T05:48:16.064Z",
    "lastUpdated": "2026-08-20T05:48:16.064Z"
  }
]
```

### `plugin details synth@synth-mp` (exit rc=0)

- command: `claude plugin details synth@synth-mp`
- installed_plugins.json sha256 unchanged: **yes** (before=b78b9fbc9d0cb20b7f001bea11bc5e22687e115b91220f0afcf449f366e6721f, after=b78b9fbc9d0cb20b7f001bea11bc5e22687e115b91220f0afcf449f366e6721f)
- changed paths (added/removed/modified, relative to $CLAUDE_CONFIG_DIR):
  - (none)
- stdout (first 15 lines):
```
synth 0.0.1
  ctk spike synthetic plugin — not a real tool, exists only to test enablement/discovery semantics.
  Source: synth@synth-mp

Component inventory
  Skills (2)  synth-probe, synth-skill
  Agents (0)
  Hooks (0)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~114 tok   added to every session

Per-component (rounded)
```

### `plugin enable synth@synth-mp` (exit rc=1)

- command: `claude plugin enable synth@synth-mp -s user`
- installed_plugins.json sha256 unchanged: **yes** (before=5821409f11e1959c4a8a668deed214c2daceb2a1d1aabb60aa98aa914b06813a, after=5821409f11e1959c4a8a668deed214c2daceb2a1d1aabb60aa98aa914b06813a)
- changed paths (added/removed/modified, relative to $CLAUDE_CONFIG_DIR):
  - (none)
- stdout (first 15 lines):
```
```
- stderr (first 15 lines):
```
✘ Failed to enable plugin "synth@synth-mp": Plugin "synth@synth-mp" is already enabled at user scope
```

### `plugin disable synth@synth-mp` (exit rc=0)

- command: `claude plugin disable synth@synth-mp -s user`
- installed_plugins.json sha256 unchanged: **yes** (before=bd97f9009d2764c64edc98a0161f10a58ae3bc11082830468624875cf1d2989f, after=bd97f9009d2764c64edc98a0161f10a58ae3bc11082830468624875cf1d2989f)
- changed paths (added/removed/modified, relative to $CLAUDE_CONFIG_DIR):
  - ./settings.json
- stdout (first 15 lines):
```
✔ Successfully disabled plugin: synth (scope: user)
```

### `plugin enable synth@synth-mp` (supplementary — starting from disabled, exit rc=0)

- installed_plugins.json sha256 unchanged: **yes**
- changed paths:
  - ./settings.json
- stdout:
```
✔ Successfully enabled plugin: synth (scope: user)
```


## 판정 및 AC-2.7 Tier 2 허용목록 갱신 근거

**4개 명령 + 보충 1건, 총 5회 실행 — `installed_plugins.json` sha256이 단 한 번도 바뀌지 않았다**
(실패한 `enable`(이미 활성)까지 포함). **이것이 결정 6C·AC-2.1ⓒ·AC-2.7-c의 전제를 실증한다.**

### 명령별 부수 효과 전량 (AC-2.7 Tier 2 허용목록 초기값 — 이 표가 §2.7-b 예시 값을 대체한다)

| 명령 | 건드리는 경로 | installed_plugins.json |
|---|---|---|
| `plugin list --json` (읽기 명령인데도!) | `.claude.json`, `.claude.json.tmp.<pid>.<rand>`(원자적 쓰기 임시파일), `backups/.claude.json.backup.<ts>` | 무변경 |
| `plugin details <id>` (읽기 명령) | `.claude.json`, `backups/.claude.json.backup.<ts>` | 무변경 |
| `plugin enable <id>` (실패 케이스 — 이미 활성) | `.claude.json`, `backups/.claude.json.backup.<ts>` (실패해도 씀) | 무변경 |
| `plugin disable <id>` (성공) | `.claude.json`, `backups/.claude.json.backup.<ts>`, **`settings.json`**(ctk 소유 Tier 1 경로 — 의도된 쓰기) | 무변경 |
| `plugin enable <id>` (성공, disabled→enabled) | `settings.json`만 (이 실행에서는 `.claude.json`/`backups` 갱신이 관측되지 않음 — 직전 `disable` 호출이 이미 그 주기의 갱신을 소모했을 가능성. 표본 1건이므로 "항상 없다"고 단정하지 않는다) | 무변경 |

**핵심 확인 사항:**
1. **`.claude.json`은 읽기 명령(`list`, `details`)만 실행해도 매번 갱신된다** — CLAUDE.md/decision 4의
   "plugin list --json 1회 호출로 .claude.json + backups/ 생성"이 그대로 재현됐고, `.claude.json.tmp.*`
   원자적 쓰기 임시파일까지 직접 관측됐다(Tier 2 목록에 `*.tmp.*` 패턴도 추가해야 함 — 기존 §2.7-b
   예시엔 없던 항목, **설계 갱신 필요**).
2. **`enable`/`disable`은 `settings.json`(Tier 1, ctk 소유)만 의도된 쓰기 대상으로 건드리고
   `installed_plugins.json`은 절대 건드리지 않는다** — 5회 전부 sha256 불변. **결정 6C의 "install scope
   무변경" 보장이 실측으로 성립한다.**
3. 실패한 명령(이미 활성 상태에서 `enable`)도 `.claude.json`/`backups`를 갱신한다 — **명령의 성공/실패
   여부와 무관하게 이 churn이 발생**하므로, Tier 2 허용목록은 "성공한 쓰기 명령"이 아니라 **명령 실행
   자체**를 기준으로 적용해야 한다.

### Tier 2 churn 허용목록 최종값 (AC-0.8 실측이 §2.7-b 잠정값을 대체)

```
.claude.json
.claude.json.tmp.*          ← 신규: 원자적 쓰기 임시파일 (이번 실측에서 발견, 기존 목록엔 없었음)
backups/*.backup.<ts>
```
위 3개 패턴만 이번 4+1개 명령 실측에서 확인됐다. plan 예시의 나머지 항목
(`mcp-needs-auth-cache.json`·`stats-cache.json`·`history.jsonl`·`shell-snapshots/`·`paste-cache/`·
`sessions/`·`projects/`·`statsig/`·`todos/`·`plugins/repos/**`)은 **이번 4개 명령으로는 재현되지 않았다**
— 다른 명령(예: 세션 시작, `mcp` 관련 명령)에서 발생하는 것으로 보이며, AC-0.1의 10초 대조에서
`backups/*`가 갱신되는 것을 이미 별도로 확인했다(§AC-0.1 참조). **목록에서 빼는 것이 아니라, "이 4개
플러그인 명령으로 실측된 것"과 "다른 경로로 이미 알려진 것"을 구분해 병기한다** — 가드를 약화하지 않는다.

## 판정: PASS (차단 해제) — Step 5 착수 가능

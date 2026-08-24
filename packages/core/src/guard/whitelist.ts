/**
 * Tier-2 churn 허용목록. 착수 조건 C3 — AC-0.8 실측값(spikes/results/AC-0.8.md)으로 갱신하되
 * tmp는 앵커된 정규식으로만 한정한다. 와일드카드는 화이트리스트를 과도하게 넓힌다.
 */
export interface AllowlistRule {
  /** 정확한 상대경로 매칭 */
  exact?: string;
  /** 앵커된 정규식 매칭. 절대 `.*`류 무앵커 와일드카드를 쓰지 않는다 (C3) */
  pattern?: RegExp;
  /** 근거 — AC-0.8 실측인지, 다른 명령에서 알려진 것(미실측)인지를 명시한다. 가드 약화 금지 */
  note: string;
}

export function matchesAllowlist(relativePath: string, rules: readonly AllowlistRule[]): AllowlistRule | undefined {
  return rules.find((rule) => {
    if (rule.exact !== undefined) return rule.exact === relativePath;
    if (rule.pattern !== undefined) return rule.pattern.test(relativePath);
    return false;
  });
}

/**
 * Tier-1 = ctk가 의도적으로 쓰는 경로 (plugin enable/disable의 settings.json, AC-0.8 실측).
 */
export const TIER1_INTENTIONAL_WRITES: readonly AllowlistRule[] = [
  { exact: "settings.json", note: "AC-0.8 실측 — enable/disable의 의도된 쓰기 대상 (Tier 1)" },
];

/**
 * Tier-2 churn 허용목록 — **AC-0.8이 실제로 실측한 3개 패턴만**(.claude.json ·
 * .claude.json.tmp.* · backups/*.backup.<ts>). `ctk move`(Step 5 실제 명령 —
 * plugin enable/disable) 감사는 이 좁은 목록만 쓴다.
 *
 * ⚠️ **Step 5 보안 심사 수정(M7)** — 이전에는 미실측 항목(`plugins/repos/**` 등)까지 같은
 * 목록에 섞여 있어 실제 조치 감사에도 함께 적용됐다. `plugins/repos/**`는 **플러그인 코드
 * 트리 자체**다 — 이 패턴이 실제 조치의 허용목록에 들어있으면 조치 도중 플러그인 소스가
 * 바뀌어도(공급망 위협 시나리오) 감사를 조용히 통과한다. 실제 명령엔 실측된 것만 허용하고,
 * 미실측 병기 목록은 `TIER2_CHURN_ALLOWLIST_KNOWN_UNMEASURED`로 분리해 향후 `gen`(Step 4,
 * 모델 세션 프로파일)처럼 그 항목들이 별도로 실측될 계층에서만 쓰게 한다.
 */
export const TIER2_CHURN_ALLOWLIST: readonly AllowlistRule[] = [
  { exact: ".claude.json", note: "AC-0.8 실측 — 읽기 명령(list/details)만 실행해도 매번 갱신" },
  {
    // 앵커된 정규식만 허용 (C3) — 원자적 쓰기 임시파일. 경로 순회(../) 시도는 이 패턴에 매치되지 않는다.
    pattern: /^\.claude\.json\.tmp\.\d+\.[A-Za-z0-9]+$/,
    note: "AC-0.8 실측 — plugin list --json 1회로도 생성되는 원자적 쓰기 임시파일",
  },
  {
    pattern: /^backups\/[^/]+\.backup\.\d+$/,
    note: "AC-0.8 실측 — list/details/enable/disable 전부 생성 (실패한 enable도 포함)",
  },
];

/**
 * 미실측 병기 목록(M7) — 다른 경로(AC-0.1의 10초 대조, §2.7-b 원안)에서 이미 알려졌지만
 * Step 5의 4+1개 명령 실측으로는 재현되지 않은 항목들이다. **실제 조치(`ctk move`) 감사에는
 * 쓰지 않는다** — `TIER2_CHURN_ALLOWLIST`(실측된 좁은 목록)만 쓴다. 이 목록은 향후 별도
 * 프로파일(예: `gen`의 `-p` 모델 세션)이 그 항목들을 자체적으로 실측해 확인한 뒤에만 채택
 * 대상이다. 가드 약화 금지 원칙에 따라 정보를 버리지 않고 이름을 분리해 남겨둔다.
 */
/**
 * `sealed-live` 전용 Tier-2 churn 허용목록 (iter 8 · B3 — AC-0.11 실측, docs/harness-facts.md
 * "`sealed-live` 봉인 세션의 churn" 절). **`TIER2_CHURN_ALLOWLIST`(AC-0.8, 격리 홈에서 measured
 * 4개 명령)를 전용하지 않는다** — 워크로드가 다르다(AC-0.8 = `plugin list/details/enable/disable`
 * · AC-0.11 = 실제 config dir에 대한 `claude -p` 모델 세션 3회).
 *
 * AC-0.11 실측값: `plugins/`는 mtime만 바뀌어 sha256 기준 diff에는 애초에 나타나지 않는다.
 * `sessions/`는 mtime과 함께 `<pid>.json` · `<pid>.<hash>.key` 파일이 새로 생긴다.
 * `--no-session-persistence`를 함께 쓰면(§1.3 결정 6 `sealed-live` 명세) `projects/` churn이
 * 통째로 사라지므로 이 목록에 넣지 않는다 — 실제로 나타나지 않을 churn을 허용목록에 올리면
 * "허용목록이 조용히 넓어진다"(Pre-mortem H)는 바로 그 실패 모드를 자초하는 것이다.
 * `.claude.json`은 바이트 수준에서는 AC-0.8과 같은 경로이므로 기존 항목을 그대로 재사용하되,
 * **내용(JSON) 수준**은 `SEALED_LIVE_CLAUDE_JSON_ALLOWED_CHURN_KEYS`로 별도로 좁힌다(단
 * 하나 — `cachedGrowthBookFeaturesAt`).
 */
export const TIER2_CHURN_ALLOWLIST_SEALED_LIVE: readonly AllowlistRule[] = [
  { exact: ".claude.json", note: "AC-0.11 실측 — sealed-live claude -p 3회 실행 전부에서 바뀜(의미 diff는 별도 좁힘)" },
  {
    pattern: /^\.claude\.json\.tmp\.\d+\.[A-Za-z0-9]+$/,
    note: "AC-0.8과 동형의 원자적 쓰기 임시파일 — AC-0.11에서도 같은 갱신 경로를 쓴다",
  },
  {
    pattern: /^sessions\/\d+\.json$/,
    note: "AC-0.11 실측 — sealed-live claude -p 실행마다 생성되는 세션 메타 파일(<pid>.json)",
  },
  {
    pattern: /^sessions\/\d+\.[A-Za-z0-9]+\.key$/,
    note: "AC-0.11 실측 — sealed-live claude -p 실행마다 생성되는 세션 키 파일(<pid>.<hash>.key)",
  },
  {
    // ⚠️ 앵커된 정규식만 쓴다. `backups/*`처럼 넓히면 그 디렉터리 아래 무엇이 바뀌어도 통과하고,
    // 그때부터 이 가드는 아무것도 막지 못한다(Pre-mortem H — 허용목록의 반사적 확장).
    pattern: /^backups\/\.claude\.json\.backup\.\d+$/,
    note:
      "실측(gen 첫 실행) — `.claude.json` 갱신 시 하네스가 회전시키는 백업. harness-facts의 " +
      "\"plugin list --json 한 번만 실행해도 .claude.json과 backups/가 생성된다\"와 같은 경로다. " +
      "AC-0.11 최초 측정(maxdepth 2, 3회)에서는 회전이 일어나지 않아 관측되지 않았다 — " +
      "측정 범위의 한계가 드러난 사례이므로 근거를 함께 남긴다.",
  },
];

/**
 * `.claude.json`의 의미(JSON) diff에서 `sealed-live`가 허용하는 유일한 최상위 키
 * (`core/guard/claude-json-semantic.ts`의 `allowedChurnKeys`에 그대로 넘긴다). AC-0.11 실측 —
 * 3회 실행 전부에서 `projects` 맵은 무변경이었고 바뀐 최상위 키는 이 하나뿐이었다.
 */
export const SEALED_LIVE_CLAUDE_JSON_ALLOWED_CHURN_KEYS: readonly string[] = ["cachedGrowthBookFeaturesAt"];

export const TIER2_CHURN_ALLOWLIST_KNOWN_UNMEASURED: readonly AllowlistRule[] = [
  { exact: "mcp-needs-auth-cache.json", note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { exact: "stats-cache.json", note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { exact: "history.jsonl", note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^shell-snapshots\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^paste-cache\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^sessions\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^projects\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^statsig\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^todos\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지)" },
  { pattern: /^plugins\/repos\//, note: "다른 명령에서 알려짐 (미실측, 병기 유지) — 플러그인 코드 트리 자체이므로 실제 조치 감사에 절대 포함하지 않는다" },
];

/**
 * **다른 Claude Code 세션이 소유한 경로 — 봉인된 자식에게 귀속할 수 없다.**
 *
 * ⚠️ **이것은 허용목록이 아니다.** `TIER2_CHURN_ALLOWLIST_SEALED_LIVE`는 "봉인된 자식이
 * 실제로 일으킨 churn(AC-0.11 실측)"이라는 뜻이고, 여기 있는 경로는 **자식이 일으킨 것이
 * 아니다.** 같은 목록에 넣으면 "실측된 자식 churn"이라는 의미가 오염되고, 다음 사람이 그
 * 목록을 근거로 판단할 때 틀린다(안전 원칙 7 — 다른 상태를 뭉개지 않는다).
 *
 * **왜 필요한가 (2026-08-24 실측).** 트리 감사는 `CLAUDE_CONFIG_DIR` 전체를 창(window) 전후로
 * 비교하는데, 그 디렉터리는 **봉인된 자식만의 것이 아니다** — 동시에 살아 있는 어떤 Claude
 * Code 세션이든 자기 트랜스크립트와 훅 상태를 계속 쓴다. 그래서 감사는 "봉인 세션이 바꿨다"고
 * 보고하지만 실제로 아는 것은 "누군가 바꿨다"뿐이다. **범위는 충분한데 축이 어긋난다.**
 *
 * 서로 다른 두 경로에서 두 번 확인했다:
 * - Claude Code 세션 **안**에서 `gen` 실행 → `hooks/state/<부모 세션 uuid>.start` 위반
 * - Claude Code 세션 **밖**에서 실행하되 대화를 계속함 → `projects/<프로젝트>/<부모 세션
 *   uuid>.jsonl` 위반. 부모를 완전히 종료하자 둘 다 사라졌다
 *
 * **⚠️ 이 목록만으로는 부족하다 — 반드시 "before에 이미 있던 세션"에만 적용한다.**
 * 보안 재심(2026-08-24) 지적: 경로 **모양**만 보고 제외하면 그 모양의 파일이 **새로 생겨도**
 * 사라진다. 그런데 봉인 안에서 `hooks/state/<uuid>.start`가 **새로 생기는 것**은 세션 상태가
 * 아니라 **훅이 실행됐다는 증거**이고, `projects/<봉인 cwd>/<uuid>.jsonl`이 새로 생기는 것은
 * 자식이 세션을 영속했다는 증거다 — 둘 다 봉인 파손의 1차 신호다. 그래서 판정은
 * `gen/tree-audit.ts`가 **before에서 관측된 세션 uuid 집합**으로 좁히고, 신규 uuid는 위반으로
 * 남긴다. 이 목록은 "어떤 경로가 세션 이름 공간에 속하는가"만 정의한다.
 *
 * **잔여 위험(정정).** 트랜스크립트는 비활성 로그가 아니라 **`ctk measure`의 신뢰되지 않은
 * 입력**이다 — 위조되면 ① tool_result 원문이 `count_tokens`로 오프머신 전송되고
 * ② `assertNoRawPathLeaks`를 유발해 이후 모든 `measure`를 중단시킬 수 있으며(fail-closed DoS)
 * ③ 사용량 집계를 오염시킨다(안전 원칙 8). 처음에 "대화 로그라 위협도가 낮다"고 적었던 것은
 * 낙관적이었다. 신규 생성이 다시 잡히므로 위험의 대부분은 닫히고, 남는 것은 **기존 파일
 * 덮어쓰기**이며 그것은 append 단조성 검사가 담당한다.
 *
 * **범위를 UUID 모양까지 고정한다.** `^projects/` 같은 넓은 패턴을 쓰면 그 아래 무엇이 바뀌어도
 * 통과하고, 그때부터 이 축은 아무것도 막지 못한다(Pre-mortem H — 허용목록의 반사적 확장).
 */
const SESSION_UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

export const SESSION_OWNED_NOT_ATTRIBUTABLE: readonly AllowlistRule[] = [
  {
    // projects/<프로젝트 디렉터리 1단>/<세션 uuid>.jsonl — 다른 세션의 트랜스크립트.
    pattern: new RegExp(`^projects/-[^/]*/${SESSION_UUID}\\.jsonl$`),
    note: "2026-08-24 실측 — 살아 있는 다른 Claude Code 세션이 갱신하는 트랜스크립트. 자식은 --no-session-persistence로 쓰지 않는다",
  },
  {
    // projects/<프로젝트>/<세션 uuid>/** — 그 세션의 서브에이전트 트랜스크립트가 여기 산다
    // (E0.6 실측: 서브에이전트는 메인 세션 파일이 아니라 subagents/agent-*.jsonl에 따로 쌓인다).
    // ⚠️ 디렉터리 이름이 **세션 uuid**여야만 매치한다 — `^projects/`로 넓히면 그 아래 무엇이
    // 바뀌어도 통과한다. 자식은 세션을 영속하지 않으므로 이 이름 공간에 참여하지 않는다.
    pattern: new RegExp(`^projects/-[^/]*/${SESSION_UUID}/`),
    note: "2026-08-24 실측 — 다른 세션의 서브에이전트 트랜스크립트(subagents/agent-*.jsonl · .meta.json)",
  },
  {
    exact: ".session-stats.json",
    note: "2026-08-24 실측 — 하네스가 세션 uuid를 키로 갱신하는 세션 통계. 설정이 아니다",
  },
  {
    // hooks/state/<세션 uuid>.start — 세션별 훅 상태(정의가 아니다).
    pattern: new RegExp(`^hooks/state/${SESSION_UUID}\\.start$`),
    note: "2026-08-24 실측 — 하네스가 세션별로 쓰고 지우는 훅 **상태** 파일(그 디렉터리 167개 전부 .start 하나뿐이었다). 훅 정의(settings.json)는 그대로 감시된다",
  },
];

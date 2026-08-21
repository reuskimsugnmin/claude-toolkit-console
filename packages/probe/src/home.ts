import { homedir } from "node:os";
import path from "node:path";

/**
 * probe/src/home.ts — 모든 경로 접근의 단일 관문(P0-2, plan §4.1 Step 2).
 *
 * `CTK_HOME`(= `$HOME` 대체)과 `CTK_CONFIG_DIR`(= 기본 `$CTK_HOME/.claude`)를 별개 상수로
 * 노출한다. 어떤 다른 코드도 `os.homedir()`를 직접 부르지 않는다 — 이 모듈에서만 호출한다.
 *
 * 환경변수가 설정되지 않으면(프로덕션 `ctk scan` 실행 시) 실제 홈으로 자연스럽게 귀결된다.
 * 테스트(`ctk_isolate` 상당의 격리)는 `CTK_HOME`/`CTK_CONFIG_DIR`을 임시 디렉터리로 지정해
 * 오버라이드한다 — 이것이 `test-isolated` 프로파일이 "인증 불요 테스트"와 "인증 불요 프로덕션
 * 호출(예: `plugin list --json`)" 양쪽에 쓰이는 이유다(§1.3 결정 6, Step 2 지시사항).
 *
 * 값을 모듈 로드 시점에 한 번만 계산하지 않는다 — 함수로 노출해 매 호출 시 현재 `process.env`를
 * 반영한다(테스트가 같은 프로세스 안에서 env를 바꿔가며 여러 번 격리를 걸 수 있어야 한다).
 *
 * ⚠️ **Step 5 보안 심사 수정(H5)** — `spawnClaude()`(harness/seal-profiles.ts)가 항상
 * `CLAUDE_CONFIG_DIR`을 자식 프로세스에 주입하던 이전 구현은 프로덕션에서 두 가지 사고를
 * 냈다: ① `probe`(이 프로세스)와 자식 `claude` 서브프로세스가 서로 다른 `.claude.json`을 보게
 * 되어 감사·검증이 "틀린 세계"를 실측했고, ② 실사용자 `~/.claude`엔 애초에 `.claude.json`이
 * 없는데 자식이 그 파일을 새로 만들어버려 첫 실행이 항상 감사 위반으로 떨어졌다(실측,
 * docs/harness-facts.md). 결정(승인됨): **`CTK_CONFIG_DIR`이 명시적으로 설정됐을 때만**
 * `CLAUDE_CONFIG_DIR`을 주입하고 `.claude.json`도 그 안을 본다 — 격리 테스트가 이 값을 명시
 * 설정한다. 프로덕션(미설정)에서는 `HOME`만 고정하고 자식이 `$HOME/.claude`로 자연스럽게
 * 기본값을 잡게 둔다 — 이 값은 이미 `ctkConfigDir`의 기본값과 동일하므로(아래) probe가 읽는
 * 세계와 자식이 쓰는 세계가 항상 같다.
 */
export interface HomeContext {
  readonly ctkHome: string;
  readonly ctkConfigDir: string;
  /** true면 `CTK_CONFIG_DIR`이 env로 명시됐다(격리 테스트 전용, H5). 이때만 자식 프로세스에
   * `CLAUDE_CONFIG_DIR`을 주입하고 `claudeJsonPath()`도 `ctkConfigDir` 안을 본다. false(프로덕션
   * 기본 경로)면 자식 프로세스도 `.claude.json`도 `$HOME` 기준 실사용자 환경과 동일한 것을 본다. */
  readonly configDirExplicit: boolean;
}

export function resolveHomeContext(env: NodeJS.ProcessEnv = process.env): HomeContext {
  const ctkHome = env.CTK_HOME && env.CTK_HOME.length > 0 ? env.CTK_HOME : homedir();
  const configDirExplicit = Boolean(env.CTK_CONFIG_DIR && env.CTK_CONFIG_DIR.length > 0);
  const ctkConfigDir = configDirExplicit ? env.CTK_CONFIG_DIR! : path.join(ctkHome, ".claude");
  return { ctkHome, ctkConfigDir, configDirExplicit };
}

/**
 * `~/.claude.json` 경로. `configDirExplicit`이 아니면 `.claude/`(CTK_CONFIG_DIR) 밖, HOME 바로
 * 아래에 있다(실측, 프로덕션 기본 경로). `configDirExplicit`이면(격리 테스트) `CLAUDE_CONFIG_DIR`
 * 안으로 옮겨간다(실측, docs/harness-facts.md — "CLAUDE_CONFIG_DIR을 명시하면 .claude.json이
 * $HOME 루트가 아니라 그 디렉터리 안에 생긴다").
 */
export function claudeJsonPath(ctx: HomeContext): string {
  return ctx.configDirExplicit ? path.join(ctx.ctkConfigDir, ".claude.json") : path.join(ctx.ctkHome, ".claude.json");
}

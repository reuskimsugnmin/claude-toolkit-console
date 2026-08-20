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
 */
export interface HomeContext {
  readonly ctkHome: string;
  readonly ctkConfigDir: string;
}

export function resolveHomeContext(env: NodeJS.ProcessEnv = process.env): HomeContext {
  const ctkHome = env.CTK_HOME && env.CTK_HOME.length > 0 ? env.CTK_HOME : homedir();
  const ctkConfigDir =
    env.CTK_CONFIG_DIR && env.CTK_CONFIG_DIR.length > 0 ? env.CTK_CONFIG_DIR : path.join(ctkHome, ".claude");
  return { ctkHome, ctkConfigDir };
}

/** `~/.claude.json` 경로 — `.claude/`(CTK_CONFIG_DIR) 밖, HOME 바로 아래에 있다(실측). */
export function claudeJsonPath(ctx: HomeContext): string {
  return path.join(ctx.ctkHome, ".claude.json");
}

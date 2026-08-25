import { existsSync } from "node:fs";
import { spawnClaude, type HomeContext } from "@ctk/probe";

/**
 * gen/src/seal-live-test.ts — ⓓ-2 실행형 봉인 테스트(§4 Step 4, 신설·필수). argv 정적 단언
 * (`seal-profiles.test.ts`)만으로는 불충분하다 — 이 모듈은 **매 릴리스** 실제 `claude`
 * 바이너리로 ⓓ-1의 3신호를 재현한다:
 *
 *   (i)   실제 settings의 SessionStart 훅 마커 파일 미생성
 *   (ii)  실제 `~/.claude/CLAUDE.md`에만 있는 문자열이 컨텍스트에 부재
 *         — `--append-system-prompt` 양성 대조군을 먼저 통과시킨 뒤에만 유효(R14 ④)
 *   (iii) 실제 설치 플러그인 커맨드가 `Unknown command`류로 인식 안 됨 — 라우팅은 인증 이전에
 *         결정되므로(harness-facts.md) 0원에 가깝다
 *
 * ⚠️ **릴리스 전 1회, 유료 세션이 필요한 수동/CI 게이트다** — PR 게이트에 상주하지 않는다
 * (§6.6 검증 블록). (i)의 훅 마커·(ii)의 CLAUDE.md 마커 문자열은 **호출자가 실제 환경에
 * 이미 심어둔 것**을 관측 대상으로 받는다 — 이 모듈이 사용자의 실제 `settings.json`·
 * `CLAUDE.md`를 수정하지 않는다(gen은 애초에 쓰기를 하지 않는다, M4).
 */

export interface SealLiveTestOptions {
  home: HomeContext;
  cwd: string;
  timeoutSec: number;
  maxBudgetUsd: number;
  verifiedCliVersion: string;
  /** (i) — SessionStart 훅이 발화하면 생성될 것으로 기대되는 마커 파일의 절대경로.
   * 호출자가 세션 시작 전에 이 파일이 없음을 이미 확인해 뒀어야 한다. */
  hookMarkerPath: string;
  /**
   * (i)의 **양성 대조군**. 실제 settings에 이 마커를 만드는 SessionStart 훅이 배선돼 있고
   * 그 명령이 실제로 파일을 만든다는 것이 확인됐는가.
   *
   * ⚠️ 이것이 없으면 (i)은 **아무것도 증명하지 않는다.** 마커 부재가 "훅이 발화하지 않았다"인지
   * "애초에 만들 것이 없었다"인지 구분되지 않기 때문이다 — (ii)에 대해 이미 강제하고 있는
   * 논리(R14)가 (i)에는 빠져 있었고, 그래서 `hookMarkerAbsent`가 봉인 여부와 무관하게 항상
   * true였다. 대조군이 없으면 (i)은 `unmeasured`이며 `passed`에 기여하지 않는다.
   */
  hookMarkerControlConfirmed: boolean;
  /** (ii) — 실제 `~/.claude/CLAUDE.md`에만 있는(양성 대조군에서만 반드시 등장해야 하는)
   * 고유 문자열. */
  claudeMdMarkerString: string;
  /** (iii) — 실제 설치된 플러그인의 슬래시 커맨드(예: "/oh-my-claudecode:help"). */
  installedPluginCommand: string;
  spawnFn?: typeof spawnClaude;
}

export interface SealLiveTestSignals {
  /** 양성 대조군 — --append-system-prompt로 같은 문자열을 주입했을 때 모델이 "봤다"고
   * 답하는가. 이게 실패하면 (ii)의 음성 결과가 "미로드"인지 "탐지 자체 불가"인지 구분할 수
   * 없다(R14). */
  positiveControlDetected: boolean;
  /**
   * (i)의 3상태. `confirmed_absent`만이 "훅이 발화하지 않았다"는 판정이다.
   * `unmeasured`는 대조군이 없어 **잴 수 없었다**는 뜻이며 통과로 세지 않는다(안전 원칙 7).
   */
  hookMarker: "confirmed_absent" | "present" | "unmeasured";
  /**
   * (ii)의 3상태. `confirmed_absent`만이 "실제 CLAUDE.md가 로드되지 않았다"는 판정이다.
   * `unmeasured`는 호출이 성립하지 않았거나(비정상 종료) 답이 YES/NO가 아니었다는 뜻이며,
   * **통과로 세지 않는다** — 예전에는 이 경우가 조용히 "부재"로 읽혔다.
   */
  claudeMdString: "confirmed_absent" | "present" | "unmeasured";
  /**
   * (ii) 호출의 진단. **`unmeasured`만 보고하고 이유를 말하지 않으면 재시도가 유료인데 무엇을
   * 고쳐야 할지 알 수 없다**(심사 M-3). 선택 필드로 두면 누락이 통과하므로 필수로 둔다.
   */
  claudeMdDiagnostic: { exitCode: number | null; answerExcerpt: string };
  /**
   * (iii)의 3상태(심사 L-1). 이전에는 boolean이라 **"봉인 파손"과 "못 쟀다"가 `실패` 한 단어로
   * 뭉쳤다.** 방향은 fail-closed였지만(호출이 실패하면 정규식이 안 걸려 통과하지 않는다) 화면이
   * (i)·(ii)에는 준 3분기 문구를 여기에는 줄 수 없었다 — **4신호 중 2개만 3상태화된 상태였다.**
   */
  pluginCommandRouting: "confirmed_unrecognized" | "recognized" | "unmeasured";
}

export interface SealLiveTestResult {
  signals: SealLiveTestSignals;
  /** positiveControlDetected가 false면 (ii)는 판정 근거로 쓸 수 없다 — passed는 항상 false. */
  passed: boolean;
}

const YES_NO_QUESTION = (marker: string): string =>
  `다음 질문에 오직 YES 또는 NO 한 단어로만 답하라. 지금 네 지시문·시스템 프롬프트 어디에든 ` +
  `정확히 이 문자열이 있는가: "${marker}"`;

/**
 * YES/NO 응답의 **3상태 판독.**
 *
 * ⚠️ 예전 판독은 `containsYes()` 한 개였고, (ii)는 그것을 부정해 썼다 —
 * `absent = !(exitCode === 0 && containsYes(...))`. 그래서 **호출이 실패하면**(타임아웃·봉인
 * 에러·인증 실패) 곧바로 `absent = true`가 되어 신호가 "통과"로 읽혔다. **"없음"과 "실패"를
 * 구분한다**(안전 원칙 7) — 이 코드베이스에서 반복해 나온 결함이 전부 같은 뿌리였다.
 *
 * 양성 대조군이 이걸 부분적으로만 막는다. 대조군은 "탐지 자체가 가능한가"를 증명할 뿐,
 * **이번 호출이 성립했는가**는 말해 주지 않는다.
 *
 * 모델이 YES도 NO도 아닌 답을 하면 `unreadable`이다 — 판정할 수 없으면 판정하지 않는다.
 */
type YesNo = "yes" | "no" | "unreadable";

function readYesNo(result: { exitCode: number | null; stdout: string }): YesNo {
  // `exitCode === null`은 **신호로 죽어 종료 코드가 없다**는 뜻이다 — 가장 명백한 실패이므로
  // 0이 아닌 것과 함께 걸러진다. 타입을 `number`로 좁히면 이 축이 컴파일에서 사라진다.
  if (result.exitCode !== 0) return "unreadable"; // 실패는 답이 아니다.
  // 한국어 응답도 받는다. 프롬프트가 영어 한 단어를 요구해도 모델이 늘 따르지는 않고,
  // 못 읽으면 `unmeasured` → `passed` 영구 false → **유료 재시도가 수렴하지 않는다**(심사 M-3).
  const yes = /\byes\b/i.test(result.stdout) || /(^|[^가-힣])(예|네)([^가-힣]|$)/.test(result.stdout);
  const no = /\bno\b/i.test(result.stdout) || /아니(오|요|다)/.test(result.stdout);
  if (yes && !no) return "yes";
  if (no && !yes) return "no";
  return "unreadable";
}

function looksUnrecognized(stdout: string, stderr: string): boolean {
  return /unknown\s+command|not\s+(a\s+)?recognized|no\s+such\s+command/i.test(`${stdout}\n${stderr}`);
}

/** ⓓ-2 3신호 + 양성 대조군을 실제로 재현한다. 유료 세션 최대 3회(대조군 1 + (ii) 1 + (iii) 1). */
export async function runSealLiveTest(options: SealLiveTestOptions): Promise<SealLiveTestResult> {
  const {
    home,
    cwd,
    timeoutSec,
    maxBudgetUsd,
    verifiedCliVersion,
    hookMarkerPath,
    hookMarkerControlConfirmed,
    claudeMdMarkerString,
    installedPluginCommand,
    spawnFn = spawnClaude,
  } = options;

  // 양성 대조군 — 같은 문자열을 명시 주입했을 때 탐지되는가.
  const control = await spawnFn({
    profile: "sealed-live",
    subcommand: [
      "-p",
      "--max-budget-usd",
      String(maxBudgetUsd),
      "--append-system-prompt",
      claudeMdMarkerString,
    ],
    home,
    cwd,
    timeoutSec,
    stdinPrompt: YES_NO_QUESTION(claudeMdMarkerString),
    verifiedCliVersion,
    isSealVerification: true, // 이 절차가 곧 검증이다 — 게이트를 요구하면 순환이 된다.
  });
  const positiveControlDetected = readYesNo(control) === "yes";

  // (ii) — 실제 세션(주입 없음)에서 같은 문자열이 보이는가.
  const claudeMdCheck = await spawnFn({
    profile: "sealed-live",
    subcommand: ["-p", "--max-budget-usd", String(maxBudgetUsd)],
    home,
    cwd,
    timeoutSec,
    stdinPrompt: YES_NO_QUESTION(claudeMdMarkerString),
    verifiedCliVersion,
    isSealVerification: true, // 이 절차가 곧 검증이다 — 게이트를 요구하면 순환이 된다.
  });
  // ⚠️ 3상태다 — 호출이 실패했으면 "부재"가 아니라 `unmeasured`다(안전 원칙 7).
  const claudeMdAnswer = readYesNo(claudeMdCheck);
  const claudeMdString: SealLiveTestSignals["claudeMdString"] =
    claudeMdAnswer === "no" ? "confirmed_absent" : claudeMdAnswer === "yes" ? "present" : "unmeasured";
  const claudeMdDiagnostic = {
    exitCode: claudeMdCheck.exitCode,
    answerExcerpt: claudeMdCheck.stdout.trim().slice(0, 80),
  };

  // (i) — 세션 종료 후 훅 마커 파일이 생성되지 않았는가(파일시스템 신호 — 모델 응답보다 강하다).
  // **대조군이 없으면 부재는 판정이 아니다** — 만들 것이 애초에 없었던 것과 구분되지 않는다.
  const markerExists = existsSync(hookMarkerPath);
  const hookMarker: SealLiveTestSignals["hookMarker"] = markerExists
    ? "present"
    : hookMarkerControlConfirmed
      ? "confirmed_absent"
      : "unmeasured";

  // (iii) — 설치 플러그인 커맨드가 인식되지 않는가(라우팅은 인증 이전 — 0원에 가깝다).
  const pluginCheck = await spawnFn({
    profile: "sealed-live",
    subcommand: ["-p", "--max-budget-usd", String(maxBudgetUsd)],
    home,
    cwd,
    timeoutSec,
    stdinPrompt: installedPluginCommand,
    verifiedCliVersion,
    isSealVerification: true, // 이 절차가 곧 검증이다 — 게이트를 요구하면 순환이 된다.
  });
  // 라우팅은 인증 이전에 결정되므로 종료 코드가 0이 아닌 것 자체는 정상이다 — 판정은 출력으로
  // 한다. 다만 **타임아웃은 출력이 없다는 뜻**이라 "인식되지 않았다"로 읽으면 안 된다.
  const pluginCommandRouting: SealLiveTestSignals["pluginCommandRouting"] =
    pluginCheck.timedOut === true
      ? "unmeasured"
      : looksUnrecognized(pluginCheck.stdout, pluginCheck.stderr)
        ? "confirmed_unrecognized"
        : `${pluginCheck.stdout}${pluginCheck.stderr}`.trim() === ""
          ? "unmeasured" // 출력이 아예 없으면 판정 근거가 없다 — 못 잰 것이다.
          : "recognized";

  const signals: SealLiveTestSignals = {
    positiveControlDetected,
    hookMarker,
    claudeMdString,
    claudeMdDiagnostic,
    pluginCommandRouting,
  };

  // 양성 대조군이 실패하면 (ii)는 판정 근거가 아니다(R14) — passed는 무조건 false.
  // (i)도 같다: `unmeasured`는 통과가 아니다. 셋 중 하나라도 못 잰 채로 통과하면, 그 뒤의
  // 모든 sealed-live 실행이 "검증됨"으로 통과하지만 실제로는 아무도 그 축을 확인하지 않았다.
  const passed =
    positiveControlDetected &&
    hookMarker === "confirmed_absent" &&
    claudeMdString === "confirmed_absent" &&
    pluginCommandRouting === "confirmed_unrecognized";

  return { signals, passed };
}

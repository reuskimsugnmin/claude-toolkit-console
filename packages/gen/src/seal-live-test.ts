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
  hookMarkerAbsent: boolean;
  claudeMdStringAbsent: boolean;
  installedPluginCommandUnrecognized: boolean;
}

export interface SealLiveTestResult {
  signals: SealLiveTestSignals;
  /** positiveControlDetected가 false면 (ii)는 판정 근거로 쓸 수 없다 — passed는 항상 false. */
  passed: boolean;
}

const YES_NO_QUESTION = (marker: string): string =>
  `다음 질문에 오직 YES 또는 NO 한 단어로만 답하라. 지금 네 지시문·시스템 프롬프트 어디에든 ` +
  `정확히 이 문자열이 있는가: "${marker}"`;

function containsYes(stdout: string): boolean {
  return /\byes\b/i.test(stdout) && !/\bno\b/i.test(stdout);
}

function looksUnrecognized(stdout: string, stderr: string): boolean {
  return /unknown\s+command|not\s+(a\s+)?recognized|no\s+such\s+command/i.test(`${stdout}\n${stderr}`);
}

/** ⓓ-2 3신호 + 양성 대조군을 실제로 재현한다. 유료 세션 최대 3회(대조군 1 + (ii) 1 + (iii) 1). */
export async function runSealLiveTest(options: SealLiveTestOptions): Promise<SealLiveTestResult> {
  const { home, cwd, timeoutSec, maxBudgetUsd, verifiedCliVersion, hookMarkerPath, claudeMdMarkerString, installedPluginCommand, spawnFn = spawnClaude } = options;

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
  });
  const positiveControlDetected = control.exitCode === 0 && containsYes(control.stdout);

  // (ii) — 실제 세션(주입 없음)에서 같은 문자열이 보이는가.
  const claudeMdCheck = await spawnFn({
    profile: "sealed-live",
    subcommand: ["-p", "--max-budget-usd", String(maxBudgetUsd)],
    home,
    cwd,
    timeoutSec,
    stdinPrompt: YES_NO_QUESTION(claudeMdMarkerString),
    verifiedCliVersion,
  });
  const claudeMdStringAbsent = !(claudeMdCheck.exitCode === 0 && containsYes(claudeMdCheck.stdout));

  // (i) — 세션 종료 후 훅 마커 파일이 생성되지 않았는가(파일시스템 신호 — 모델 응답보다 강하다).
  const hookMarkerAbsent = !existsSync(hookMarkerPath);

  // (iii) — 설치 플러그인 커맨드가 인식되지 않는가(라우팅은 인증 이전 — 0원에 가깝다).
  const pluginCheck = await spawnFn({
    profile: "sealed-live",
    subcommand: ["-p", "--max-budget-usd", String(maxBudgetUsd)],
    home,
    cwd,
    timeoutSec,
    stdinPrompt: installedPluginCommand,
    verifiedCliVersion,
  });
  const installedPluginCommandUnrecognized = looksUnrecognized(pluginCheck.stdout, pluginCheck.stderr);

  const signals: SealLiveTestSignals = {
    positiveControlDetected,
    hookMarkerAbsent,
    claudeMdStringAbsent,
    installedPluginCommandUnrecognized,
  };

  // 양성 대조군이 실패하면 (ii)는 판정 근거가 아니다(R14) — passed는 무조건 false.
  const passed =
    positiveControlDetected && hookMarkerAbsent && claudeMdStringAbsent && installedPluginCommandUnrecognized;

  return { signals, passed };
}

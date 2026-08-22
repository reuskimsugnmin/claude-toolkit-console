import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runSealLiveTest, type SealLiveTestResult } from "@ctk/gen";
import { resolveHomeContext } from "@ctk/probe";
import { detectClaudeVersion } from "./init.js";
import { readCatalogConfig, writeCatalogConfig } from "@ctk/sync";
import { readLocalConfig } from "../local-config.js";
import { CatalogNotInitializedError } from "./scan.js";
import { MissingRequiredFlagError } from "./gen.js";
import { ensureSealedLiveCwd } from "../sealed-cwd.js";

/**
 * cli/src/commands/verify-seal.ts — `ctk verify seal`.
 *
 * **프리플라이트 버전 게이트(B5)의 유일한 복구 경로다.** `claude`는 자동 업데이트되므로
 * 카탈로그에 기록된 `verified_cli_version`은 언젠가 반드시 낡는다. 그때 `sealed-live`는
 * `seal_unverified_cli`로 실행을 거부하는데, 여기서 멈추기만 하면 게이트가 "항상 거부"가 되고
 * 그러면 사용자는 게이트를 우회하는 법부터 찾는다 — 가드가 무력화되는 전형적 경로다.
 *
 * 그래서 복구는 **버전 숫자를 바꾸는 것이 아니라 봉인을 다시 증명하는 것**이어야 한다.
 * 이 명령은 ⓓ-2의 3신호(+양성 대조군)를 새 CLI 버전에서 실제로 재현하고, **전부 통과했을 때만**
 * `verified_cli_version`을 갱신한다. 실패하면 아무것도 쓰지 않는다 — 봉인이 깨진 채로
 * 기록만 갱신되면 그 뒤의 모든 실행이 근거 없이 통과한다.
 */

export interface RunVerifySealOptions {
  maxBudgetUsd?: number;
  timeoutSec?: number;
  /** 실제 설치된 플러그인의 슬래시 커맨드 — (iii) 신호의 입력. */
  installedPluginCommand?: string;
}

export interface VerifySealReport {
  previousVerifiedVersion: string;
  actualVersion: string;
  result: SealLiveTestResult;
  updated: boolean;
}

export class MissingClaudeMdError extends Error {
  constructor(p: string) {
    super(
      `양성 대조군에 쓸 \`${p}\`가 없다 — (ii) 신호의 음성 결과가 "미로드"인지 "탐지 불가"인지 ` +
        `구분할 수 없으므로 판정하지 않는다(R14).`,
    );
    this.name = "MissingClaudeMdError";
  }
}

/** 실제 `~/.claude/CLAUDE.md`에서 (ii) 신호용 고유 문자열을 뽑는다. */
function pickClaudeMdMarker(claudeMdPath: string): string {
  const lines = readFileSync(claudeMdPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 24 && !l.startsWith("#") && !l.startsWith("-"));
  const picked = lines[Math.floor(lines.length / 2)] ?? lines[0];
  if (picked === undefined) throw new MissingClaudeMdError(claudeMdPath);
  return picked.slice(0, 60);
}

export async function runVerifySeal(options: RunVerifySealOptions): Promise<VerifySealReport> {
  if (options.maxBudgetUsd === undefined) throw new MissingRequiredFlagError("--max-budget-usd");
  if (options.timeoutSec === undefined) throw new MissingRequiredFlagError("--timeout-sec");
  if (options.installedPluginCommand === undefined) {
    throw new MissingRequiredFlagError("--installed-plugin-command");
  }

  const home = resolveHomeContext();
  const localConfig = readLocalConfig(home);
  if (localConfig === null) throw new CatalogNotInitializedError();
  const catalogPath = localConfig.catalog_path;
  const catalogConfig = readCatalogConfig(catalogPath);
  if (catalogConfig === null) throw new CatalogNotInitializedError();

  const cwd = ensureSealedLiveCwd();
  const actualVersion = await detectClaudeVersion(cwd);

  const claudeMdPath = path.join(home.ctkConfigDir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) throw new MissingClaudeMdError(claudeMdPath);

  const result = await runSealLiveTest({
    home,
    cwd,
    timeoutSec: options.timeoutSec,
    maxBudgetUsd: options.maxBudgetUsd,
    verifiedCliVersion: catalogConfig.verified_cli_version,
    // 훅 마커는 이 시점에 존재하지 않아야 한다 — 세션이 만들면 (i) 실패다.
    hookMarkerPath: path.join(cwd, ".ctk-seal-hook-marker"),
    claudeMdMarkerString: pickClaudeMdMarker(claudeMdPath),
    installedPluginCommand: options.installedPluginCommand,
  });

  // ⚠️ 통과했을 때만 기록을 갱신한다. 실패한 채로 버전만 올리면 그 뒤의 모든 sealed-live
  // 실행이 "검증됨"으로 통과하지만 실제로는 아무도 봉인을 확인하지 않은 상태가 된다.
  if (result.passed) {
    writeCatalogConfig(catalogPath, { ...catalogConfig, verified_cli_version: actualVersion });
  }

  return {
    previousVerifiedVersion: catalogConfig.verified_cli_version,
    actualVersion,
    result,
    updated: result.passed,
  };
}

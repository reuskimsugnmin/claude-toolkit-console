import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { collectPlugins, collectSkills, type HomeContext, type spawnClaude } from "@ctk/probe";
import type { Installation, InstallScope } from "@ctk/core";

/**
 * actuator/src/verify.ts — **`probe`를 재실행한 실측으로만** 성공을 판정한다(journal 기록을
 * 근거로 쓰지 않는다). "명령이 성공했다"는 종료 코드 기록이 아니라 실제 상태를 다시 읽어
 * 확인한다(CLAUDE.md: 플러그인 자동 갱신이 비활성 상태를 되돌릴 수 있으므로 기록만으로 현재
 * 상태를 단정하지 않는다).
 */

export class VerifyMismatchError extends Error {
  readonly failureClass = "verify_mismatch" as const;
  constructor(message: string) {
    super(message);
    this.name = "VerifyMismatchError";
  }
}

function sha256FileOrNull(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

export interface VerifyPluginEnablementMoveOptions {
  assetId: string;
  fromScope: InstallScope;
  toScope: InstallScope;
  /** null이면 "user" 스코프(프로젝트 무관). */
  fromProjectPathHash: string | null;
  toProjectPathHash: string | null;
  installedPluginsAbsPath: string;
  /** 액션 시작 **전에** 캡처해 둔 sha256(존재하지 않았으면 null). */
  installedPluginsShaBefore: string | null;
  home: HomeContext;
  machineId: string;
  cwd: string;
  timeoutSec: number;
  spawnFn?: typeof spawnClaude;
}

export interface VerifyPluginEnablementMoveResult {
  installations: Installation[];
}

/**
 * AC-2.1 재스캔 실측 — ⓐ `enabled_at`이 `fromScope`에 더는 없고 `toScope`에 나타남
 * ⓑ `installed_plugins.json` sha256이 액션 시작 전과 **바이트 동일**(install_scope 무변경의
 * 직접 증거, AC-2.1ⓑⓒ) — 둘 다 실패하면 `verify_mismatch`로 던진다(자동 롤백 트리거, AC-2.6).
 */
export async function verifyPluginEnablementMove(
  options: VerifyPluginEnablementMoveOptions,
): Promise<VerifyPluginEnablementMoveResult> {
  const shaAfter = sha256FileOrNull(options.installedPluginsAbsPath);
  if (shaAfter !== options.installedPluginsShaBefore) {
    throw new VerifyMismatchError(
      `installed_plugins.json sha256이 액션 전후로 달라졌다 — install_scope 무변경 보장이 깨졌다(AC-2.1ⓒ)`,
    );
  }

  const result = await collectPlugins({
    home: options.home,
    machineId: options.machineId,
    cwd: options.cwd,
    timeoutSec: options.timeoutSec,
    spawnFn: options.spawnFn,
  });

  const movedToTarget = result.installations.some(
    (i) =>
      i.asset_id === options.assetId &&
      i.enabled_at === options.toScope &&
      i.project_path_hash === options.toProjectPathHash,
  );
  if (!movedToTarget) {
    throw new VerifyMismatchError(
      `재스캔에서 asset_id=${options.assetId}가 enabled_at=${options.toScope}로 전이된 레코드를 찾지 못했다`,
    );
  }

  const stillAtSource = result.installations.some(
    (i) =>
      i.asset_id === options.assetId &&
      i.enabled_at === options.fromScope &&
      i.project_path_hash === options.fromProjectPathHash,
  );
  if (stillAtSource) {
    throw new VerifyMismatchError(
      `재스캔에서 asset_id=${options.assetId}가 여전히 enabled_at=${options.fromScope}로 남아있다 — disable이 반영되지 않았다`,
    );
  }

  return { installations: result.installations };
}

export interface VerifySkillDirMoveOptions {
  assetId: string;
  fromLocation: "user" | "project";
  toLocation: "user" | "project";
  fromProjectPathHash: string | null;
  toProjectPathHash: string | null;
  destAbs: string;
  home: HomeContext;
  machineId: string;
}

export interface VerifySkillDirMoveResult {
  installations: Installation[];
}

/** AC-2.2 재스캔 실측 — 위치 전이 확인 + 원본 경로 부재(destAbs 존재 자체는 apply 단계가 보장한다). */
export function verifySkillDirMove(options: VerifySkillDirMoveOptions): VerifySkillDirMoveResult {
  if (!existsSync(options.destAbs)) {
    throw new VerifyMismatchError(`이동 대상 디렉터리가 존재하지 않는다: ${options.destAbs}`);
  }

  const result = collectSkills({ home: options.home, machineId: options.machineId });

  const movedToTarget = result.installations.some(
    (i) =>
      i.asset_id === options.assetId &&
      i.enabled_at === options.toLocation &&
      i.project_path_hash === options.toProjectPathHash,
  );
  if (!movedToTarget) {
    throw new VerifyMismatchError(
      `재스캔에서 asset_id=${options.assetId}가 enabled_at=${options.toLocation}로 전이된 레코드를 찾지 못했다`,
    );
  }

  const stillAtSource = result.installations.some(
    (i) =>
      i.asset_id === options.assetId &&
      i.enabled_at === options.fromLocation &&
      i.project_path_hash === options.fromProjectPathHash,
  );
  if (stillAtSource) {
    throw new VerifyMismatchError(
      `재스캔에서 asset_id=${options.assetId}가 여전히 enabled_at=${options.fromLocation}로 남아있다 — 이동 전 위치가 재구성됐다`,
    );
  }

  return { installations: result.installations };
}

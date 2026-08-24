import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_CATALOG_PATH_SEGMENT, parseLocalConfig, type LocalConfig } from "@ctk/core";
import type { HomeContext } from "@ctk/probe";

/**
 * cli/src/local-config.ts — `~/.config/ctk/`(카탈로그 **밖**의 로컬 전용 설정, §1.3 결정 2).
 * `catalog_path`가 사는 유일한 곳이며, 카탈로그 저장소에 커밋되지 않으므로 AC-1.7 위생 검사
 * 대상이 아니다. 계층상 `sync`(카탈로그 쓰기 전담)와 구분되는 "제품 자체의 로컬 설정"이라
 * CLI가 직접 관리한다(probe/sync 어느 쪽 계층 경계에도 속하지 않는다).
 */

function localConfigDir(home: HomeContext): string {
  return path.join(home.ctkHome, ".config", "ctk");
}

function localConfigPath(home: HomeContext): string {
  return path.join(localConfigDir(home), "config.json");
}

export function defaultCatalogPath(home: HomeContext): string {
  return path.join(home.ctkHome, DEFAULT_CATALOG_PATH_SEGMENT);
}

export function readLocalConfig(home: HomeContext): LocalConfig | null {
  const p = localConfigPath(home);
  if (!existsSync(p)) return null;
  return parseLocalConfig(JSON.parse(readFileSync(p, "utf8")) as unknown);
}

export function writeLocalConfig(home: HomeContext, config: LocalConfig): void {
  mkdirSync(localConfigDir(home), { recursive: true });
  writeFileSync(localConfigPath(home), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** `~/.config/ctk/machine.json` — 이 머신의 machine_id + alias(로컬 전용, 카탈로그 밖). */
export interface LocalMachineIdentity {
  machine_id: string;
  alias: string;
}

function machineIdentityPath(home: HomeContext): string {
  return path.join(localConfigDir(home), "machine.json");
}

/**
 * 머신 정체를 **읽기만** 한다 — 없으면 `null`이고 만들지 않는다.
 *
 * ⚠️ `readOrCreateMachineIdentity`는 이름 그대로 없으면 **쓴다.** 조회 경로(웹 견적 등)에서
 * 그것을 부르면 단순 조회가 사용자 설정 디렉터리에 파일을 만든다 — 읽기와 쓰기를 한 모듈에
 * 섞지 않는다는 이 저장소의 계층 원칙이 함수 단위에서도 그대로 적용된다.
 */
export function readMachineIdentityOrNull(home: HomeContext): LocalMachineIdentity | null {
  const p = machineIdentityPath(home);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LocalMachineIdentity;
  } catch {
    return null; // 손상된 파일 — "없음"으로 다루되 조용히 새로 만들지는 않는다.
  }
}

export function readOrCreateMachineIdentity(home: HomeContext, defaultAlias: string): LocalMachineIdentity {
  const p = machineIdentityPath(home);
  if (existsSync(p)) {
    return JSON.parse(readFileSync(p, "utf8")) as LocalMachineIdentity;
  }
  const identity: LocalMachineIdentity = { machine_id: randomUUID(), alias: defaultAlias };
  mkdirSync(localConfigDir(home), { recursive: true });
  writeFileSync(p, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  return identity;
}

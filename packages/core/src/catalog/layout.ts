import type { AssetKind } from "../schema/asset.js";

/**
 * 카탈로그 저장소 경로 규약 — §1.3 결정 2를 단일 상수로 고정한다. actuator의 lint 규칙
 * (`카탈로그 저장소 경로 리터럴 사용 금지`, P1-5)이 이 모듈을 참조하도록 강제한다.
 *
 * v1은 로컬 전용이다(OQ-1 안 C) — 기본 경로는 `~/.local/share/ctk/catalog`이지만, 실제 값은
 * `~/.config/ctk/config.json`의 `catalog_path`에 기록하며 여기 하드코딩하지 않는다.
 * 이 모듈은 카탈로그 **루트가 주어졌을 때의 하위 경로 규약**만 다룬다(순수 함수, I/O 없음).
 */

export const DEFAULT_CATALOG_PATH_SEGMENT = ".local/share/ctk/catalog" as const;

export function assetDir(kind: AssetKind, name: string): string {
  return `catalog/assets/${kind}/${name}`;
}

export function assetJsonPath(kind: AssetKind, name: string): string {
  return `${assetDir(kind, name)}/asset.json`;
}

export function annotationMdPath(kind: AssetKind, name: string): string {
  return `${assetDir(kind, name)}/annotation.md`;
}

export function usageMdPath(kind: AssetKind, name: string): string {
  return `${assetDir(kind, name)}/usage.md`;
}

export function catalogIndexPath(): string {
  return "catalog/index.json";
}

export function tokenCachePath(): string {
  return "cache/tokens.jsonl";
}

export function machineDir(machineId: string): string {
  return `machines/${machineId}`;
}

export function machineJsonPath(machineId: string): string {
  return `${machineDir(machineId)}/machine.json`;
}

export function snapshotPath(machineId: string, iso8601: string): string {
  return `${machineDir(machineId)}/snapshots/${iso8601}.jsonl`;
}

export function offsetCachePath(machineId: string): string {
  return `${machineDir(machineId)}/cache/offsets.jsonl`;
}

export function runLogPath(machineId: string, iso8601: string): string {
  return `${machineDir(machineId)}/runs/${iso8601}.jsonl`;
}

export function journalPath(iso8601: string): string {
  return `journal/${iso8601}.jsonl`;
}

export function configJsonPath(): string {
  return "ctk.config.json";
}

import type { AssetKind } from "../schema/asset.js";
import { FORBIDDEN_RULES, matchesForbidden } from "../guard/forbidden.js";

/**
 * 카탈로그 저장소 경로 규약 — §1.3 결정 2를 단일 상수로 고정한다. actuator의 lint 규칙
 * (`카탈로그 저장소 경로 리터럴 사용 금지`, P1-5)이 이 모듈을 참조하도록 강제한다.
 *
 * v1은 로컬 전용이다(OQ-1 안 C) — 기본 경로는 `~/.local/share/ctk/catalog`이지만, 실제 값은
 * `~/.config/ctk/config.json`의 `catalog_path`에 기록하며 여기 하드코딩하지 않는다.
 * 이 모듈은 카탈로그 **루트가 주어졌을 때의 하위 경로 규약**만 다룬다(순수 함수, I/O 없음).
 *
 * ⚠️ **Step 5 보안 심사 수정 — 경로 순회 방어를 이 파일 한 곳으로 올린다.** 이전에는 세그먼트
 * (자산 이름·machine_id 등) 검증이 호출부마다 따로 있었고(`sync/asset-store.ts`는 빈 문자열을
 * 허용, `cli/move.ts`는 거부) 서로 다른 두 벌로 발산해 있었다 — 어느 한쪽이라도 빠뜨린 호출부는
 * 무방비였다(실측: `machine.json`은 어느 쪽 가드도 거치지 않고 `core/local-config.ts`가 zod
 * 없이 캐스팅한 `machine_id`를 그대로 `machineDir()`에 보간했다). 지금은 **세그먼트를 받는 모든
 * export가 진입 시 `assertCatalogSegment()`를 거친다** — 호출부가 늘어나도 이 파일만 지키면
 * 자동으로 보호된다. 호출부의 중복 가드는 `eslint-rules/ctk-plugin.js`의
 * `ctk/no-adhoc-path-guard`가 lint로 금지한다.
 */

export const DEFAULT_CATALOG_PATH_SEGMENT = ".local/share/ctk/catalog" as const;

/** 세그먼트가 카탈로그 경로에 안전하게 보간될 수 있는가 — 이 파일의 유일한 판정 관문. */
export class PathTraversalDetectedError extends Error {
  readonly failureClass = "path_traversal_detected" as const;
  constructor(fieldName: string, value: string, note: string) {
    super(`${fieldName}가 금지된 경로 패턴과 일치한다(${note}): ${value}`);
    this.name = "PathTraversalDetectedError";
  }
}

/**
 * 단일 경로 세그먼트(디렉터리/파일명 하나)로 안전한지 검증한다 — 이 파일의 모든
 * export가 세그먼트를 받으면 반드시 이 함수를 거친다(재구현·우회 금지).
 */
export function assertCatalogSegment(fieldName: string, value: string): void {
  if (value.length === 0) {
    throw new PathTraversalDetectedError(fieldName, value, "빈 문자열은 세그먼트로 허용되지 않는다");
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new PathTraversalDetectedError(fieldName, value, "경로 구분자를 포함할 수 없는 단일 세그먼트");
  }
  const forbidden = matchesForbidden(value, FORBIDDEN_RULES);
  if (forbidden) {
    throw new PathTraversalDetectedError(fieldName, value, forbidden.note);
  }
}

export function assetDir(kind: AssetKind, name: string): string {
  assertCatalogSegment("kind", kind);
  assertCatalogSegment("name", name);
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

/** Occupancy 레코드(schema/occupancy.ts) — Asset과 같은 디렉터리에 upsert(Step 3). */
export function occupancyJsonPath(kind: AssetKind, name: string): string {
  return `${assetDir(kind, name)}/occupancy.json`;
}

export function catalogIndexPath(): string {
  return "catalog/index.json";
}

export function tokenCachePath(): string {
  return "cache/tokens.jsonl";
}

export function machineDir(machineId: string): string {
  assertCatalogSegment("machineId", machineId);
  return `machines/${machineId}`;
}

export function machineJsonPath(machineId: string): string {
  return `${machineDir(machineId)}/machine.json`;
}

export function snapshotPath(machineId: string, iso8601: string): string {
  assertCatalogSegment("iso8601", iso8601);
  return `${machineDir(machineId)}/snapshots/${iso8601}.jsonl`;
}

export function offsetCachePath(machineId: string): string {
  return `${machineDir(machineId)}/cache/offsets.jsonl`;
}

export function runLogPath(machineId: string, iso8601: string): string {
  assertCatalogSegment("iso8601", iso8601);
  return `${machineDir(machineId)}/runs/${iso8601}.jsonl`;
}

export function journalPath(iso8601: string): string {
  assertCatalogSegment("iso8601", iso8601);
  return `journal/${iso8601}.jsonl`;
}

export function configJsonPath(): string {
  return "ctk.config.json";
}

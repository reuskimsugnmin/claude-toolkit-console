import { createHash } from "node:crypto";
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

/**
 * ⚠️ **경로 축은 `id`에서 유도한다 — B1 Step 1(2026-08-26).** 이전에는 `assetDir(kind, name)`이
 * `id`를 전혀 쓰지 않았다. 이름이 같고 id가 다른 자산 둘(예: 서로 다른 부모 플러그인에 번들된
 * 동명 스킬)은 다른 인덱스 행을 얻으면서도 같은 디렉터리를 공유했고, `upsertAsset`이 그 경로에
 * 무조건 덮어써 하나만 살아남았다 — "인덱스 중복 id 0건"은 정확히 통과하는 동안 자산이 조용히
 * 사라졌다(플러그인 축에서는 실측 0건이라 발현하지 않았을 뿐 코드는 이미 결함이었다).
 *
 * 처방: 세그먼트를 `<name>__<id의 sha256 앞 8자>`로 만든다. 해시는 **이름이 겹치지 않을 때도
 * 무조건** 붙인다 — 충돌 시에만 붙이면 나중에 두 자산의 id가 겹치는 순간(예: 마켓플레이스가
 * 바뀌어 새 id를 얻는 플러그인) 기존 문서가 전부 고아가 된다. `kind`는 여전히 상위 세그먼트로
 * 쓴다(`catalog/assets/<kind>/<name>__<hash8>`) — 유형별 훑기를 잃지 않는다.
 *
 * `:`·`@`를 세그먼트에 직접 쓰지 않는 이유: git·Windows에서 `:`는 파일명으로 불법이고, plugin
 * id(`name@marketplace`)는 `@`를 포함한다. id는 해시로만 들어가므로 원문의 `:`·`@`·`..`·`/`가
 * 세그먼트에 그대로 나타나는 일이 없다(`assertCatalogSegment`가 그 문자들을 막지 않으므로
 * 이것은 우연이 아니라 해시를 거치는 설계로 보장한다 — 세그먼트 안전 테스트가 못박는다).
 *
 * 기존 `catalog/assets/**`(구 레이아웃)는 `sync/src/migrate-catalog-paths.ts`의 일회성 이전기로
 * 옮긴다. `ctk scan`은 `rebuildCatalogIndex` 전에 반드시 이전기를 먼저 돌린다.
 */
function assetIdSegment(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8);
}

/** `assetDir`가 파생하는 마지막 경로 세그먼트(`<name>__<hash8>`) — 이전기가 기대 경로를 계산할 때도 재사용한다. */
export function assetPathSegment(name: string, id: string): string {
  const segment = `${name}__${assetIdSegment(id)}`;
  assertCatalogSegment("name", segment);
  return segment;
}

export function assetDir(kind: AssetKind, name: string, id: string): string {
  assertCatalogSegment("kind", kind);
  return `catalog/assets/${kind}/${assetPathSegment(name, id)}`;
}

export function assetJsonPath(kind: AssetKind, name: string, id: string): string {
  return `${assetDir(kind, name, id)}/asset.json`;
}

export function annotationMdPath(kind: AssetKind, name: string, id: string): string {
  return `${assetDir(kind, name, id)}/annotation.md`;
}

export function usageMdPath(kind: AssetKind, name: string, id: string): string {
  return `${assetDir(kind, name, id)}/usage.md`;
}

/** Occupancy 레코드(schema/occupancy.ts) — Asset과 같은 디렉터리에 upsert(Step 3). */
export function occupancyJsonPath(kind: AssetKind, name: string, id: string): string {
  return `${assetDir(kind, name, id)}/occupancy.json`;
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

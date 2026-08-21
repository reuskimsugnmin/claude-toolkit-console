/**
 * 두 스냅샷 배열의 diff (CLAUDE.md: "현재 상태와 드리프트는 파생값으로 계산"). 순수 함수 —
 * append-only로 쌓인 레코드 두 장을 놓고 무엇이 늘고 줄었는지만 파생한다.
 */
export interface SnapshotDiff<T> {
  added: T[];
  removed: T[];
  unchanged: T[];
}

export interface DuplicateKeyEntry {
  key: string;
  list: "before" | "after";
}

/**
 * `diffById()`가 `before`/`after`에 동일 키가 2회 이상 등장한 입력을 받으면 던진다 — 실측(Step 2
 * `ctk doctor --drift` 실환경 검증)으로 발견된 갭의 수정: 이전 구현은 `new Map(items.map(keyOf))`로
 * 키를 모으면서 중복을 흔적 없이 last-write-wins로 흡수했다. 그 결과 실제 스캔에서 Installation
 * 191건 중 189건만 "무변경"으로 집계되는 값이 나왔는데(원인: `collectSkills`가 프론트매터 `name`이
 * 서로 충돌하는 두 스킬 디렉터리 각각에 대해 동일한 `(asset_id, install_scope, project_path_hash)`
 * 키를 갖는 Installation을 2건 만듦), 원인 규명 전까지는 "189건"이라는 숫자만으로 그 2건 차이가
 * 실제 드리프트인지 집계 버그인지 판정할 수 없었다. `guard/tree-diff.ts`의
 * `DuplicatePathVerdictError`와 동일한 선례(P2 — 판정 불가는 추정으로 채우지 않는다)를 따라, 여기서도
 * 조용히 하나를 채택하는 대신 판정을 거부한다. 호출자(cli/doctor.ts 등)는 이 오류를
 * `failure_class: "duplicate_snapshot_key"`로 기록해야 한다.
 */
export class DuplicateKeyDiffError extends Error {
  readonly failureClass = "duplicate_snapshot_key" as const;
  readonly duplicates: readonly DuplicateKeyEntry[];

  constructor(duplicates: readonly DuplicateKeyEntry[]) {
    super(
      `diffById()는 중복 키 입력을 판정 불가로 거부한다 (failure_class: duplicate_snapshot_key): ` +
        duplicates.map((d) => `${d.list}:${d.key}`).join(", "),
    );
    this.name = "DuplicateKeyDiffError";
    this.duplicates = duplicates;
  }
}

function findDuplicateKeys<T>(items: readonly T[], keyOf: (item: T) => string, list: "before" | "after"): DuplicateKeyEntry[] {
  const seen = new Set<string>();
  const duplicates: DuplicateKeyEntry[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      duplicates.push({ key, list });
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

export function diffById<T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T) => string,
): SnapshotDiff<T> {
  const duplicates = [...findDuplicateKeys(before, keyOf, "before"), ...findDuplicateKeys(after, keyOf, "after")];
  if (duplicates.length > 0) {
    throw new DuplicateKeyDiffError(duplicates);
  }

  const beforeMap = new Map(before.map((item) => [keyOf(item), item]));
  const afterMap = new Map(after.map((item) => [keyOf(item), item]));

  const added: T[] = [];
  const unchanged: T[] = [];
  for (const [key, item] of afterMap) {
    if (beforeMap.has(key)) unchanged.push(item);
    else added.push(item);
  }

  const removed: T[] = [];
  for (const [key, item] of beforeMap) {
    if (!afterMap.has(key)) removed.push(item);
  }

  return { added, removed, unchanged };
}

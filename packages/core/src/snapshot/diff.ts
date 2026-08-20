/**
 * 두 스냅샷 배열의 diff (CLAUDE.md: "현재 상태와 드리프트는 파생값으로 계산"). 순수 함수 —
 * append-only로 쌓인 레코드 두 장을 놓고 무엇이 늘고 줄었는지만 파생한다.
 */
export interface SnapshotDiff<T> {
  added: T[];
  removed: T[];
  unchanged: T[];
}

export function diffById<T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T) => string,
): SnapshotDiff<T> {
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

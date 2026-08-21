/** 스냅샷/실행로그/저널 파일명에 쓰는 ISO 8601 id (카탈로그 결정 2: `snapshots/<iso8601>.jsonl`). */
export function snapshotId(date: Date = new Date()): string {
  return date.toISOString();
}

/** 파일시스템 안전 변형 (콜론 제거) — 필요한 저장소 어댑터가 선택적으로 사용한다. */
export function snapshotIdFsSafe(date: Date = new Date()): string {
  return snapshotId(date).replace(/:/g, "-");
}

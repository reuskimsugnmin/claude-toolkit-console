/**
 * append-only 레코드 포맷 (JSONL 1줄 = 1레코드). 모든 레코드는 schema_version을 필수로 갖는다
 * (OQ-6ⓑ 확정) — 이 파일은 그 제약을 타입으로 강제한다.
 */
export interface AppendOnlyRecord {
  readonly schema_version: number;
}

export function toJsonlLine<T extends AppendOnlyRecord>(record: T): string {
  return JSON.stringify(record);
}

export function toJsonl<T extends AppendOnlyRecord>(records: readonly T[]): string {
  return records.map(toJsonlLine).join("\n");
}

/** `parse`는 호출자가 넘기는 zod `.parse` 등 — core는 스키마별 파서를 여기서 임포트하지 않는다. */
export function parseJsonlLines<T>(content: string, parse: (raw: unknown) => T): T[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parse(JSON.parse(line) as unknown));
}

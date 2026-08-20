import { z } from "zod";

/**
 * append-only 레코드는 전부 schema_version을 필수 필드로 갖는다 (OQ-6ⓑ 확정, 2026-08-20).
 * 첫 스냅샷부터 있어야 한다 — 나중에 넣으면 그 이전 스냅샷은 영원히 버전 미상이다.
 */
export const schemaVersion = z.number().int().positive();

export const MACHINE_DEPENDENT = "machine_dependent" as const;
export const MACHINE_INDEPENDENT = "machine_independent" as const;

export const machineDependentTag = z.literal(MACHINE_DEPENDENT);
export const machineIndependentTag = z.literal(MACHINE_INDEPENDENT);

/**
 * 머신 종속/독립을 "타입 수준"에서 분리한다 (CLAUDE.md 스키마의 척추 · P0-3).
 *
 * 두 브랜드는 판별 리터럴 값이 다르므로("machine_dependent" vs "machine_independent"),
 * 머신 종속 엔티티(Machine·Installation·Project·UsageMetric·Journal·RunLog·Toggle)를
 * 머신 독립 엔티티(Asset·Annotation·DocPage) 자리에 대입하면(혹은 반대로) TypeScript가
 * 컴파일 타임에 거부한다. "섞이면 컴파일이 깨지게 한다"의 실제 구현.
 */
export interface MachineDependentTag {
  readonly _scope: typeof MACHINE_DEPENDENT;
}
export interface MachineIndependentTag {
  readonly _scope: typeof MACHINE_INDEPENDENT;
}

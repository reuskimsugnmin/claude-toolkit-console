// 컴파일 전용 테스트 — 머신 종속/독립을 "타입 수준"에서 분리한다 (CLAUDE.md 스키마의 척추, P0-3).
// Machine(머신 종속)을 Annotation(머신 독립) 자리에 대입하면 컴파일 오류가 나야 한다.
import type { Machine } from "../../src/schema/machine.js";
import type { Annotation } from "../../src/schema/annotation.js";

declare const machine: Machine;

// @ts-expect-error _scope가 "machine_dependent" vs "machine_independent"로 갈리고
// 필수 필드(role·purpose·when_to_use 등)도 없어 구조적으로 대입 불가하다
const asAnnotation: Annotation = machine;
void asAnnotation;

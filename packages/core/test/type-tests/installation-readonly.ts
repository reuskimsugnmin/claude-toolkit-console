// 컴파일 전용 테스트 — 실행되지 않는다(vitest.config.ts가 이 디렉터리를 test 실행에서 제외한다).
// `pnpm typecheck`(tsc -b)가 이 파일을 함께 검사하며, 기대한 컴파일 오류가 나지 않으면
// "Unused '@ts-expect-error'" 자체가 오류가 되어 typecheck가 실패한다.
//
// install_scope · mcp_enabled_state · mcp_state_source는 읽기 전용이어야 한다
// (P0-3, OQ-7 안 C — "읽기 전용 보장을 문서가 아니라 타입으로").
import type { Installation } from "../../src/schema/installation.js";

declare const installation: Installation;

// @ts-expect-error install_scope는 읽기 전용이다 — actuator가 대입하면 컴파일 오류가 나야 한다
installation.install_scope = "project";

// @ts-expect-error mcp_enabled_state는 읽기 전용이다
installation.mcp_enabled_state = "enabled";

// @ts-expect-error mcp_state_source는 읽기 전용이다
installation.mcp_state_source = "both";

// enabled_at은 쓰기 대상이다 — 아래 줄이 에러가 나면 tsc -b 자체가 실패한다(의도된 양성 대조군)
installation.enabled_at = "project";

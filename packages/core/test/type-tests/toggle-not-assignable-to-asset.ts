// 컴파일 전용 테스트 — 착수 조건 C4.
// Toggle(비-Asset 관측 레코드)을 Asset 타입 변수에 대입하면 컴파일 오류가 나야 한다.
import type { Asset } from "../../src/schema/asset.js";
import type { Toggle } from "../../src/schema/toggle.js";

declare const toggle: Toggle;

// @ts-expect-error Toggle은 Asset이 아니다 — __kind:"toggle" 판별 필드 + _scope 브랜드 불일치 +
// Asset 필수 필드(id·kind) 누락으로 구조적으로 대입 불가하다
const asAsset: Asset = toggle;
void asAsset;

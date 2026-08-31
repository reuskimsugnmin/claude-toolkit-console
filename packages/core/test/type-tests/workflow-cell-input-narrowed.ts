// 컴파일 전용 테스트 — B4-c Step 2 (D-4 · 위생 단일 관문).
//
// `renderWorkflowAssetCell`의 입력이 `Pick<Asset,"description">`인 것은 **보안 설계**다:
// `id`·`marketplace`·`parent_asset_id`·`source_ref`가 타입에 없으므로 미래의 호출자도 그것을
// 문서에 실을 방법이 없다. public 저장소의 "설치된 툴 목록 금지"를 게이트가 아니라 구조로 지킨다.
//
// ⚠️ **계획서의 완료 판정("`Asset` 전체를 넘기면 타입 에러")은 틀렸다.** TypeScript는 구조적
// 타이핑이라 `Asset`은 `Pick<Asset,"description">`에 **정상 대입된다**(초과 속성 검사는 객체
// 리터럴에만 적용된다). 넘기는 것은 막히지 않고, 막히는 것은 **함수 안에서 읽는 것**이다 —
// 그리고 보안 성질을 지는 쪽은 후자다. 못 재는 것을 잰 것처럼 적지 않는다.
import type { Asset } from "../../src/schema/asset.js";

declare const narrowed: Pick<Asset, "description">;

// @ts-expect-error `Pick<Asset,"description">`에는 id가 없다 — 렌더러가 자산 id를 셀에 실을 수 없다
void narrowed.id;

// @ts-expect-error marketplace도 없다 — `name@marketplace`는 곧 설치된 툴 목록이다
void narrowed.marketplace;

// @ts-expect-error 원문 경로도 없다 — 홈 절대경로가 문서로 새는 경로를 타입에서 끊는다
void narrowed.source_ref;

// description만 읽을 수 있다(정상).
void narrowed.description;

// 전체 Asset을 넘기는 것 자체는 구조적으로 허용된다 — 위에서 적은 대로다.
declare const full: Asset;
const accepted: Pick<Asset, "description"> = full;
void accepted;

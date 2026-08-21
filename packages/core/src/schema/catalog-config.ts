import { z } from "zod";
import { schemaVersion } from "./common.js";

/**
 * `tokenizer_model`의 기본값(Step 3) — 사용자가 `ctk init`에서 달리 지정하지 않으면 이 값으로
 * 핀한다. §1.3 결정 5: "토큰 수는 모델 상대적이므로 모델이 다르면 같은 텍스트도 다른 값이 나온다
 * — 모델 값이 다르면 캐시 미스이고, 비교도 불가로 표시한다." 값 자체를 바꿔도 기존 토큰 캐시는
 * `(content_sha256, tokenizer_model)` 복합 키라 자동으로 무효화된다(재측정만 될 뿐 잘못된 값이
 * 섞이지 않는다).
 */
export const DEFAULT_TOKENIZER_MODEL = "claude-sonnet-4-5-20250929" as const;

/** AC-4.8 — ctk idle 합계 vs `plugin details` Always-on 값의 괴리 판정 임계(퍼센트). */
export const DEFAULT_OCCUPANCY_DIVERGENCE_THRESHOLD_PCT = 20;

/**
 * `<catalog>/ctk.config.json` — 카탈로그 결정 2: "스키마 버전·측정 정의·토크나이저 모델·검증된
 * CLI 버전". **`catalog_path`는 여기 두지 않는다** — 그 값은 카탈로그 밖의 로컬 전용 파일
 * `~/.config/ctk/config.json`에만 기록한다(§1.3 결정 2). 카탈로그 내부 파일에 카탈로그 자신의
 * 절대경로를 적으면 그 경로가 곧 AC-1.7이 금지하는 홈 절대경로 원문이 되기 때문이다.
 *
 * `tokenizer_model`/`occupancy_divergence_threshold_pct`는 Step 3에서 추가했다. `.default()`를
 * 써서 Step 1이 만든 기존 픽스처(두 필드가 없는 것)도 계속 parse된다 — 새 필드가 필수였다면
 * 그 픽스처들이 전부 즉시 깨졌을 것이다(스키마 진화 시 하위 호환을 유지하는 방식, R13 대응과
 * 같은 정신).
 */
export const CatalogConfigSchema = z
  .object({
    schema_version: schemaVersion,
    verified_cli_version: z.string().min(1),
    offset_cache_location: z.enum(["catalog", "local"]),
    tokenizer_model: z.string().min(1).default(DEFAULT_TOKENIZER_MODEL),
    occupancy_divergence_threshold_pct: z.number().positive().default(DEFAULT_OCCUPANCY_DIVERGENCE_THRESHOLD_PCT),
  })
  .strict();

export type CatalogConfig = z.infer<typeof CatalogConfigSchema>;

export function parseCatalogConfig(data: unknown): CatalogConfig {
  return CatalogConfigSchema.parse(data);
}

/**
 * `~/.config/ctk/config.json` — 카탈로그 **밖**의 로컬 전용 파일. `catalog_path`가 사는 유일한
 * 곳이다(§1.3 결정 2). 이 파일 자체는 카탈로그 저장소에 커밋되지 않으므로 AC-1.7의 검사 대상이
 * 아니다.
 */
export const LocalConfigSchema = z
  .object({
    schema_version: schemaVersion,
    catalog_path: z.string().min(1),
  })
  .strict();

export type LocalConfig = z.infer<typeof LocalConfigSchema>;

export function parseLocalConfig(data: unknown): LocalConfig {
  return LocalConfigSchema.parse(data);
}

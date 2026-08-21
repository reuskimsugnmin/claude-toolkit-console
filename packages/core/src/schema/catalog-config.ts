import { z } from "zod";
import { schemaVersion } from "./common.js";

/**
 * `<catalog>/ctk.config.json` — 카탈로그 결정 2: "스키마 버전·측정 정의·토크나이저 모델·검증된
 * CLI 버전". **`catalog_path`는 여기 두지 않는다** — 그 값은 카탈로그 밖의 로컬 전용 파일
 * `~/.config/ctk/config.json`에만 기록한다(§1.3 결정 2). 카탈로그 내부 파일에 카탈로그 자신의
 * 절대경로를 적으면 그 경로가 곧 AC-1.7이 금지하는 홈 절대경로 원문이 되기 때문이다.
 */
export const CatalogConfigSchema = z
  .object({
    schema_version: schemaVersion,
    verified_cli_version: z.string().min(1),
    offset_cache_location: z.enum(["catalog", "local"]),
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

import { z } from "zod";

/**
 * `<config>/settings.json` · `<config>/settings.local.json` · `<project>/.claude/settings.json`
 * 공통 스키마 — Step 2가 실제로 쓰는 필드(`enabledPlugins`)만 강제하고 나머지는 통과시킨다.
 *
 * 실측(read-only, 2026-08-20): 이 파일은 `env`·`permissions`·`model`·`hooks`·`statusLine`·
 * `enabledPlugins`·`extraKnownMarketplaces`·`mcpServers` 등 수십 개 키를 가지며 하네스 버전마다
 * 늘어난다(R13). `.strict()`를 쓰면 매 하네스 갱신마다 스캔이 깨진다 — `enabledPlugins`의 형태
 * (`{id: boolean}`, 결정 6 실측)만 검증하고 그 외는 `.passthrough()`로 흘려보낸다.
 */
export const SettingsFileSchema = z
  .object({
    enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

export type SettingsFile = z.infer<typeof SettingsFileSchema>;

export function parseSettingsFile(data: unknown): SettingsFile {
  return SettingsFileSchema.parse(data);
}

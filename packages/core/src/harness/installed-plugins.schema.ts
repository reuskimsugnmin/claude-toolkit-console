import { z } from "zod";

/**
 * `<config>/plugins/installed_plugins.json` 스키마 — Step 2 실측(read-only, 2026-08-20)으로
 * 확정한 형태. `plugin list --json`과는 다른 파일이다: 이 파일은 **install_scope의 유일한
 * 권위 출처**다(P0-3 — install_scope는 이 파일 직독으로, enabled_at은 settings.json류 직독으로
 * 따로 채운다).
 *
 * 실측 형태: `{ version, plugins: { "<id>": [entry, ...] } }` — 배열 원소는 (scope, projectPath)
 * 조합마다 하나씩 늘어난다. 같은 id가 local scope로 3개 프로젝트에 설치되면 배열 길이 3
 * (AC-0.3의 "id 기준 중복 = 실은 프로젝트별 local 설치"와 같은 구조).
 *
 * `.strict()`가 아니라 `.passthrough()`를 쓴다 — 이 파일은 AC-0.3처럼 정식 Step 0 스파이크로
 * 전 필드가 실측되지 않았고(하네스 내부 레지스트리 파일이라 R13 드리프트 위험이 plugin-list보다
 * 크다), 알려지지 않은 키로 파싱이 깨지면 카탈로그 전체가 빈 채로 남는 실패 모드가 더 나쁘다.
 * 필수로 확인된 필드만 강제하고 나머지는 통과시킨다.
 */
export const InstalledPluginEntrySchema = z
  .object({
    scope: z.enum(["user", "project", "local"]),
    installPath: z.string(),
    version: z.string(),
    installedAt: z.string(),
    lastUpdated: z.string(),
    gitCommitSha: z.string().optional(),
    /** scope가 project/local일 때만 존재 (실측) — 절대경로이므로 위생 처리 필수 대상 */
    projectPath: z.string().optional(),
  })
  .passthrough();

export type InstalledPluginEntry = z.infer<typeof InstalledPluginEntrySchema>;

export const InstalledPluginsFileSchema = z
  .object({
    version: z.number().optional(),
    plugins: z.record(z.string(), z.array(InstalledPluginEntrySchema)),
  })
  .passthrough();

export type InstalledPluginsFile = z.infer<typeof InstalledPluginsFileSchema>;

export function parseInstalledPluginsFile(data: unknown): InstalledPluginsFile {
  return InstalledPluginsFileSchema.parse(data);
}

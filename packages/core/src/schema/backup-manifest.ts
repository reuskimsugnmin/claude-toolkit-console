import { z } from "zod";

/**
 * core/src/schema/backup-manifest.ts — actuator의 백업 manifest(`<backupRoot>/manifest.json`)를
 * zod로 검증한다(H2 수정 ④ — "manifest를 zod로 파싱, `as BackupManifest` 캐스팅 금지").
 *
 * manifest 자체는 카탈로그(git) **밖**에 있다(actuator/src/backup.ts 상단 문서와 동형) — 그래도
 * 롤백은 이 파일의 내용을 그대로 `rmSync`/`atomicWriteFile`의 인자로 쓰는 위험한 연산이므로,
 * "파일이 있으니 신뢰한다"가 아니라 구조부터 강제한다. 판정 로직(어느 경로가 허용되는가)은
 * 여기 담지 않는다 — 그건 actuator/src/rollback.ts의 `assertRestorableTarget()`(단일 관문)이 한다.
 */

export const BackupFileEntrySchema = z
  .object({
    kind: z.literal("file"),
    targetAbs: z.string().min(1),
    existed: z.boolean(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    storedRelPath: z.string().min(1).nullable(),
  })
  .strict();

export const BackupDirFileSchema = z
  .object({
    relPath: z.string().min(1),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const BackupDirEntrySchema = z
  .object({
    kind: z.literal("directory"),
    targetAbs: z.string().min(1),
    existed: z.boolean(),
    files: z.array(BackupDirFileSchema),
    storedRelPath: z.string().min(1).nullable(),
  })
  .strict();

export const BackupEntrySchema = z.discriminatedUnion("kind", [BackupFileEntrySchema, BackupDirEntrySchema]);

export const BackupManifestSchema = z
  .object({
    run_id: z.string().min(1),
    created_at: z.string().datetime(),
    entries: z.record(z.string(), BackupEntrySchema),
  })
  .strict();

export type BackupFileEntry = z.infer<typeof BackupFileEntrySchema>;
export type BackupDirEntry = z.infer<typeof BackupDirEntrySchema>;
export type BackupEntry = z.infer<typeof BackupEntrySchema>;
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export function parseBackupManifest(data: unknown): BackupManifest {
  return BackupManifestSchema.parse(data);
}

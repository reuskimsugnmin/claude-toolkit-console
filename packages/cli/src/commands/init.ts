import { extractVersionString, resolveHomeContext, spawnClaude } from "@ctk/probe";
import { ensureGitRepo, writeCatalogConfig, readCatalogConfig, acquireLock, LockContendedError } from "@ctk/sync";
import { DEFAULT_OCCUPANCY_DIVERGENCE_THRESHOLD_PCT, DEFAULT_TOKENIZER_MODEL } from "@ctk/core";
import { defaultCatalogPath, writeLocalConfig, readOrCreateMachineIdentity } from "../local-config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** `ctk init`이 원격 URL을 인자로 받았을 때 던지는 오류 — remote_catalog_unsupported(OQ-1 안 C). */
export class RemoteCatalogUnsupportedError extends Error {
  readonly failureClass = "remote_catalog_unsupported" as const;
  constructor(catalogArg: string) {
    super(
      `원격 카탈로그는 v2 기능입니다. v1은 로컬 전용으로 동작합니다 — "${catalogArg}"는 원격 URL로 보입니다. ` +
        `--catalog 없이 실행하면 로컬 기본 경로를 씁니다.`,
    );
    this.name = "RemoteCatalogUnsupportedError";
  }
}

const REMOTE_URL_PATTERN = /^(https?:\/\/|git@|ssh:\/\/)/i;

export function isRemoteCatalogUrl(value: string): boolean {
  return REMOTE_URL_PATTERN.test(value);
}

export async function detectClaudeVersion(cwd: string): Promise<string> {
  try {
    const result = await spawnClaude({
      profile: "test-isolated",
      subcommand: ["--version"],
      home: resolveHomeContext(),
      cwd,
      timeoutSec: 15,
    });
    // 프리플라이트 게이트와 **같은 정규화**를 쓴다 — 형식이 다르면 같은 버전이 불일치로 판정된다.
    return extractVersionString(result.stdout) ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface InitOptions {
  catalog?: string;
  machineAlias?: string;
}

export interface InitResult {
  catalogPath: string;
  created: boolean;
  machineId: string;
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  if (options.catalog !== undefined && isRemoteCatalogUrl(options.catalog)) {
    throw new RemoteCatalogUnsupportedError(options.catalog);
  }

  const home = resolveHomeContext();
  const catalogPath = options.catalog ?? defaultCatalogPath(home);

  const lock = acquireLock(catalogPath, {
    command: "init",
    origin: "cli",
    started_at: new Date().toISOString(),
    machine_id: "pending", // init이 machine_id를 만들기 전에 락을 잡아야 하므로 임시값 — 락 내용은 진단용일 뿐이다.
  });

  try {
    ensureGitRepo(catalogPath);

    const existing = readCatalogConfig(catalogPath);
    const tmpCwd = mkdtempSync(path.join(tmpdir(), "ctk-init-"));
    let verifiedCliVersion: string;
    try {
      verifiedCliVersion = existing?.verified_cli_version ?? (await detectClaudeVersion(tmpCwd));
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }

    if (existing === null) {
      writeCatalogConfig(catalogPath, {
        schema_version: 1,
        verified_cli_version: verifiedCliVersion,
        offset_cache_location: "catalog",
        tokenizer_model: DEFAULT_TOKENIZER_MODEL,
        occupancy_divergence_threshold_pct: DEFAULT_OCCUPANCY_DIVERGENCE_THRESHOLD_PCT,
      });
    }

    writeLocalConfig(home, { schema_version: 1, catalog_path: catalogPath });
    const machine = readOrCreateMachineIdentity(home, options.machineAlias ?? "local-machine");

    return { catalogPath, created: existing === null, machineId: machine.machine_id };
  } finally {
    lock.release();
  }
}

export { LockContendedError };

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * actuator/src/guard/atomic-write.ts — **첫 커밋**(계획 Pre-mortem A 선제 조치: "쓰기 중 프로세스가
 * 죽었다"에 대비). 쓰기 책임(temp write → fsync → rename)만 담당한다 — 판정 로직은 여기 없다
 * (`core/guard/*`가 판정, H1).
 *
 * 임시 파일은 대상과 **같은 디렉터리**에 만든다 — `rename()`이 원자적이려면 같은 파일시스템 위에
 * 있어야 한다(cross-device rename은 EXDEV로 실패한다). 임시 파일명은
 * `.claude.json.tmp.<pid>.<rand>`류(AC-0.8 실측, Tier-2 앵커된 정규식과 동형)로 짓는다 —
 * churn 허용목록의 tmp 패턴과 같은 모양이어야 rename 실패로 잔존했을 때 `tmp_leftover`로
 * 정확히 분류된다.
 *
 * rename 실패 시 tmp 파일을 지우려 시도한다(best-effort) — 지우지 못하고 잔존하면 그것이 바로
 * `tmp_leftover` 이상 신호(§7.2)이며, 이 모듈은 그 판정을 하지 않고 흔적만 최소화한다.
 */

export class AtomicWriteVerifyError extends Error {
  readonly absPath: string;
  constructor(absPath: string, cause: unknown) {
    super(`원자적 쓰기 후 재파싱 검증 실패(${absPath}): ${String(cause)}`);
    this.name = "AtomicWriteVerifyError";
    this.absPath = absPath;
    this.cause = cause;
  }
}

export interface AtomicWriteOptions {
  /** 쓴 뒤 재파싱 검증에 쓸 파서(AC-2.8 — "쓰기 후 재파싱 성공"). 기본은 JSON.parse. */
  reparse?: (raw: string) => unknown;
}

function tmpFileName(basename: string): string {
  return `.${basename}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
}

/**
 * temp write → fsync → rename. 쓰기 후 재파싱으로 검증한다(AC-2.8). 대상 디렉터리가 없으면
 * 만든다(멱등) — 백업·apply 양쪽에서 호출부가 디렉터리 존재를 매번 별도로 보장할 필요가 없다.
 */
export function atomicWriteFile(absPath: string, content: string, options: AtomicWriteOptions = {}): void {
  const dir = path.dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, tmpFileName(path.basename(absPath)));

  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmpPath, absPath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort — 여기서 실패해도 원래 오류를 그대로 던진다. 잔존하면 tmp_leftover 대상.
      }
    }
    throw err;
  }

  const reparse = options.reparse ?? ((raw: string) => JSON.parse(raw) as unknown);
  const raw = readFileSync(absPath, "utf8");
  try {
    reparse(raw);
  } catch (cause) {
    throw new AtomicWriteVerifyError(absPath, cause);
  }
}

/** JSON 값을 원자적으로 쓴다. `settings.json`류 — 사람이 읽기 좋게 2-space indent + 줄바꿈. */
export function atomicWriteJson(absPath: string, value: unknown): void {
  atomicWriteFile(absPath, `${JSON.stringify(value, null, 2)}\n`, {
    reparse: (raw) => JSON.parse(raw) as unknown,
  });
}

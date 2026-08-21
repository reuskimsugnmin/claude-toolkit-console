import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { hashPath, parseSubagentMeta, parseTranscriptRow, type SubagentMeta, type TranscriptRow } from "@ctk/core";

/**
 * probe/src/transcripts/iterate.ts — `<config>/projects/` 하위 세션 트랜스크립트 스트리밍
 * 파서(plan §4 Step 3).
 *
 * **⚠️ Step 3 실측 정정(harness-facts.md 갱신 대상, 2026-08-21) — 서브에이전트 트랜스크립트는
 * 메인 세션 파일 "안"에 `isSidechain:true` 행으로 인라인되지 않는다.** 실제 환경 전수 확인
 * (이 실행 자체, `find ~/.claude/projects -name '*.jsonl'` 666개 대상): `isSidechain:true`를
 * 포함하는 파일 326개 중 325개가 `<project>/<session-uuid>/subagents/agent-<hash>.jsonl`이라는
 * **별도 파일**이었다(1개는 tool-results/*.txt 안의 우연한 문자열 일치로 실제 JSONL 행이 아니었다).
 * 메인 세션 파일(`<project>/<session-uuid>.jsonl`) 자체에서 `isSidechain:true`가 나온 사례는
 * 0건이었다. 이 발견은 이전 세션이 남긴 harness-facts.md의 "같은 트랜스크립트 파일 안에" 서술을
 * 정정한다 — 문서는 별도 커밋으로 갱신한다. 파서는 **두 위치 모두**를 훑어야 한다.
 *
 * `<session-uuid>/subagents/agent-<hash>.meta.json` 사이드카가 `toolUseId`로 부모 세션의 `Agent`
 * tool_use와 역추적을 제공한다(R17 대조 근거) — `subagent-meta.schema.ts` 참조.
 */

export interface DiscoveredTranscriptFile {
  absPath: string;
  /** offset 캐시 키(경로 원문 금지, P3). 호출자의 홈 기준으로 계산한다. */
  pathHash: string;
  isSidechain: boolean;
  /** isSidechain일 때만 존재 — 같은 이름의 .meta.json 사이드카 절대경로(있으면). */
  metaPath: string | null;
}

function listJsonlFilesRecursive(rootAbs: string): string[] {
  let entries;
  try {
    entries = readdirSync(rootAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const abs = path.join(rootAbs, entry.name);
    if (entry.isDirectory()) {
      results.push(...listJsonlFilesRecursive(abs));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(abs);
    }
  }
  return results;
}

/**
 * `<config>/projects/` 아래 전 프로젝트를 훑어 트랜스크립트 파일 목록을 만든다. `--transcripts <dir>`
 * 오버라이드가 주어지면(호출자가 `projectsRootAbs`로 그 경로를 넘긴다) 그 디렉터리를 대신 훑는다 —
 * 이 함수 자체는 "projects 루트"라는 개념만 알고 `<config>/projects`라는 리터럴을 하드코딩하지 않는다.
 * `pathHash`는 `core/snapshot/path-normalize.ts`의 `hashPath`(sha256 앞 16자, 경로 원문 미보존)를
 * 그대로 쓴다 — offset 캐시 키가 경로 원문을 담지 않는다는 P3 규칙이 여기서 성립한다.
 */
export function listTranscriptFiles(projectsRootAbs: string): DiscoveredTranscriptFile[] {
  return listJsonlFilesRecursive(projectsRootAbs).map((absPath) => {
    const isSidechain = absPath.includes(`${path.sep}subagents${path.sep}`);
    let metaPath: string | null = null;
    if (isSidechain) {
      const candidate = `${absPath.slice(0, -".jsonl".length)}.meta.json`;
      metaPath = statSyncSafe(candidate) ? candidate : null;
    }
    return { absPath, pathHash: hashPath(absPath), isSidechain, metaPath };
  });
}

function statSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readSubagentMeta(metaPath: string): SubagentMeta | null {
  try {
    return parseSubagentMeta(JSON.parse(readFileSync(metaPath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export type TranscriptLineResult =
  | { ok: true; row: TranscriptRow; byteOffsetAfter: number }
  | { ok: false; rawLine: string; error: string; byteOffsetAfter: number };

/**
 * `filePath`를 `fromByteOffset`부터 스트리밍으로 읽어 완성된(개행으로 끝난) 줄만 파싱한다.
 * **바이트 정확한 진행만 커밋한다** — 파일 끝의 미완성 줄(세션이 아직 쓰는 중인 마지막 줄)은
 * offset을 진행시키지 않고 버려서, 다음 증분 파싱 때 완성된 형태로 다시 읽히게 한다. `readline`
 * 기반 구현은 줄 단위 문자 길이로 offset을 역산해야 해서 트레일링 개행 유무에 따라 1바이트
 * 오차가 나고, 그 오차가 세션이 계속 쓰는 파일에서 실제 데이터 손실로 이어질 수 있어 채택하지
 * 않았다(버퍼를 직접 개행 바이트로 분할).
 */
export async function* iterateTranscriptRows(
  filePath: string,
  fromByteOffset = 0,
): AsyncGenerator<TranscriptLineResult> {
  const stream = createReadStream(filePath, { start: fromByteOffset });
  let offset = fromByteOffset;
  let buffered = Buffer.alloc(0);

  for await (const chunk of stream) {
    buffered = Buffer.concat([buffered, chunk as Buffer]);
    let newlineIndex = buffered.indexOf(0x0a);
    while (newlineIndex !== -1) {
      const lineBuf = buffered.subarray(0, newlineIndex);
      buffered = buffered.subarray(newlineIndex + 1);
      offset += lineBuf.length + 1;
      const line = lineBuf.toString("utf8").trim();
      if (line.length > 0) {
        yield parseLine(line, offset);
      }
      newlineIndex = buffered.indexOf(0x0a);
    }
  }
}

function parseLine(line: string, byteOffsetAfter: number): TranscriptLineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    return { ok: false, rawLine: line, error: `JSON 파싱 실패: ${String(cause)}`, byteOffsetAfter };
  }
  try {
    return { ok: true, row: parseTranscriptRow(parsed), byteOffsetAfter };
  } catch (cause) {
    return { ok: false, rawLine: line, error: `스키마 불일치(R13): ${String(cause)}`, byteOffsetAfter };
  }
}

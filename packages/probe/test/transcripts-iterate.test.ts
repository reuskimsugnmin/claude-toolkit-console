import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { iterateTranscriptRows, listTranscriptFiles, readSubagentMeta } from "../src/transcripts/iterate.js";

/**
 * probe/test/transcripts-iterate.test.ts — Step 3. `listTranscriptFiles`가 메인 세션 파일과
 * `subagents/*.jsonl`(실측 정정 — harness-facts.md 갱신 대상) 양쪽을 찾는지, `iterateTranscriptRows`가
 * 증분 파싱에서 바이트 정확한 offset을 돌려주는지 검증한다.
 */
describe("probe/transcripts/iterate", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("listTranscriptFiles — 메인 세션 파일과 subagents/*.jsonl을 모두 찾고 isSidechain을 올바로 표기한다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-transcripts-"));
    const projectDir = path.join(root, "-Users-demo-project");
    const sessionDir = path.join(projectDir, "session-uuid-1");
    mkdirSync(path.join(sessionDir, "subagents"), { recursive: true });
    mkdirSync(path.join(sessionDir, "tool-results"), { recursive: true });

    writeFileSync(path.join(projectDir, "session-uuid-1.jsonl"), '{"type":"system"}\n', "utf8");
    writeFileSync(path.join(sessionDir, "subagents", "agent-abc.jsonl"), '{"type":"user","isSidechain":true}\n', "utf8");
    writeFileSync(path.join(sessionDir, "subagents", "agent-abc.meta.json"), JSON.stringify({ agentType: "general-purpose", toolUseId: "toolu_1" }), "utf8");
    // tool-results/*.txt는 .jsonl이 아니므로 대상에서 제외되어야 한다.
    writeFileSync(path.join(sessionDir, "tool-results", "output.txt"), "not a transcript row", "utf8");

    const files = listTranscriptFiles(root);
    expect(files).toHaveLength(2);

    const main = files.find((f) => f.absPath.endsWith("session-uuid-1.jsonl") && !f.isSidechain);
    expect(main).toBeDefined();
    expect(main?.isSidechain).toBe(false);
    expect(main?.metaPath).toBeNull();

    const sub = files.find((f) => f.isSidechain);
    expect(sub).toBeDefined();
    expect(sub?.absPath).toContain(`${path.sep}subagents${path.sep}`);
    expect(sub?.metaPath).not.toBeNull();

    // pathHash는 경로 원문을 포함하지 않는다(P3) — 16자 hex.
    expect(main?.pathHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("readSubagentMeta — .meta.json을 파싱하고, 손상되면 null(예외를 던지지 않음)을 반환한다", () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-transcripts-"));
    const metaPath = path.join(root, "agent-x.meta.json");
    writeFileSync(metaPath, JSON.stringify({ agentType: "oh-my-claudecode:critic", toolUseId: "toolu_9" }), "utf8");
    expect(readSubagentMeta(metaPath)?.agentType).toBe("oh-my-claudecode:critic");

    const badPath = path.join(root, "broken.meta.json");
    writeFileSync(badPath, "{ not json", "utf8");
    expect(readSubagentMeta(badPath)).toBeNull();
  });

  it("iterateTranscriptRows — 완성된 줄만 yield하고, 미완성 마지막 줄은 offset을 진행시키지 않는다", async () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-transcripts-"));
    const filePath = path.join(root, "t.jsonl");
    writeFileSync(filePath, '{"type":"system"}\n{"type":"user"}\n{"type":"assistant","message":{"content":[]}', "utf8");
    // ⚠️ 마지막 줄에 개행이 없다 — 세션이 아직 쓰는 중인 상태를 흉내낸다.

    const results = [];
    let lastOffset = 0;
    for await (const r of iterateTranscriptRows(filePath)) {
      results.push(r);
      lastOffset = r.byteOffsetAfter;
    }
    expect(results).toHaveLength(2); // 미완성 3번째 줄은 yield되지 않는다.
    expect(results.every((r) => r.ok)).toBe(true);

    // 미완성 줄을 완성시키고(개행 추가) 저장된 offset부터 재파싱하면 그 줄이 이번엔 나온다.
    // 미완성 원문은 `{"type":"assistant","message":{"content":[]}`까지만 썼다 — 이미 message
    // 객체까지는 닫혀 있고(content:[] 뒤 `}`), 바깥 객체 하나만 닫으면 완성된다.
    appendFileSync(filePath, "}\n", "utf8");
    const resumed = [];
    for await (const r of iterateTranscriptRows(filePath, lastOffset)) {
      resumed.push(r);
    }
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.ok).toBe(true);
  });

  it("iterateTranscriptRows — JSON 파싱 실패·스키마 불일치 줄은 ok:false로 표시하고 스트림을 중단하지 않는다", async () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-transcripts-"));
    const filePath = path.join(root, "t.jsonl");
    writeFileSync(
      filePath,
      ['{"type":"system"}', "not-json-at-all", '{"type":"totally-unknown-row-type"}', '{"type":"user"}', ""].join("\n"),
      "utf8",
    );

    const results = [];
    for await (const r of iterateTranscriptRows(filePath)) {
      results.push(r);
    }
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.ok)).toEqual([true, false, false, true]);
  });

  it("iterateTranscriptRows — 빈 파일은 아무것도 yield하지 않는다(파싱 실패가 아니라 정상)", async () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-transcripts-"));
    const filePath = path.join(root, "empty.jsonl");
    writeFileSync(filePath, "", "utf8");
    const results = [];
    for await (const r of iterateTranscriptRows(filePath)) results.push(r);
    expect(results).toHaveLength(0);
  });
});

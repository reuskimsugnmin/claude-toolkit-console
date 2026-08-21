import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { iterateTranscriptRows } from "../src/transcripts/iterate.js";

/**
 * probe/test/transcripts-iterate-incremental.bench.test.ts — Step 3 수용 기준: "대용량 픽스처에서
 * 증분 파싱이 전량 파싱보다 빠름을 벤치로 증명." 실제 오프셋 캐시 적중 시나리오를 재현한다 —
 * 같은 대용량 파일을 ① offset 0부터(전량) ② 파일 끝 근처 offset부터(증분, 새 줄 몇 개만) 두 번
 * 스트리밍하고 걸린 시간을 비교한다. 캐시 자체(sync/offset-cache-store.ts)는 값을 저장·복원할
 * 뿐이고 "왜 빠른가"의 근거는 `iterateTranscriptRows`가 `start` 옵션으로 파일을 처음부터 다시
 * 읽지 않는다는 사실이다 — 이 테스트는 그 사실을 실측한다.
 */
describe("probe/transcripts/iterate — 증분 파싱이 전량 파싱보다 빠르다(대용량 픽스처 벤치)", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("동일 파일을 offset 0(전량) vs 파일 끝 근처 offset(증분)으로 읽으면 증분 쪽이 유의미하게 빠르다", async () => {
    root = mkdtempSync(path.join(tmpdir(), "ctk-bench-"));
    const filePath = path.join(root, "large.jsonl");

    // 대용량 합성 픽스처 — 실제 트랜스크립트와 동형의 assistant/user 교대 행 5만 줄(수 MB급).
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          isSidechain: false,
          sessionId: "sess-bench",
          timestamp: `2026-08-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
          message: {
            content: [{ type: "tool_use", id: `toolu_${i}`, name: "mcp__bench-server__op", input: { i } }],
            usage: { input_tokens: 2, output_tokens: 5 },
          },
        }),
      );
      lines.push(
        JSON.stringify({
          type: "user",
          isSidechain: false,
          message: { content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: `result payload ${i} `.repeat(10) }] },
        }),
      );
    }
    writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

    // ① 전량 — offset 0부터 10만 줄 전부.
    const fullStart = performance.now();
    let fullCount = 0;
    let lastOffset = 0;
    for await (const line of iterateTranscriptRows(filePath, 0)) {
      fullCount++;
      lastOffset = line.byteOffsetAfter;
    }
    const fullMs = performance.now() - fullStart;
    expect(fullCount).toBe(100_000);

    // 새 줄 200개를 파일 끝에 추가한다(증분 시나리오 — 마지막 측정 이후 새로 쌓인 분량만 남음).
    const extraLines: string[] = [];
    for (let i = 0; i < 100; i++) {
      extraLines.push(JSON.stringify({ type: "system" }));
    }
    writeFileSync(filePath, `${extraLines.join("\n")}\n`, { flag: "a", encoding: "utf8" });

    // ② 증분 — 직전에 다 읽은 offset부터. 새로 추가된 100줄만 다시 읽어야 한다.
    const incrStart = performance.now();
    let incrCount = 0;
    for await (const _line of iterateTranscriptRows(filePath, lastOffset)) {
      incrCount++;
    }
    const incrMs = performance.now() - incrStart;
    expect(incrCount).toBe(100);

    // 증분이 전량보다 유의미하게(적어도 5배) 빨라야 한다 — "파일을 처음부터 다시 읽지 않는다"는
    // 설계가 실측으로 확인된다. 절대 시간이 아니라 상대 배율로 단언해 환경 편차에 안전하다.
    expect(incrMs).toBeLessThan(fullMs / 5);
  }, 30_000);
});

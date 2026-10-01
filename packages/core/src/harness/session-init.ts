/**
 * core/src/harness/session-init.ts — 봉인 세션에 플러그인 슬래시 커맨드가 실렸는가를 **구조 신호**로
 * 판정한다(순수 함수, I/O 없음). `claude -p --output-format stream-json --verbose`의 첫
 * `{"type":"system","subtype":"init"}` 이벤트는 그 세션이 쓸 수 있는 `slash_commands`를 싣는다.
 *
 * ⚠️ **왜 오류 문구 매칭을 버렸나**(CLI 2.1.286 실측, 2026-10-02). 예전 판정은 "Unknown command"류
 * 문구가 **없으면** 인식된 것으로 읽었다. 그런데 이 버전은 모르는 슬래시 커맨드를 거부하지 않고 모델에
 * 그대로 넘긴다 — 거부 문구 자체가 사라져 봉인 상태와 무관하게 항상 "인식됨"이 됐다. 부정 신호의
 * 부재를 양성으로 읽는 판정은 하네스가 문구를 바꾸는 순간 무너진다. 같은 플래그로 띄운 실측:
 * 봉인 세션 `slash_commands` 0건 · 비봉인 세션은 해당 커맨드 포함 — 이 신호는 두 상태를 가른다.
 *
 * 봉인 검증(`gen/seal-live-test.ts`)과 버전 불일치 프리플라이트(`probe/harness/spawn-claude.ts`)가
 * **이 함수 하나를 같이 쓴다** — 같은 판정을 두 자리에 베끼면 한쪽만 고쳐진다(이번 드리프트가 그랬다).
 */

export type SealedPluginCommandVerdict = "confirmed_unrecognized" | "recognized" | "unmeasured";

/**
 * stream-json stdout의 **모든** init 이벤트에서 `slash_commands`를 꺼낸다(보안 심사 L — 첫 것만 보지 않는다).
 * init이 하나도 없거나 어느 하나라도 형태가 다르면 `null`(못 잼).
 */
export function parseInitSlashCommands(streamJsonStdout: string): string[][] | null {
  const lists: string[][] = [];
  for (const line of streamJsonStdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // stream-json이 아닌 줄(경고 등)은 건너뛴다
    }
    if (typeof event !== "object" || event === null) continue;
    const e = event as { type?: unknown; subtype?: unknown; slash_commands?: unknown };
    if (e.type !== "system" || e.subtype !== "init") continue;
    const list = e.slash_commands;
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) return null;
    lists.push(list as string[]);
  }
  return lists.length === 0 ? null : lists;
}

/**
 * 봉인 세션에 커맨드가 실렸는가. **통과 조건은 실측 상태 그대로 — init이 있고 모든 init의 `slash_commands`가
 * 비어 있을 때뿐이다**(보안 심사 M: `:` 네임스페이스만 보면 사용자 커맨드·스킬이 통과했다). 두 호출 자리는
 * 모두 봉인 프로파일 플래그(`--disable-slash-commands` 포함)로 띄우므로 실측이 0건이다 — `--safe-mode`만
 * 쓰면 내장 커맨드가 실려(실측 56건) 이 규칙과 맞지 않는다. `installedPluginCommand`는 판정에 쓰지 않고
 * 프롬프트로만 쓴다(형태 검사만 한다).
 */
export function judgeSealedPluginCommand(streamJsonStdout: string, installedPluginCommand: string): SealedPluginCommandVerdict {
  if (installedPluginCommand.trim().replace(/^\//, "").length === 0) return "unmeasured";
  const lists = parseInitSlashCommands(streamJsonStdout);
  if (lists === null) return "unmeasured";
  return lists.every((l) => l.length === 0) ? "confirmed_unrecognized" : "recognized";
}

/**
 * cli/src/flags.ts — 쓰기 명령(`mcp`·`move`)의 엄격한 플래그 파서. 알려진 `--flag <값>` 쌍만 받는다.
 * 오타(`--projet`)·`--x=y` 형태·반복·위치 인자·값 없는 플래그를 **조용히 무시하지 않고** 거부한다 — 무시하면 선택자가 "없음"으로
 * 읽혀 기본값(cwd 프로젝트, user 스코프 등)으로 바뀌어, 사용자가 지정한 것과 다른 대상을 쓴다.
 * 거부면 `null`을 돌려준다(호출자가 사용법을 낸다).
 */
export function parseStrictFlags(args: readonly string[], valueFlags: readonly string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!valueFlags.includes(token) || Object.hasOwn(out, token)) return null;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) return null;
    out[token] = value;
    i++;
  }
  return out;
}

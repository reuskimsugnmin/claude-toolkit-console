/**
 * probe/src/frontmatter.ts — 최소 YAML frontmatter 파서. `SKILL.md`의 `name`/`description` 같은
 * 단일 라인 키:값 쌍만 다룬다. 전체 YAML 파서(중첩·리스트 등)는 필요 없다 — 필요해지면 그건
 * `gen`(Step 4)의 몫이고, 그때는 M3(YAML safe load)의 안전 파서를 쓴다. 여기서는 승인된 런타임
 * 의존성이 `zod` 하나뿐이라(착수 조건 C5) 별도 YAML 라이브러리를 들이지 않는다.
 */
export function parseSimpleFrontmatter(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const result: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === "---") break;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

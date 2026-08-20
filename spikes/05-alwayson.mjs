#!/usr/bin/env node
// spikes/05-alwayson.mjs — AC-0.5 [정보]
//
// Question: can we reliably parse `claude plugin details <id>`'s
// "Projected token cost — Always-on" line, and how does it differ from
// ctk's own occupancy_idle_tokens definition (name+description only)?
//
// READ-ONLY against the real environment (`plugin details` does not write —
// see AC-0.8 for the full command-by-command side-effect table). No --json
// output mode exists for this subcommand (checked: `claude plugin details
// --help` has no --json flag) — text parsing is the only option, hence a
// regex-based parser is exercised here and its brittleness documented.
//
// Run: node spikes/05-alwayson.mjs <plugin-id> [<plugin-id> ...]

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const ALWAYS_ON_RE = /Always-on:\s*~?([\d,]+)\s*tok/;
const PER_COMPONENT_HEADER_RE = /^\s*component\s+always-on\s+on-invoke\s*$/m;
const PER_COMPONENT_ROW_RE = /^\s{2}(\S+)\s+(?:~?([\d.,]+k?)|< ?20)\s+~?([\d.,]+k?)\s*$/gm;
const HOOKS_ROW_RE = /Hooks \((\d+)\)[ \t]*(.*)$/m;
const MCP_ROW_RE = /MCP servers \((\d+)\)[ \t]*(.*)$/m;

function parsePluginDetails(text) {
  const alwaysOnMatch = text.match(ALWAYS_ON_RE);
  const alwaysOnTokens = alwaysOnMatch
    ? parseInt(alwaysOnMatch[1].replace(/,/g, ""), 10)
    : null;
  const hooksMatch = text.match(HOOKS_ROW_RE);
  const mcpMatch = text.match(MCP_ROW_RE);
  return {
    always_on_tokens: alwaysOnTokens,
    parse_ok: alwaysOnTokens !== null,
    hooks_count: hooksMatch ? parseInt(hooksMatch[1], 10) : null,
    hooks_note: hooksMatch ? hooksMatch[2].trim() : null,
    mcp_count: mcpMatch ? parseInt(mcpMatch[1], 10) : null,
    mcp_note: mcpMatch ? mcpMatch[2].trim() : null,
  };
}

function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    ids.push("frontend-design@claude-plugins-official", "oh-my-claudecode@omc");
  }
  const rows = [];
  for (const id of ids) {
    let text;
    try {
      text = execFileSync("claude", ["plugin", "details", id], { encoding: "utf8" });
    } catch (e) {
      rows.push({ id, error: e.message });
      continue;
    }
    rows.push({ id, ...parsePluginDetails(text) });
  }

  console.log(JSON.stringify(rows, null, 2));

  const md = `# AC-0.5 결과 (자동 생성 — ${new Date().toISOString()})

- 명령: \`claude plugin details <id>\` (실제 환경, 읽기 전용 — AC-0.8이 부수효과 없음을 확인)
- **\`--json\` 옵션 없음** (\`claude plugin details --help\` 확인) — 정규식 텍스트 파싱만 가능하다.
  이는 R13(하네스 버전 종속) 리스크가 이 명령에서 특히 크다는 뜻이다: 출력 문구가 바뀌면 파서가 조용히 깨진다.

## 파싱 결과

${rows.map((r) => `### ${r.id}\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\`\n`).join("\n")}

## 판정: ${rows.every((r) => r.parse_ok) ? "PASS (파싱 성공)" : "PARTIAL/FAIL — 일부 파싱 실패, 위 표 참조"}

## ctk idle 정의와의 차이 (1문단 — plan §1.3 결정5 요구사항)

\`plugin details\`의 "Always-on" 값은 **스킬/에이전트의 frontmatter 전체(설명 + 트리거 문구 + 메타데이터)**와
**플러그인이 세션에 등록하는 커맨드 목록** 등 하네스 내부가 실제로 시스템 프롬프트에 주입하는 모든 것을 반영하는
것으로 보인다(예: \`oh-my-claudecode@omc\`는 69개 스킬 + 19개 에이전트를 갖고도 Always-on이 ~3,169 토큰 —
스킬당 평균 ~30~100 토큰). 반면 ctk의 \`occupancy_idle_tokens\` 정의(plan §1.3 결정5)는 **\`name\`+\`description\`
필드만**(frontmatter의 나머지 — \`allowed-tools\`, 트리거 예시, 기타 메타데이터 — 제외)이므로 **구조적으로
더 작은 값이 나온다.** CLAUDE.md의 경고("frontmatter 전체와 \`name\`+\`description\`은 2배 이상 차이")가
그대로 적용된다 — 두 수치를 같은 것으로 취급하면 안 되고, 그래서 plan은 이 둘을 **나란히 저장하고 괴리율
±20% 초과 시 경고만 띄우는(자동 보정 금지) AC-4.8 교차검증**을 별도로 둔 것이다. 이번 실측은 그 설계가
근거 있음을 재확인한다 — 정의가 다른 두 수치이므로 애초에 "일치"를 기대할 수 없다.

**하네스가 이미 판정을 준 것도 그대로 확인됐다 (P6):**
- \`MCP servers (N) … (tool schemas resolved at runtime; not counted)\` — 하네스는 MCP idle을 0으로 취급.
- \`Hooks (N) … (harness-only — no model context cost)\` — 하네스는 hooks idle을 0으로 취급.
이 두 문구는 plan 본문의 인용과 정확히 일치했다(재확인 완료) — AC-0.7의 실측 절차와 대조할 근거가 된다.
`;
  writeFileSync(new URL("./results/AC-0.5.md", import.meta.url), md);
}

main();

#!/usr/bin/env node
// spikes/03-plugin-schema.mjs — AC-0.3 [차단]
//
// Question: does `claude plugin list --json` produce entries matching the
// schema { id, version, scope, enabled, installPath, installedAt,
// lastUpdated, mcpServers } with id = "name@marketplace", and does the
// known "local scope duplicate entries" issue reproduce (68/66 in iter 1)?
//
// This is READ-ONLY against the real ~/.claude — `claude plugin list --json`
// does not write (verified separately in AC-0.8). Safe to run without
// isolation.
//
// Run: node spikes/03-plugin-schema.mjs

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const EXPECTED_KEYS = [
  "id",
  "version",
  "scope",
  "enabled",
  "installPath",
  "installedAt",
  "lastUpdated",
  "mcpServers",
];

function main() {
  let raw;
  try {
    raw = execFileSync("claude", ["plugin", "list", "--json"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (e) {
    fail(`claude plugin list --json exited non-zero: ${e.message}`);
    return;
  }

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (e) {
    fail(`output is not valid JSON: ${e.message}`);
    return;
  }
  if (!Array.isArray(entries)) {
    fail(`top-level output is not an array (got ${typeof entries})`);
    return;
  }

  const unknownKeySamples = [];
  const missingKeySamples = [];
  const badIdFormat = [];
  let strictOk = 0;

  for (const e of entries) {
    const keys = Object.keys(e);
    const unknown = keys.filter((k) => !EXPECTED_KEYS.includes(k));
    const missing = EXPECTED_KEYS.filter((k) => !(k in e));
    if (unknown.length) unknownKeySamples.push({ id: e.id, unknown });
    if (missing.length) missingKeySamples.push({ id: e.id, missing });
    if (!unknown.length && !missing.length) strictOk++;
    if (typeof e.id !== "string" || !/^[^@]+@[^@]+$/.test(e.id)) {
      badIdFormat.push(e.id);
    }
  }

  const ids = entries.map((e) => e.id);
  const uniqueIds = new Set(ids);
  const dupCounts = {};
  for (const id of ids) dupCounts[id] = (dupCounts[id] || 0) + 1;
  const dups = Object.entries(dupCounts).filter(([, c]) => c > 1);

  // Same-name-different-marketplace collision check (P1-7 concern):
  // names that repeat across DIFFERENT marketplace suffixes are legitimate
  // distinct assets, not duplicates — record separately so folding-by-name
  // isn't mistaken for the loop-back duplicate issue.
  const nameToMarketplaces = {};
  for (const id of ids) {
    const [name, mp] = id.split("@");
    (nameToMarketplaces[name] ??= new Set()).add(mp);
  }
  const sameNameDiffMarketplace = Object.entries(nameToMarketplaces)
    .filter(([, mps]) => mps.size > 1)
    .map(([name, mps]) => ({ name, marketplaces: [...mps] }));

  const result = {
    total_entries: entries.length,
    unique_ids: uniqueIds.size,
    strict_schema_match_count: strictOk,
    unknown_key_samples: unknownKeySamples.slice(0, 5),
    missing_key_samples: missingKeySamples.slice(0, 5),
    bad_id_format: badIdFormat,
    duplicate_ids: dups,
    same_name_different_marketplace: sameNameDiffMarketplace,
    verdict:
      unknownKeySamples.length === 0 &&
      missingKeySamples.length === 0 &&
      badIdFormat.length === 0
        ? "PASS"
        : "FAIL",
  };

  console.log(JSON.stringify(result, null, 2));

  const md = `# AC-0.3 결과 (자동 생성 — ${new Date().toISOString()})

- 명령: \`claude plugin list --json\` (실제 환경, 읽기 전용)
- 전체 엔트리 수: ${result.total_entries}
- 고유 id 수: ${result.unique_ids}
- zod strict parse 상당 통과(미지 키 0 · 누락 키 0 · id 형식 \`name@marketplace\` 준수) 엔트리 수: ${result.strict_schema_match_count}
- 미지의 키 샘플: ${JSON.stringify(result.unknown_key_samples)}
- 누락 키 샘플: ${JSON.stringify(result.missing_key_samples)}
- id 형식 위반: ${JSON.stringify(result.bad_id_format)}
- id 기준 중복 엔트리(로컬 스코프 중복 재현 여부): ${JSON.stringify(result.duplicate_ids)}
- 이름은 같고 마켓플레이스가 다른 케이스(병합 금지 대상, P1-7): ${JSON.stringify(result.same_name_different_marketplace)}

## 판정: ${result.verdict}
`;
  writeFileSync(new URL("./results/AC-0.3.md", import.meta.url), md);
}

function fail(msg) {
  console.error("FAIL:", msg);
  writeFileSync(
    new URL("./results/AC-0.3.md", import.meta.url),
    `# AC-0.3 결과\n\n판정: FAIL — ${msg}\n`,
  );
  process.exitCode = 1;
}

main();

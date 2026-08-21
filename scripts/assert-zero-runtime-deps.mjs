#!/usr/bin/env node
// scripts/assert-zero-runtime-deps.mjs — 착수 조건 C5(iter 8 · L1)의 공급망 위험 통제를
// 검증 가능한 형태로 고정한다.
//
// 입력: `pnpm ls -r --prod --json`의 표준입력(파이프). 워크스페이스 내부 패키지 간 참조는
// pnpm이 `version: "link:..."`로 표시한다 — 이는 npm registry에서 내려받는 3rd-party 런타임
// 의존성이 아니라 같은 저장소 안의 다른 패키지이므로 위반으로 세지 않는다. registry에서 실제로
// resolve된 외부 패키지만 위반이다.
//
// `check-forbidden-deps.mjs`(추정 토크나이저 금지 — P2-6)와 목적이 다르므로 합치지 않는다(§6.2):
// 전자는 "틀린 의존성"을, 이 스크립트는 "승인되지 않은 런타임 의존성의 유입"을 막는다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 승인된 런타임 의존성. 목록에 없는 외부 패키지가 런타임 의존성으로 들어오면 위반이다.
//
// 왜 "0개"가 아니라 "승인 목록"인가: 보안 재심(iter 8 · L1)이 관찰한 "런타임 의존성 0개"는
// core 패키지가 만들어지기 전 시점의 상태였고, 그것을 규칙으로 승격하면 결정 1과 모순된다 —
// 결정 1은 "zod 하나로 타입·런타임 검증을 동시 확보"를 채택했고, 스키마 검증은 런타임에
// 실행되므로 devDependency가 될 수 없다. 목록을 명시하면 공급망 통제의 실질(새 의존성이
// 몰래 들어오면 실패한다)은 유지되면서 현실과 어긋나지 않는다.
//
// 이 목록에 항목을 추가하는 것은 정책 변경이며 리뷰 대상이다. 추가할 때는 왜 런타임이어야
// 하는지를 여기 주석으로 남긴다.
export const APPROVED_RUNTIME_DEPS = new Set([
  "zod", // 결정 1: 스키마·런타임 검증 엔진. 파싱이 런타임에 실행되므로 dev로 둘 수 없다.
  // ADR-005(점유 토큰 실측)가 명시한 측정 수단. `messages.countTokens` 한 메서드만 쓴다.
  // fetch로 대체하지 않는 이유: TypeScript 프로젝트에서는 공식 SDK가 기본이고 raw HTTP로
  // 내려가는 것은 명시적 안티패턴이다(claude-api 스킬 Output Requirement). SDK가 4단계
  // 크레덴셜 체인(API 키 → AUTH_TOKEN → ant 프로파일 → WIF)을 해석해주는 것도 직접 구현
  // 대상이 아니다 — P6(하네스가 주는 것은 재발명하지 않는다).
  "@anthropic-ai/sdk",
]);

function isWorkspaceLink(depEntry) {
  return typeof depEntry?.version === "string" && depEntry.version.startsWith("link:");
}

/**
 * `pnpm ls -r --prod --json`의 파싱 결과(패키지 배열)에서, 패키지별 "승인되지 않은 외부
 * 런타임 의존성" 이름 목록을 구한다. 워크스페이스 내부 link: 의존성과 승인 목록의 항목은
 * 제외한다.
 * @param {unknown[]} pnpmLsEntries
 * @param {Set<string>} [approved] 승인된 런타임 의존성 이름 집합
 * @returns {{ package: string, deps: string[] }[]}
 */
export function findExternalRuntimeDeps(pnpmLsEntries, approved = APPROVED_RUNTIME_DEPS) {
  const violations = [];
  for (const pkg of pnpmLsEntries) {
    const deps = pkg && typeof pkg === "object" ? (pkg.dependencies ?? {}) : {};
    const external = Object.entries(deps)
      .filter(([, entry]) => !isWorkspaceLink(entry))
      .map(([name]) => name)
      .filter((name) => !approved.has(name));
    if (external.length > 0) {
      violations.push({ package: pkg.name ?? "(unknown)", deps: external });
    }
  }
  return violations;
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function main() {
  let raw;
  try {
    raw = readStdin();
  } catch (err) {
    console.error(`stdin을 읽을 수 없다: ${err instanceof Error ? err.message : String(err)}`);
    console.error("사용법: pnpm ls -r --prod --json | node scripts/assert-zero-runtime-deps.mjs");
    process.exitCode = 1;
    return;
  }

  if (raw.trim().length === 0) {
    console.error("입력이 비어있다 — pnpm ls -r --prod --json | node scripts/assert-zero-runtime-deps.mjs 로 실행한다");
    process.exitCode = 1;
    return;
  }

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (err) {
    console.error(`pnpm ls --json 출력 파싱 실패: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(entries)) {
    console.error("pnpm ls -r --json 출력은 배열이어야 한다");
    process.exitCode = 1;
    return;
  }

  const violations = findExternalRuntimeDeps(entries);
  if (violations.length > 0) {
    console.error("승인되지 않은 런타임 의존성 (착수 조건 C5 · §4.0):");
    for (const v of violations) {
      console.error(`  ${v.package}: ${v.deps.join(", ")}`);
    }
    console.error(
      `승인 목록: ${[...APPROVED_RUNTIME_DEPS].join(", ")} — 추가는 정책 변경이며 리뷰 대상이다.`,
    );
    process.exitCode = 1;
    return;
  }

  const approved = [...APPROVED_RUNTIME_DEPS].join(", ");
  console.log(
    `런타임 의존성 확인 — 워크스페이스 ${entries.length}개 패키지 전부 통과 (승인 목록: ${approved})`,
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

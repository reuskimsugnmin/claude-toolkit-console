#!/usr/bin/env node
// 공개 저장소 위생 가드 (CLAUDE.md "⚠️ 이 저장소는 공개다").
//
// `.gitignore`는 이미 추적 중인 파일을 막지 못한다(실측된 함정) — 그래서 이 스크립트는
// "무시 목록"이 아니라 `git ls-files`(추적 대상 파일 전체)를 실제로 열어 내용을 검사한다.
//
// 검출 대상: 실제 macOS/Linux 홈 절대경로 패턴(/Users/*, /home/*) + 이 스크립트를 실행하는
// 머신의 실제 $HOME/hostname 리터럴. 개인 사용량 수치·설치 목록처럼 패턴화할 수 없는 항목은
// 이 스크립트의 범위 밖이며 리뷰로 보완한다(자동화의 한계를 문서로 명시).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 절대경로 시작(문자열 시작·따옴표·공백·`=`·`(`·`:`) 뒤에 오는 경우만 매칭한다 — 부정 lookbehind로
 * "fixtures/home/.claude" 같은 상대경로 세그먼트 안에 우연히 "/home/"이 등장하는 오탐을 막는다.
 * @type {{ name: string, regex: RegExp }[]}
 */
const STATIC_PATTERNS = [
  { name: "macos_home_path", regex: /(?<![\w./-])\/Users\/[^"'\\\s)]+/g },
  { name: "linux_home_path", regex: /(?<![\w./-])\/home\/[^"'\\\s)]+/g },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 실행 중인 머신의 실제 HOME/hostname 리터럴도 검사 대상에 추가한다 (실측 시점 방어). */
export function buildPatterns() {
  const patterns = [...STATIC_PATTERNS];
  const home = homedir();
  const host = hostname();
  if (home && home.length > 3) {
    patterns.push({ name: "actual_homedir_literal", regex: new RegExp(escapeRegExp(home), "g") });
  }
  if (host && host.length > 1) {
    patterns.push({
      name: "actual_hostname_literal",
      regex: new RegExp(`\\b${escapeRegExp(host)}\\b`, "g"),
    });
  }
  return patterns;
}

/**
 * 검사 대상에서 빼는 경로. 전부 "실제 개인 데이터가 아니라 정책/테스트 서술 목적으로
 * 위반형 문자열을 의도적으로 인용한다"는 공통 사유다 — 무분별하게 넓히지 않는다.
 */
export const EXEMPT_PATH_PREFIXES = [
  "scripts/hygiene-check.mjs", // 이 파일 자신 — 패턴 문자열을 코드로 서술
  "scripts/test/hygiene-check.test.ts", // 탐지기 자체를 테스트하려고 위반형 문자열을 의도적으로 담는다
  "packages/core/test/path-normalize-hygiene.test.ts", // 위생 검사 유틸리티(findRawPathLeaks)의 단위 테스트
  "packages/sync/test/stores.test.ts", // assertNoRawPathLeaks가 실제로 거부하는지 확인하려고 위반형 문자열을 의도적으로 담는다
  "packages/sync/test/usage-stores.test.ts", // 위와 동일 사유 — offset-cache-store의 위생 검사(AC-1.7)를 테스트
  ".omc/",
];

export function isExempt(relPath) {
  return EXEMPT_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * **구조 서명으로 잡는 검출기.** 위 정규식들은 "경로 리터럴"을 찾는데, `ctk web
 * --export-view-model`의 산출물에는 절대경로가 **하나도 없다** — 안 B가 마지막 세그먼트만
 * 싣도록 설계했기 때문이다. 그래서 이 저장소에 커밋해도 위 검사를 **전부 통과한다.** 실제
 * 프로젝트 디렉터리 이름·설치 목록·머신 id·개인 사용량 수치가 그대로 들어 있는데도 그렇다
 * (심사 L4). 탐지기가 방어를 우회당한 게 아니라 **그 축을 보지 않는다.**
 *
 * 값만 봐서는 개인 데이터인지 알 수 없다. 대신 **그 파일이 무엇인지**는 안다 — ctk 산출물의
 * 구조 서명이 있으면 그것은 이 머신의 실측 결과이고, 이 저장소에 있어서는 안 된다.
 *
 * 서명은 최상위 키 **전체 일치**로 본다. 하나만 보면 합성 픽스처가 걸린다.
 */
const CTK_EXPORT_SIGNATURES = [
  {
    name: "exported_view_model",
    // cli/src/commands/web.ts의 `runExportViewModel`이 쓰는 뷰모델 최상위 키.
    requiredKeys: ["schema_version", "machine_id", "assets", "usage", "freshness"],
  },
];

/**
 * 확장자가 아니라 **내용이 JSON 객체인가**로 대상을 정한다. `--export-view-model`은 임의의
 * 경로를 받으므로 `vm.txt`·확장자 없음도 가능하다 — 확장자로 거르면 그 경우가 통째로 샌다.
 */
export function scanStructuredExport(relPath, content) {
  if (isExempt(relPath)) return [];
  if (!content.trimStart().startsWith("{")) return [];
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return []; // JSON이 아니면 ctk 산출물도 아니다
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return CTK_EXPORT_SIGNATURES.filter((sig) => sig.requiredKeys.every((key) => key in parsed)).map((sig) => ({
    pattern: sig.name,
    match: sig.requiredKeys.join("+"),
    file: relPath,
  }));
}

export function scanFileContent(relPath, content, patterns) {
  if (isExempt(relPath)) return [];
  const violations = [];
  for (const { name, regex } of patterns) {
    const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    let match;
    while ((match = re.exec(content)) !== null) {
      violations.push({ pattern: name, match: match[0], file: relPath });
    }
  }
  return violations;
}

function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out.split("\n").filter((line) => line.length > 0);
}

export function runHygieneCheck({ patterns = buildPatterns(), files = listTrackedFiles() } = {}) {
  const violations = [];
  for (const relPath of files) {
    let content;
    try {
      content = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
    } catch {
      continue; // 바이너리 디코드 실패·삭제된 파일 등은 건너뛴다
    }
    violations.push(...scanFileContent(relPath, content, patterns));
    violations.push(...scanStructuredExport(relPath, content));
  }
  return { violations, filesScanned: files.length };
}

/** 위반 종류별 복구 안내 — 거부에는 빠져나갈 길을 함께 준다(안전 원칙 6). */
const REMEDY = {
  exported_view_model:
    "ctk 뷰모델 export는 이 머신의 실측 결과다. 저장소에서 제거하고(git rm --cached) " +
    ".gitignore에 넣는다 — 공유가 필요하면 동기화용 private 저장소로 보낸다.",
};

function main() {
  const { violations, filesScanned } = runHygieneCheck();
  if (violations.length > 0) {
    console.error(`공개 저장소 위생 위반 ${violations.length}건 발견:`);
    for (const v of violations.slice(0, 50)) {
      console.error(`  [${v.pattern}] ${v.file}: ${v.match}`);
    }
    for (const pattern of new Set(violations.map((v) => v.pattern))) {
      if (REMEDY[pattern]) console.error(`\n  → ${pattern}: ${REMEDY[pattern]}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`위생 검사 통과 — 추적 파일 ${filesScanned}개, 위반 0건`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

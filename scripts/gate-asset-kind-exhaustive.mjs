#!/usr/bin/env node
// scripts/gate-asset-kind-exhaustive.mjs — B1 Step 2 「타입 축 주입 게이트」(AC-3).
//
// 런타임 테스트로는 `AssetKind`에 새 값이 추가됐을 때 컴파일이 실제로 깨지는지 못 잡는다
// (`@ts-expect-error` 컴파일 테스트도 떼어내면 무력하다 — CLAUDE.md). 이 게이트는 저장소
// **사본**에 프로브 kind 값을 주입하고 `tsc -b`를 돌려, ②→①로 전환한 지점이 **전부** 실제로
// 컴파일 에러를 내는지 확인한다.
//
// ⚠️ **순진한 형태는 조용히 무효였다(실측, .omc/plans/ctk-b1-plan.md §Step2).** 패키지별
// `node_modules`를 원본으로 심볼릭 링크하면 `@ctk/core` 같은 워크스페이스 상대 심볼릭 링크가
// **실제 경로 기준**으로 원본 트리를 가리켜, 사본이 원본을 타입체크하고 `tsc -b`가 EXIT=0을
// 냈다. `fs.cpSync({dereference:false})`로도 같은 함정이 재현된다 — Node가 상대 심볼릭 링크를
// **절대경로로 재작성**해 복사한다(이 파일 작성 중 실측). 오직 `tar`(스트림 그대로 재현)만
// 심볼릭 링크의 **원문 상대 경로**를 보존한다. 그래서:
//   1. 저장소 루트를 `tar`로 사본에 복사한다(루트 `node_modules`·`.git`은 제외 — 인자 목록에서
//      아예 뺀다. `--exclude` 플래그는 bsdtar에서 경로 전체가 아니라 베이스네임까지 매칭돼
//      `packages/*/node_modules`까지 통째로 사라지는 함정이 있어 쓰지 않는다, 실측).
//   2. 루트 `node_modules`만 원본으로 심볼릭 링크한다(제3자 의존성은 공유해도 안전하다 — 이번
//      실험이 건드리는 것은 `@ctk/core`뿐이다). 패키지별 `node_modules`는 `tar`가 이미 원문
//      그대로 복사했으므로 사본 안에서 자기완결적으로 해석된다.
//   3. **자기완결 확인(양성 대조군)** — `realpathSync`로 `@ctk/*` 심볼릭 링크가 사본 안을
//      가리키는지 단언한다. 아니면 게이트는 무엇을 주입하든 무의미하므로 여기서 즉시 실패한다.
//   4. **기준선** — 주입 전 `tsc -b`가 에러 0인지 확인한다. 여기서 에러가 나면 사본 자체가
//      깨져 있다는 뜻이니 게이트가 아니라 사본 절차를 의심해야 한다.
//   5. 프로브 kind(`__probe__`)를 `AssetKindSchema`에 주입하고 `*.tsbuildinfo`·`dist`를 지운 뒤
//      `tsc -b`를 다시 돌린다.
//   6. **판정은 "실패했는가"가 아니라 "선언한 파일 목록이 전부 실패했는가"다.** 하나라도
//      에러를 안 내면 게이트 실패 — 총 에러 0건이어도 실패다(등재 ≠ 도달).
//
// `packages/web/server/ui-page.ts`의 `<option>` 목록(#20)은 HTML 문자열이라 타입 축이 안 닿는다
// — 런타임 테스트(`packages/web/test/ui-doc-state.test.ts`)가 대신 지킨다. 이 파일의 범위 밖이다.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROBE_VALUE = "__probe__";
const ASSET_SCHEMA_REL = "packages/core/src/schema/asset.ts";

/**
 * B1 Step 2에서 ②(조용히 흘림)를 ①(exhaustive switch / Record 전체키 / 스키마 유도)로 전환한
 * 지점. 프로브 kind를 주입하면 **전부** 컴파일 에러를 내야 한다 — 하나라도 안 내면 그 지점은
 * 여전히 조용히 흘리고 있다는 뜻이다.
 */
const DECLARED_BREAK_FILES = [
  "packages/core/src/schema/asset.ts", // assetKindRequiresMarketplace — exhaustive switch
  "packages/core/src/view/view-model.ts", // toMcpStateView — exhaustive switch
  "packages/actuator/src/apply/mcp-reject.ts", // classifyMoveRejection — exhaustive switch
  "packages/cli/src/commands/measure.ts", // computeOccupancy — exhaustive switch
  "packages/gen/src/source-trust.ts", // determineSourceTrust — exhaustive switch
  "packages/gen/src/source-resolve.ts", // resolveAssetSource — 기존 최고모범(변경 없음, 계속 검증)
  "packages/cli/src/commands/scan.ts", // countAssetKinds — Record<AssetKind,number> 전체 키
];

/** 워크스페이스 심볼릭 링크가 실재하는 패키지들 — 자기완결 확인 대상. */
const WORKSPACE_LINKED_PACKAGES = [
  "packages/actuator/node_modules/@ctk/core",
  "packages/actuator/node_modules/@ctk/probe",
  "packages/cli/node_modules/@ctk/core",
  "packages/gen/node_modules/@ctk/core",
  "packages/gen/node_modules/@ctk/probe",
  "packages/gen/node_modules/@ctk/sync",
  "packages/sync/node_modules/@ctk/core",
  "packages/probe/node_modules/@ctk/core",
  "packages/web/node_modules/@ctk/core",
];

function fail(message) {
  console.error(`FAIL gate:asset-kind — ${message}`);
  process.exitCode = 1;
}

function run(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, ...opts });
}

/** 저장소를 사본으로 복사한다 — `tar`로 스트리밍해 심볼릭 링크의 원문 상대 경로를 보존한다. */
function copyRepo(copyRoot) {
  mkdirSync(copyRoot, { recursive: true });
  const entries = readdirSync(REPO_ROOT).filter((e) => e !== "node_modules" && e !== ".git");
  const tarC = run("tar", ["-cf", "-", "--", ...entries], { cwd: REPO_ROOT, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 });
  if (tarC.status !== 0) throw new Error(`tar 압축 실패: ${tarC.stderr?.toString() ?? ""}`);
  const tarX = spawnSync("tar", ["-xf", "-"], { cwd: copyRoot, input: tarC.stdout });
  if (tarX.status !== 0) throw new Error(`tar 해제 실패: ${tarX.stderr?.toString() ?? ""}`);
  // 루트 node_modules만 원본으로 심볼릭 링크한다 — 제3자 의존성(zod 등)은 이 실험이 건드리지
  // 않으므로 공유해도 안전하다.
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(copyRoot, "node_modules"));
}

/** 양성 대조군 — `@ctk/*` 워크스페이스 심볼릭 링크가 사본 **안**을 가리키는지 확인한다. */
function assertSelfContained(copyRoot) {
  // ⚠️ macOS는 tmpdir()가 `/var/...`를 주지만 실제 경로는 `/private/var/...`다(`/var`가
  // 심볼릭 링크). `realpathSync`로 얻은 링크의 목적지는 항상 완전히 해석된 경로이므로, 비교
  // 기준도 `copyRoot`가 아니라 `realpathSync(copyRoot)`여야 한다 — 아니면 진짜 자기완결인데도
  // 이 확인 자체가 오탐으로 실패한다.
  const realCopyRoot = realpathSync(copyRoot);
  for (const rel of WORKSPACE_LINKED_PACKAGES) {
    const linkAbs = path.join(copyRoot, rel);
    let resolved;
    try {
      resolved = realpathSync(linkAbs);
    } catch (err) {
      throw new Error(`자기완결 확인 실패 — ${rel}을 realpath하지 못했다: ${String(err)}`);
    }
    if (!resolved.startsWith(realCopyRoot + path.sep) && resolved !== realCopyRoot) {
      throw new Error(
        `자기완결 확인 실패 — ${rel}이 사본 밖(${resolved})을 가리킨다. 사본이 원본을 타입체크하게 되므로 게이트가 무의미해진다.`,
      );
    }
  }
}

function runTsc(copyRoot) {
  return run("node_modules/.bin/tsc", ["-b", "tsconfig.json"], { cwd: copyRoot });
}

/** 기준선 — 주입 전 사본이 에러 0으로 컴파일되는지 확인한다. */
function assertBaselineClean(copyRoot) {
  const result = runTsc(copyRoot);
  if (result.status !== 0) {
    throw new Error(`기준선이 이미 깨져 있다(주입 전) — 사본 절차를 의심해야 한다:\n${result.stdout}${result.stderr}`);
  }
}

/** `AssetKindSchema`의 enum 배열에 프로브 값을 주입한다. */
function injectProbeKind(copyRoot) {
  const abs = path.join(copyRoot, ASSET_SCHEMA_REL);
  const src = readFileSync(abs, "utf8");
  const marker = 'z.enum(["plugin", "skill", "mcp", "cli", "agent", "command"])';
  if (!src.includes(marker)) {
    throw new Error(`프로브 주입 실패 — ${ASSET_SCHEMA_REL}에서 예상한 AssetKindSchema 선언을 찾지 못했다(문구가 바뀌었으면 이 게이트를 함께 갱신한다): ${marker}`);
  }
  const injected = src.replace(marker, marker.replace('"command"]', `"command", "${PROBE_VALUE}"]`));
  writeFileSync(abs, injected, "utf8");
}

/** `tsc -b`의 증분 캐시를 지워 이번 주입이 실제로 재컴파일되게 만든다. */
function clearBuildCache(copyRoot) {
  const rmArgs = [];
  for (const pkg of readdirSync(path.join(copyRoot, "packages"))) {
    const pkgDir = path.join(copyRoot, "packages", pkg);
    rmArgs.push(path.join(pkgDir, "dist"));
    for (const entry of readdirSync(pkgDir)) {
      if (entry.endsWith(".tsbuildinfo")) rmArgs.push(path.join(pkgDir, entry));
    }
  }
  for (const p of rmArgs) rmSync(p, { recursive: true, force: true });
}

/** 에러 줄(`path(line,col): error TSxxxx: ...`)에서 파일 경로 집합을 뽑는다. */
function extractErroredFiles(tscOutput, copyRoot) {
  const files = new Set();
  const re = /^(.+?)\(\d+,\d+\): error TS\d+:/gm;
  let m;
  while ((m = re.exec(tscOutput)) !== null) {
    const abs = path.isAbsolute(m[1]) ? m[1] : path.join(copyRoot, m[1]);
    files.add(path.relative(copyRoot, abs).split(path.sep).join("/"));
  }
  return files;
}

function main() {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "ctk-gate-asset-kind-"));
  const copyRoot = path.join(tmpRoot, "repo");
  try {
    copyRepo(copyRoot);
    assertSelfContained(copyRoot);
    assertBaselineClean(copyRoot);
    injectProbeKind(copyRoot);
    clearBuildCache(copyRoot);
    const result = runTsc(copyRoot);
    const erroredFiles = extractErroredFiles(result.stdout + result.stderr, copyRoot);

    const missing = DECLARED_BREAK_FILES.filter((f) => !erroredFiles.has(f));
    if (missing.length > 0) {
      fail(
        `선언한 ${DECLARED_BREAK_FILES.length}개 지점 중 ${missing.length}개가 프로브 kind 주입 후에도 컴파일 에러를 내지 않았다 — 여전히 조용히 흘린다:\n` +
          missing.map((f) => `  - ${f}`).join("\n") +
          `\n(참고: 실제로 에러가 난 파일 ${erroredFiles.size}개 — 총 에러 0건이어도 이 목록이 비어 있으면 실패다)`,
      );
      return;
    }
    console.log(
      `PASS gate:asset-kind — 선언한 ${DECLARED_BREAK_FILES.length}개 지점이 프로브 kind 주입 후 전부 컴파일 에러를 냈다(자기완결·기준선 확인 포함).`,
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();

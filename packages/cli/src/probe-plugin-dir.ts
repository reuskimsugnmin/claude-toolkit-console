import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProbeSkillDocument, withoutSection, type ProbeSkillDocument } from "@ctk/core";

/**
 * cli/src/probe-plugin-dir.ts — AC-3.3 진단용 임시 플러그인 디렉터리 생성(안 B).
 *
 * `gen`은 **스스로 어떤 파일도 쓰지 않는다**(계층 경계 — 산출물은 `sync` 경유). 그래서 실제
 * 디렉터리 생성은 쓰기가 허용된 `cli` 계층의 몫이다 — `sealed-cwd.ts`와 같은 이유·같은 자리다.
 *
 * ## 왜 임시 디렉터리인가
 *
 * `agent-probe`는 `--plugin-dir <경로>`로 스킬을 주입한다. 프로덕션 스킬을 그대로 넘기면
 * 에이전트가 `~/.config/ctk/config.json`을 읽어 **사용자의 실제 카탈로그**를 뒤진다(HOME이
 * 실제 홈이어야 인증이 살기 때문이다). 그래서 카탈로그 루트를 박은 사본을 임시로 만든다.
 *
 * ## ⚠️ 이 함수가 지키는 계약
 *
 * 사본은 프로덕션 원문과 **정확히 한 절**만 다르다. 그 판정은 `core`의 순수 변환이 하고,
 * 여기서는 **디스크에 쓴 결과가 그 판정과 일치하는지 되읽어 확인한다** — 쓰는 도중에 무언가
 * 끼어들면 "한 절만 달랐다"는 주장은 메모리 안에서만 참이 된다.
 */

/** 임시 디렉터리 접두 — 사후에 사람이 무엇인지 알아볼 수 있어야 한다. */
const PROBE_PLUGIN_PREFIX = "ctk-agent-probe-plugin-";

/** cwd 안에 합성 카탈로그를 놓을 자리. 이름이 곧 무엇인지 말한다. */
export const PROBE_CATALOG_DIR_NAME = "probe-catalog";

/** 원본 합성 카탈로그가 카탈로그 규약을 갖추지 못했으면 진단을 시작하지 않는다(안전 원칙 7). */
export class ProbeCatalogInvalidError extends Error {
  constructor(readonly sourceRoot: string) {
    super(
      `합성 카탈로그에 catalog/index.json이 없다 — ${sourceRoot}. ` +
        `--catalog 는 catalog/ 디렉터리를 담은 **부모**를 가리켜야 한다.`,
    );
    this.name = "ProbeCatalogInvalidError";
  }
}

/**
 * 합성 카탈로그를 **cwd 안으로** 복사하고 그 경로를 돌려준다.
 *
 * ## 왜 복사하는가 (실측 2026-08-22, AC-3.3 유료 진단 1회차)
 *
 * 처음에는 저장소 안의 픽스처 경로를 스킬 사본에 그대로 박았다. 에이전트는 스킬을 제대로
 * 발동했고 경로 규약도 정확히 이해했지만 **카탈로그를 한 줄도 읽지 못했다**:
 *
 * > `Read`는 권한 승인 대기 상태로 반환됐고, `grep`은 허용된 작업 디렉터리 밖이라 차단됐다
 *
 * `agent-probe`의 cwd는 상위 `.claude/` 가드 때문에 홈 밖 임시 디렉터리여야 하는데, 카탈로그는
 * 저장소 안에 있었다. 헤드리스 `-p` 세션에는 승인 프롬프트에 답할 사람이 없다.
 *
 * `--add-dir`로 열어주는 방법도 있지만 그것은 **자식이 닿는 파일시스템 범위를 넓히는 일**이라
 * 봉인 변경으로 넘어간다(안 B를 고른 이유가 봉인을 건드리지 않는 것이었다). cwd 안으로
 * 복사하면 범위를 넓히지 않고, 격리도 더 깨끗해진다 — 진단이 저장소 파일을 아예 보지 않는다.
 */
export function stageProbeCatalog(sourceCatalogRoot: string, cwd: string): string {
  const source = path.resolve(sourceCatalogRoot);
  if (!existsSync(path.join(source, "catalog", "index.json"))) throw new ProbeCatalogInvalidError(source);

  const staged = path.join(cwd, PROBE_CATALOG_DIR_NAME);
  // 이전 실행이 남긴 것을 지우고 새로 넣는다 — cwd는 B3 때문에 **고정 경로**라 누적된다.
  rmSync(staged, { recursive: true, force: true });
  cpSync(source, staged, { recursive: true });
  return staged;
}

/** 진단용 플러그인 이름. 합성 자산 이름과 겹치지 않게 `ctk-` 접두를 쓴다. */
export const PROBE_PLUGIN_NAME = "ctk-agent-probe";

/** 디스크에 쓴 사본이 순수 변환의 결과와 다르면 던진다 — 조용히 진행하지 않는다(안전 원칙 7). */
export class ProbeSkillWriteMismatchError extends Error {
  constructor(readonly skillPath: string) {
    super(
      `진단용 스킬 사본을 되읽었더니 생성 결과와 달랐다 — ${skillPath}. ` +
        `이 상태로 진단하면 무엇을 시험했는지 알 수 없으므로 중단한다.`,
    );
    this.name = "ProbeSkillWriteMismatchError";
  }
}

/**
 * 존재하지 않는 머신을 "이 로컬"로 삼으면 진단은 **설치 여부 미확인**만 관측하게 된다 —
 * 그건 스킬의 결함이 아니라 우리가 만든 조건이다. 시작 전에 거부한다(안전 원칙 7).
 */
export class ProbeMachineNotFoundError extends Error {
  constructor(readonly machineId: string, readonly catalogRoot: string) {
    super(
      `합성 카탈로그에 machines/${machineId} 가 없다 — ${catalogRoot}. ` +
        `--machine-id 로 카탈로그에 실재하는 머신을 지정한다.`,
    );
    this.name = "ProbeMachineNotFoundError";
  }
}

export interface ProbePluginDir {
  /** `--plugin-dir`에 넘길 경로. */
  pluginDir: string;
  /** 사본이 가리키는 카탈로그 루트(절대경로). */
  catalogRoot: string;
  /** 사본과 원문의 차이 — 호출자가 사용자에게 그대로 보여줄 수 있다. */
  skill: ProbeSkillDocument;
  /** 진단이 끝나면 지운다. 실패해도 던지지 않는다(진단 결과가 정리 실패에 묻히면 안 된다). */
  cleanup: () => void;
}

/**
 * 진단용 플러그인 디렉터리를 만든다. 구조는 하네스가 요구하는 최소형이다:
 *
 * ```
 * <tmp>/.claude-plugin/plugin.json
 * <tmp>/skills/toolkit-search/SKILL.md
 * ```
 *
 * 스킬 디렉터리 이름을 **`toolkit-search` 그대로** 쓴다 — 이름이 바뀌면 그것도 프로덕션과의
 * 차이가 되고, 안 B가 "한 절만 다르다"로 묶어 둔 값이 새어 나간다.
 */
export function createProbePluginDir(options: {
  skillSourcePath: string;
  catalogRoot: string;
  /** "이 로컬"로 삼을 머신 id. 카탈로그의 `machines/` 아래에 실제로 있어야 한다. */
  machineId: string;
}): ProbePluginDir {
  const original = readFileSync(options.skillSourcePath, "utf8");
  const catalogRoot = path.resolve(options.catalogRoot);
  if (!existsSync(path.join(catalogRoot, "machines", options.machineId))) {
    throw new ProbeMachineNotFoundError(options.machineId, catalogRoot);
  }
  const skill = buildProbeSkillDocument(original, { catalogRoot, machineId: options.machineId });

  const pluginDir = mkdtempSync(path.join(tmpdir(), PROBE_PLUGIN_PREFIX));
  chmodSync(pluginDir, 0o700);

  const manifestDir = path.join(pluginDir, ".claude-plugin");
  const skillDir = path.join(pluginDir, "skills", "toolkit-search");
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });

  writeFileSync(
    path.join(manifestDir, "plugin.json"),
    `${JSON.stringify(
      {
        name: PROBE_PLUGIN_NAME,
        description: "ctk AC-3.3 진단 전용 임시 플러그인 — 실제 툴이 아니며 진단이 끝나면 삭제된다.",
        version: "0.0.0",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const skillPath = path.join(skillDir, "SKILL.md");
  writeFileSync(skillPath, skill.document, "utf8");

  // 쓴 것을 되읽어 계약을 확인한다 — 메모리 안에서만 참인 주장을 진단 근거로 삼지 않는다.
  const written = readFileSync(skillPath, "utf8");
  const sameExceptOneSection =
    written === skill.document && withoutSection(written, skill.replacedHeading) === skill.untouchedSource;
  if (!sameExceptOneSection) {
    rmSync(pluginDir, { recursive: true, force: true });
    throw new ProbeSkillWriteMismatchError(skillPath);
  }

  return {
    pluginDir,
    catalogRoot,
    skill,
    cleanup: () => {
      try {
        rmSync(pluginDir, { recursive: true, force: true });
      } catch {
        // 정리 실패는 진단 결과를 무효로 만들지 않는다 — 임시 디렉터리는 OS가 결국 회수한다.
      }
    },
  };
}

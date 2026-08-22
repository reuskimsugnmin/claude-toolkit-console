import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
export function createProbePluginDir(options: { skillSourcePath: string; catalogRoot: string }): ProbePluginDir {
  const original = readFileSync(options.skillSourcePath, "utf8");
  const catalogRoot = path.resolve(options.catalogRoot);
  const skill = buildProbeSkillDocument(original, catalogRoot);

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

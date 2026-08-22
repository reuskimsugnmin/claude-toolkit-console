import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SKILL_DESCRIPTION_BUDGET_TOKENS,
  DEFAULT_TOKENIZER_MODEL,
  lintSkillBody,
  splitSkillDocument,
  type OccupancyValue,
  type SkillBodyLintResult,
} from "@ctk/core";
import { countTokensMeasured, createMapTokenCacheStore, resolveHomeContext, type HomeContext } from "@ctk/probe";
import { readLocalConfig } from "../local-config.js";
import { readCatalogConfig, readCatalogIndex } from "@ctk/sync";

/**
 * cli/src/commands/verify-ac3.ts — AC-3.1(진입 스킬 상시 비용 상한) · AC-3.2(본문에 자산 목록
 * 하드코딩 금지)의 검증 러너.
 *
 * **두 AC의 판정 가능성이 다르고, 이 명령은 그 차이를 숨기지 않는다.**
 * - AC-3.2의 `concrete_asset_path` 규칙은 본문만으로 판정된다 → 항상 결정적으로 통과/실패한다.
 * - AC-3.2의 `asset_name_literal` 규칙은 **카탈로그가 있어야** 판정된다 → 없으면 `unchecked`다.
 * - AC-3.1은 `count_tokens` 크레덴셜이 있어야 판정된다 → 없으면 `unmeasured`다.
 *
 * 판정할 수 없는 것을 통과로 바꾸지 않는다(안전 원칙 7). 종료 코드는 **실제 위반이 있을 때만**
 * ≠0이며, 미측정·미검사는 종료 코드 0이되 리포트에 상태를 그대로 남긴다 — 이 구분이 없으면
 * "AC-3 통과"가 "AC-3을 검사하지 못했다"와 같은 화면이 된다.
 */

export class SkillSourceNotFoundError extends Error {
  readonly failureClass = "skill_source_not_found" as const;
  constructor(searchedFrom: string) {
    super(
      `toolkit-search 스킬 원본(skills/toolkit-search/SKILL.md)을 찾지 못했다 — ${searchedFrom}에서 상위로 탐색했다. ` +
        `--skill <경로>로 직접 지정할 수 있다.`,
    );
    this.name = "SkillSourceNotFoundError";
  }
}

const SKILL_RELATIVE_PATH = path.join("skills", "toolkit-search", "SKILL.md");

/**
 * 모듈 위치에서 위로 올라가며 저장소의 스킬 원본을 찾는다. `src/`(vitest 별칭)와 `dist/`
 * 양쪽에서 같은 파일에 도달해야 하므로 고정 상대 깊이를 쓰지 않는다 — 깊이를 박으면 한쪽
 * 경로에서만 동작하고 다른 쪽은 조용히 실패한다(빌드된 CLI가 죽어 있던 전례와 같은 형태).
 */
export function findSkillSource(startDir: string): string {
  let current = startDir;
  for (;;) {
    const candidate = path.join(current, SKILL_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) throw new SkillSourceNotFoundError(startDir);
    current = parent;
  }
}

export interface VerifyAc3Options {
  /** 스킬 원본 경로 직접 지정(테스트·비표준 배치용). */
  skillPath?: string | undefined;
  /** 테스트 주입용 — 크레덴셜 체인을 타지 않고 결과를 고정한다. */
  countTokensFn?: ((text: string) => Promise<OccupancyValue>) | undefined;
  home?: HomeContext | undefined;
}

export interface VerifyAc3Report {
  skillPath: string;
  name: string;
  description: string;
  budgetTokens: number;
  /** AC-3.1 — name+description 실측. `measured`일 때만 상한 비교가 성립한다. */
  budgetValue: OccupancyValue;
  /** `budgetValue.state === "measured"`일 때만 채워진다. */
  budgetExceeded: boolean | null;
  /** AC-3.2 판정 결과. */
  lint: SkillBodyLintResult;
  /** 실제 위반이 있어 종료 코드가 ≠0이어야 하는가. 미측정·미검사는 여기 포함되지 않는다. */
  hasViolation: boolean;
}

export async function runVerifyAc3(options: VerifyAc3Options = {}): Promise<VerifyAc3Report> {
  const home = options.home ?? resolveHomeContext();
  const skillPath = options.skillPath ?? findSkillSource(path.dirname(fileURLToPath(import.meta.url)));
  const content = readFileSync(skillPath, "utf8");
  const { frontmatter, body } = splitSkillDocument(content);

  const name = frontmatter["name"] ?? "";
  const description = frontmatter["description"] ?? "";

  // AC-3.2 — 카탈로그가 있으면 자산 이름 목록까지 대조하고, 없으면 그 규칙은 `unchecked`로 남는다.
  const knownAssetNames = readKnownAssetNamesOrUndefined(home);
  const lint = lintSkillBody(body, { knownAssetNames });

  // AC-3.1 — 상시 점유되는 것은 `name`과 `description`뿐이다(본문은 호출될 때만 실린다).
  const budgetText = `${name}\n${description}`;
  const { budgetTokens, tokenizerModel } = readBudgetSettings(home);
  const budgetValue =
    options.countTokensFn !== undefined
      ? await options.countTokensFn(budgetText)
      : await countTokensMeasured({
          text: budgetText,
          tokenizerModel,
          cache: createMapTokenCacheStore(new Map()),
        });

  const budgetExceeded = budgetValue.state === "measured" ? budgetValue.value_tokens > budgetTokens : null;

  return {
    skillPath,
    name,
    description,
    budgetTokens,
    budgetValue,
    budgetExceeded,
    lint,
    hasViolation: lint.violations.length > 0 || budgetExceeded === true,
  };
}

/**
 * 카탈로그가 초기화돼 있으면 인덱스의 자산 이름을 반환한다. 없으면 `undefined` —
 * **빈 배열이 아니다.** 빈 배열을 주면 `lintSkillBody`가 "0개와 대조해 위반 0건"으로 통과시켜
 * 미실행이 통과로 둔갑한다(안전 원칙 7).
 */
function readKnownAssetNamesOrUndefined(home: HomeContext): readonly string[] | undefined {
  const localConfig = readLocalConfig(home);
  if (localConfig === null) return undefined;
  const index = readCatalogIndex(localConfig.catalog_path);
  if (index.assets.length === 0) return undefined;
  return index.assets.map((entry) => entry.name);
}

function readBudgetSettings(home: HomeContext): { budgetTokens: number; tokenizerModel: string } {
  // 카탈로그 없이도 스킬 자체는 검증 가능해야 한다(저장소만 클론한 CI 등) — 스키마 기본값을 쓴다.
  const fallback = { budgetTokens: DEFAULT_SKILL_DESCRIPTION_BUDGET_TOKENS, tokenizerModel: DEFAULT_TOKENIZER_MODEL };
  const localConfig = readLocalConfig(home);
  if (localConfig === null) return fallback;
  const catalogConfig = readCatalogConfig(localConfig.catalog_path);
  if (catalogConfig === null) return fallback;
  return {
    budgetTokens: catalogConfig.skill_description_budget_tokens,
    tokenizerModel: catalogConfig.tokenizer_model,
  };
}

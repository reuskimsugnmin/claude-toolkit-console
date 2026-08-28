import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { bundledParentId, type Asset, type UnresolvedSourceReason } from "@ctk/core";
import {
  createBundledToolLocationCache,
  findBundledToolPath,
  findPluginInstallPath,
  findSkillDirsById,
  skillsRoots,
  type BundledChildKind,
  type BundledToolLocation,
  type BundledToolLocationCache,
  type HomeContext,
} from "@ctk/probe";
import { DEFAULT_MAX_ASSET_SOURCE_BYTES, InstallPathRejectedError, readAssetSourceFileSafely } from "./file-hygiene.js";

/**
 * 스킬 원본 링크의 **봉쇄 루트 목록** — `probe`의 `skillsRoots()`를 그대로 쓴다.
 *
 * ⚠️ **발견 루트와 봉쇄 루트가 같은 출처에서 나와야 한다**(보안 심사 M-2·M-4). 여기서 경로를
 * 다시 조립하면 `probe`가 발견 루트를 늘렸을 때 봉쇄가 조용히 그 축을 놓친다 — 실제로 처음엔
 * user 스코프 하나만 조립해 **프로젝트 스코프 스킬의 링크가 전부 거부**됐다. 이 함수는 조립하지
 * 않고 **받아쓰기만** 한다.
 */
function skillSymlinkContainmentRoots(home: HomeContext): string[] {
  return skillsRoots(home).map((r) => r.path);
}
import { type PromptEnvelopeSection, type SectionLabel } from "./prompt-envelope.js";

/**
 * gen/src/source-resolve.ts — 자산의 서드파티 원문(SKILL.md·README·plugin.json)이 **이 머신
 * 위 어디에 있는지**를 찾고, `file-hygiene.ts`의 안전한 읽기 경로로만 읽는다.
 *
 * ⚠️ 이 결과(절대경로)는 카탈로그에 **저장하지 않는다** — `Asset.source_ref`는 이미 scan
 * 단계(probe/sources/*)에서 홈 상대화·해시화된 값만 담는다(AC-1.7). 여기서 구한 절대경로는
 * **이번 gen 실행 안에서만** 파일을 읽는 데 쓰이고 버려진다.
 *
 * **원문을 못 구한 사유를 한 비트로 뭉개지 않는다(2026-08-24 정정).** 이 파일은 한때
 * `empty: boolean` 하나로 다섯 갈래를 합쳤고, 그 결과 화면이 전부 "원본 없음"이라고 말했다.
 * 실측으로 갈린 결과는 이렇다 — 드리프트 **0건**, 중복 설치 6건, 유형상
 * 원문 부재 6건. 셋의 처방이 전부 다르므로 사유를 타입으로 나눈다(안전 원칙 7).
 */

/**
 * 원문을 구하지 못한 사유 — 정의는 `core`에 있고(`view/asset-doc-state.ts`) 여기서 재수출한다.
 * **각각 사용자가 할 일이 다르다.**
 *
 * - `source_missing` — 있어야 할 원문이 없다. 드리프트일 수 있으니 조사 대상이다.
 * - `no_local_source` — 이 자산 **유형**(mcp·cli)에는 로컬에 읽을 정형 원문 파일이 없다.
 *   실측(2026-08-24): 이 환경의 mcp 4건·cli 2건 **전부** `Asset.description`이 비어 있다 —
 *   유형 전체가 0%이므로 `descriptionOnlySource`가 성공한 경우는 실환경에 존재한 적이 없다.
 *   "사라졌다"가 아니라 "애초에 그런 파일이 없다"이므로 드리프트 조사를 시키면 안 된다.
 * - `ambiguous_source` — 원문이 여러 곳에 있고 **내용이 서로 다르다.** 내용이 **같으면**
 *   여기 오지 않는다: 읽기 축에서는 바이트가 같은 두 사본 사이에 모호성이 없다.
 *   `findSkillDirsById`가 2건 이상을 거부하는 근거(H6)는 "어느 디렉터리를 **이동**시킬지
 *   모른다"는 **쓰기 축**의 판단이고, gen은 읽기다 — 한 축의 안전 규칙이 다른 축에서
 *   과잉 차단이 되고 있었다.
 */
export type { UnresolvedSourceReason };

/** 원문 섹션 목록. `GenPlanTarget`이 그대로 프롬프트 봉투로 넘긴다. */
export type AssetSourceSections = PromptEnvelopeSection[];

export type ResolvedAssetSource =
  | { resolved: true; sections: AssetSourceSections }
  | { resolved: false; reason: "source_missing" | "no_local_source" }
  /** `locationCount`는 이 머신의 파일 배치 사실이므로 **저장하지 않고** 조회 시점에만 쓴다. */
  | { resolved: false; reason: "ambiguous_source"; locationCount: number };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 스킬 원문을 구한다.
 *
 * 다중 디렉터리일 때 **전부 읽어 내용 해시를 비교한다.** 하나라도 위생에 걸리면 예외가 그대로
 * 올라가 그 자산은 `blocked`가 된다 — 안전 축에서는 가장 엄격한 판정을 취한다(링크가 아닌
 * 사본을 골라 우회하지 않는다). `findSkillDirsById`가 돌려주는 디렉터리는 `readSkillDir`이
 * SKILL.md를 이미 읽어본 것들이므로 부재는 경합일 때만 나고, 그때는 위생 계층이
 * `AssetSourceMissingError`로 분류한다.
 */
function skillSource(home: HomeContext, asset: Asset): ResolvedAssetSource {
  const dirs = findSkillDirsById(home, asset.id);
  if (dirs.length === 0) return { resolved: false, reason: "source_missing" };

  const contents: string[] = [];
  for (const dir of dirs) {
    const skillMdAbs = path.join(dir.absPath, "SKILL.md");
    if (!existsSync(skillMdAbs)) continue;
    // 스킬 원본에만 봉쇄 루트를 준다 — 링크로 심는 설치 방식이 흔하고(실측 54건), 대상이
    // 전부 이 루트 안이었다. **플러그인 경로에는 주지 않는다**(필요가 관측되지 않았다).
    contents.push(
      readAssetSourceFileSafely(skillMdAbs, dir.absPath, DEFAULT_MAX_ASSET_SOURCE_BYTES, {
        symlinkContainmentRoots: skillSymlinkContainmentRoots(home),
      }),
    );
  }
  const first = contents[0];
  if (first === undefined) return { resolved: false, reason: "source_missing" };
  if (new Set(contents.map(sha256)).size > 1) {
    return { resolved: false, reason: "ambiguous_source", locationCount: dirs.length };
  }
  return { resolved: true, sections: [{ label: "SKILL.md", content: first }] };
}

/**
 * ⚠️ **설치 경로는 `probe`의 `findPluginInstallPath`가 이미 검증해서 준다**(보안 심사 M-B,
 * 2026-08-28). 예전에는 이 함수가 `installed_plugins.json`의 `installPath` 원문을 그대로 받아
 * `readAssetSourceFileSafely`의 루트로 썼다 — 번들 축은 같은 값에 3중 방어를 거는데 **플러그인
 * 축만 맨몸이었다.** 그 파일이 오염되면 임의 경로의 README가 카탈로그 문서에 실려 `sync`
 * 저장소로 나간다.
 *
 * **거부와 부재를 다르게 처리한다**(안전 원칙 7):
 * - `install_path_missing` → `source_missing`. 드리프트일 수 있으니 조사 대상이다.
 * - `install_path_rejected` → **던진다.** 위생 계층이 `blocked`으로 분류하고 사용자에게
 *   "설정 오염 신호"라고 말한다. 예전처럼 `source_missing`으로 뭉개면 **보안 사건을
 *   드리프트 조사로** 돌려보낸다.
 */
function pluginSource(home: HomeContext, asset: Asset): ResolvedAssetSource {
  const validated = findPluginInstallPath(home, asset.id);
  if (!validated.ok) {
    if (validated.state === "install_path_rejected") {
      throw new InstallPathRejectedError(validated.rejectedPath, validated.reason);
    }
    return { resolved: false, reason: "source_missing" };
  }
  const installPath = validated.absPath;
  const sections: PromptEnvelopeSection[] = [];
  const pluginJsonAbs = path.join(installPath, ".claude-plugin", "plugin.json");
  if (existsSync(pluginJsonAbs)) {
    sections.push({ label: "plugin.json", content: readAssetSourceFileSafely(pluginJsonAbs, installPath) });
  }
  const readmeNames: readonly SectionLabel[] = ["README.md", "readme.md", "Readme.md"];
  for (const readmeName of readmeNames) {
    const readmeAbs = path.join(installPath, readmeName);
    if (existsSync(readmeAbs)) {
      sections.push({ label: readmeName, content: readAssetSourceFileSafely(readmeAbs, installPath) });
      break; // 하나만 있으면 충분하다 — 대소문자 변형은 대개 같은 파일의 중복 존재가 아니다.
    }
  }
  // 설치는 돼 있는데 읽을 원문이 없다 — 있어야 할 것이 없는 상태이므로 조사 대상이다.
  if (sections.length === 0) return { resolved: false, reason: "source_missing" };
  return { resolved: true, sections };
}

/**
 * `kind: "mcp" | "cli"`는 로컬에 읽을 만한 정형 원문 파일이 없다(설정 파일 직독으로만 존재를
 * 확인하는 자산) — `Asset.description`(이미 카탈로그에 있는, scan이 검증한 값)만 원문 섹션으로
 * 쓴다. 그마저 없으면 `no_local_source`다 — **드리프트가 아니다.**
 */
function descriptionOnlySource(asset: Asset): ResolvedAssetSource {
  if (asset.description === undefined || asset.description.length === 0) {
    return { resolved: false, reason: "no_local_source" };
  }
  return { resolved: true, sections: [{ label: "asset.description", content: asset.description }] };
}

/**
 * 번들 자식(`parent_asset_id`가 있는 skill · 항상 번들인 agent·command)의 원문을 읽는다
 * (보안 재심 L-3의 처방). `probe`의 `findBundledToolPath`가 이미 `validateInstallPath`·
 * `isKindDirRejected`·H6(자칭 name은 매칭에만) 방어를 마친 위치를 돌려주므로, 여기서는
 * 그 결과를 `readAssetSourceFileSafely`로 읽기만 한다 — 직접 `readFileSync`하지 않는다.
 *
 * `containmentRoot`(= 그 부모의 검증된 installPath)를 봉쇄 루트로 준다 — **전역
 * `<config>/plugins`가 아니다.** 플러그인 A의 번들 자식이 플러그인 B의 캐시를 읽지 못한다.
 *
 * 보안 심사 L-1 — 2건 이상 매칭되면(H-1과 같은 이름 충돌이 `collectBundled`의 dedup을 거치지
 * 않은 채 이 축에서도 나타날 수 있다) **건수만으로 `ambiguous_source`를 내지 않는다.**
 * `skillSource`(위)와 같은 계약이다: 읽기 축에서는 바이트가 같은 두 사본 사이에 모호성이
 * 없다. 후보 전부를 `readAssetSourceFileSafely`(200KB 상한 포함 — M-2와 같은 상한)로 읽어
 * sha256을 비교하고, **내용이 다를 때만** `ambiguous_source`로 판정한다.
 *
 * `cache`(M-3) — `findBundledToolPath`에 그대로 전달한다. 이 함수 자체는 상태를 갖지 않는다.
 */
function bundledChildSource(
  home: HomeContext,
  asset: Asset,
  kind: BundledChildKind,
  cache: BundledToolLocationCache,
): ResolvedAssetSource {
  const parentId = bundledParentId(asset);
  // kindConstraint(core/schema/asset.ts)가 agent·command는 parent_asset_id 필수, skill은
  // 선택으로 강제한다 — 이 분기는 skill이 이미 parent_asset_id가 있음을 확인한 뒤에만
  // 호출되고 agent·command는 스키마가 항상 보장하므로, null은 방어적 폴백일 뿐이다.
  if (parentId === null) return { resolved: false, reason: "source_missing" };

  const locations: BundledToolLocation[] = findBundledToolPath(home, parentId, kind, asset.name, cache);
  if (locations.length === 0) return { resolved: false, reason: "source_missing" };

  // 보안 심사 H-1 — 라벨은 파일명(`path.basename`)에서 뽑지 않는다. 서드파티가 짓는 파일명은
  // POSIX상 개행을 담을 수 있고, 그 라벨이 `prompt-envelope.ts`의 구획자 줄 안에 그대로
  // 보간되므로 개행 하나로 END 줄이 조기 종료돼 데이터 펜스를 탈출한다. `kind`(ctk가 고정한
  // 축)에서만 고정 리터럴을 뽑는다 — `SectionLabel` 폐집합 중 하나로 컴파일 시점에 강제된다.
  const label: SectionLabel = kind === "skill" ? "SKILL.md" : kind === "agent" ? "agent.md" : "command.md";

  const contents: string[] = [];
  for (const loc of locations) {
    const fileAbs = kind === "skill" ? path.join(loc.absPath, "SKILL.md") : loc.absPath;
    contents.push(
      readAssetSourceFileSafely(fileAbs, loc.containmentRoot, DEFAULT_MAX_ASSET_SOURCE_BYTES, {
        symlinkContainmentRoots: [loc.containmentRoot],
      }),
    );
  }
  const first = contents[0];
  if (first === undefined) return { resolved: false, reason: "source_missing" };
  if (new Set(contents.map(sha256)).size > 1) {
    return { resolved: false, reason: "ambiguous_source", locationCount: locations.length };
  }
  return { resolved: true, sections: [{ label, content: first }] };
}

/**
 * `cache`(M-3) — 번들 자식 판정(`bundledChildSource`)이 쓰는 부모 단위 스캔 캐시. 생략하면
 * 호출마다 새 캐시가 만들어져 이전과 동일하게 동작한다(캐시 없음과 동형, 회귀 없음). 여러
 * 자산에 걸쳐 절약하려면 호출자가 캐시 하나를 만들어 반복 호출에 넘겨야 한다
 * (`plan.ts`의 `planGenTargets`가 이렇게 쓴다) — `classifyAssetDocState`처럼 자산 하나만
 * 조회하는 호출부는 캐시를 넘기지 않아도 손해가 없다(어차피 1회 조회라 절약할 반복이 없다).
 */
export function resolveAssetSource(
  home: HomeContext,
  asset: Asset,
  cache: BundledToolLocationCache = createBundledToolLocationCache(),
): ResolvedAssetSource {
  switch (asset.kind) {
    case "skill":
      // 스킬은 독립·번들 양쪽에 산다(D5) — `parent_asset_id`로 갈린다. 독립 스킬 경로는
      // 바뀌지 않는다(`skillSource`가 그대로 `skillsRoots()`만 본다).
      return asset.parent_asset_id !== undefined
        ? bundledChildSource(home, asset, "skill", cache)
        : skillSource(home, asset);
    case "plugin":
      return pluginSource(home, asset);
    case "mcp":
    case "cli":
      return descriptionOnlySource(asset);
    // B1 Step 5(probe/sources/bundled.ts)가 편입한 번들 자식 — kindConstraint가 parent_asset_id를
    // 항상 강제하므로(번들로만 존재) 언제나 bundledChildSource로 간다. description 한 줄만 보던
    // 예전 취급(재심 S-3 — 크기 상한을 우회했다)은 여기서 끝난다.
    case "agent":
    case "command":
      return bundledChildSource(home, asset, asset.kind, cache);
  }
}

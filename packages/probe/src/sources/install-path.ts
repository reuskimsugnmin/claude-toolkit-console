import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { normalizePath } from "@ctk/core";
import type { HomeContext } from "../home.js";

/**
 * probe/src/sources/install-path.ts — `installed_plugins.json`의 `installPath`를 **순회·읽기
 * 루트로 승격시키기 직전에** 검증하는 단일 관문(B1 보안 심사 M-B, 2026-08-28).
 *
 * ⚠️ **왜 파일로 뽑았나 — 같은 값에 두 축이 서로 다른 방어를 걸고 있었다.** 이 판정은
 * `sources/bundled.ts` 안의 **private 함수**였고, 그래서 번들 축(`collectBundled` ·
 * `findBundledToolPath`)만 3중 방어(절대성·존재·realpath 경계 + kind 디렉터리 경계 +
 * 리프 lstat)를 받았다. 플러그인 축(`findPluginInstallPath` → `gen/source-resolve.ts`의
 * `pluginSource`)은 **같은 파일의 같은 필드**를 아무 검증 없이 `readAssetSourceFileSafely`의
 * 루트로 넘겼다. `installed_plugins.json`이 오염되면 `gen`이 임의 경로의 README를 읽어
 * 카탈로그 문서에 넣고 `sync` 저장소로 내보낸다.
 *
 * **방어를 만든 것과 배선한 것은 다르다**(CLAUDE.md 안전 원칙 5). 검증이 한 파일 안에
 * 갇혀 있으면 다른 축은 그것이 있는 줄도 모른다 — 그래서 판정을 여기 한 곳에 두고 두 축이
 * **같은 함수를 부르게** 한다. 새 축이 생겨도 `installPath`를 쓰려면 이 파일을 지나야 한다.
 *
 * ⚠️ 스키마는 이 값을 지켜주지 않는다 — `core/harness/installed-plugins.schema.ts`가
 * `z.string()` + `.passthrough()`로만 받으므로 절대경로인지도 `..`를 담는지도 보지 않는다.
 */

/** `installPath` 판정 결과의 축. **"없음"과 "거부"를 뭉개지 않는다**(안전 원칙 7) —
 * 없음은 드리프트 조사이고 거부는 보안 사건이라 사용자가 할 일이 다르다. */
export type InstallPathState = "ok" | "install_path_missing" | "install_path_rejected";

export type ValidatedInstallPath =
  | { ok: true; absPath: string }
  | { ok: false; state: "install_path_missing"; reason: string }
  /**
   * ⚠️ `rejectedPath`는 **선택 필드가 아니다** — 거부 축은 언제나 원문 경로를 갖는다(둘 다
   * `installPath`가 있는 분기다). 타입이 그것을 강제하므로 호출자가 "경로를 못 받았을 수도
   * 있다"를 분기할 필요가 없다(안전 원칙 5 — 선택 필드는 누락을 통과시킨다).
   *
   * ⚠️ **`reason`에는 절대 넣지 않는다.** `reason`은 `scan.ts`의 warnings를 타고 브라우저까지
   * 나가지만 `rejectedPath`는 어느 응답 본문에도 실리지 않는다 —
   * `gen/file-hygiene.ts`의 `FileHygieneError.targetPath`와 **같은 계약**이다(메시지에는
   * 넣지 않고 로컬 진단용으로 필드에만 둔다).
   */
  | { ok: false; state: "install_path_rejected"; reason: string; rejectedPath: string };

export function pluginsBoundaryRootAbs(home: HomeContext): string {
  return path.join(home.ctkConfigDir, "plugins");
}

/**
 * 보안 심사 M-2 — 거부 사유 메시지에 원문 절대경로를 넣지 않는다. `installPath`는 `scan.ts`의
 * `warnings`를 거쳐 `web-actions.ts`의 응답 본문에 그대로 실려 브라우저까지 나간다(그
 * 응답 필드 화이트리스트는 `warnings`라는 필드 자체는 통과시키므로, 문자열 안에 박힌 원문
 * 경로는 걸러지지 않는다). `gen/file-hygiene.ts`가 이미 못박은 규칙과 동형이다 —
 * "원문 절대경로는 메시지에 넣지 않는다. 로컬 디버깅용으로 필드에만 둔다." 여기는 사람이 읽는
 * 사유 문자열 하나뿐이라 별도 필드를 둘 자리가 없으므로, `normalizePath`가 이미 `source_ref`에
 * 쓰는 것과 같은 비식별 요약(`home_relative` 우선, 없으면 `path_hash`)으로 대체한다. 상대경로
 * 입력(순회 문자열 등)은 `home_relative`가 나오지 않지만 `path_hash`는 항상 나온다 — 어느
 * 경우든 원문 문자열 자체는 메시지에 남지 않는다.
 */
export function describePathForReason(home: HomeContext, rawPath: string): string {
  const normalized = normalizePath(rawPath, home.ctkHome);
  return normalized.home_relative ?? `path_hash:${normalized.path_hash}`;
}

/**
 * 이미 `realpath`로 해소된 두 경로를 비교하는 순수 함수 — 예외를 던지지 않는다(경로 해소
 * 실패는 호출자가 각자의 축("없음" vs "거부")으로 분류한다). `validateInstallPath`(installPath
 * 경계)와 `isKindDirRejected`(M-1, kind 디렉터리 경계)가 함께 쓰는 단일 관문이다.
 *
 * ⚠️ `gen/src/file-hygiene.ts`의 `assertRealpathWithinRoot`와 판정 형태가 같지만 **직접
 * import할 수 없다** — probe는 core만 import할 수 있고(eslint 계층 경계) `gen → probe` 방향만
 * 허용된다(`probe → gen`은 순환이 된다).
 */
export function isRealPathWithinRealRoot(realTarget: string, realRoot: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/**
 * `installPath`를 순회·읽기 루트로 승격시키기 전에 ⓐ 절대경로인지 ⓑ 디스크에 있는지
 * ⓒ `realpath` 해소 후에도 `<config>/plugins` 아래인지 확인한다.
 *
 * ⚠️ **이후 순회·읽기·`source_ref` 정규화는 realpath가 아니라 원문 `installPath`를 쓴다**
 * (검증에만 realpath를 쓰고, 값은 바꾸지 않는다). macOS는 시스템 임시 디렉터리 자체가
 * 심볼릭 링크라(`/tmp` → `/private/tmp`), realpath 결과를 그대로 쓰면 `home.ctkHome`(realpath를
 * 거치지 않는 원문)과 접두사가 어긋나 `normalizePath`의 홈 상대화가 깨진다(실측, bundled 테스트에서
 * 발견). 보안 검증과 이후 값의 기준을 분리한다 — `gen/file-hygiene.ts`의
 * `readAssetSourceFileSafely`도 같은 원칙(검증은 realpath로, 실제 읽기는 원래 경로로)을 따른다.
 */
export function validateInstallPath(home: HomeContext, installPath: string | undefined): ValidatedInstallPath {
  if (installPath === undefined) {
    return { ok: false, state: "install_path_missing", reason: "installed_plugins.json에 installPath 항목이 없다" };
  }
  if (!path.isAbsolute(installPath)) {
    return {
      ok: false,
      state: "install_path_rejected",
      reason: `installPath가 절대경로가 아니다: ${describePathForReason(home, installPath)}`,
      rejectedPath: installPath,
    };
  }
  if (!existsSync(installPath)) {
    // 오늘 실재율 100%(architect 실측)이므로 부재는 드리프트 신호다 — "없음"이 아니라 "실패".
    return {
      ok: false,
      state: "install_path_missing",
      reason: `installPath가 디스크에 없다: ${describePathForReason(home, installPath)}`,
    };
  }
  const boundaryRootAbs = pluginsBoundaryRootAbs(home);
  let realInstallPath: string;
  let realBoundaryRoot: string;
  try {
    realInstallPath = realpathSync(installPath);
    realBoundaryRoot = realpathSync(boundaryRootAbs);
  } catch {
    return {
      ok: false,
      state: "install_path_missing",
      reason: `installPath realpath 해석 실패: ${describePathForReason(home, installPath)}`,
    };
  }
  if (!isRealPathWithinRealRoot(realInstallPath, realBoundaryRoot)) {
    return {
      ok: false,
      state: "install_path_rejected",
      reason: `installPath가 <config>/plugins 밖을 가리킨다(realpath 기준): ${describePathForReason(home, installPath)}`,
      rejectedPath: installPath,
    };
  }
  return { ok: true, absPath: installPath };
}

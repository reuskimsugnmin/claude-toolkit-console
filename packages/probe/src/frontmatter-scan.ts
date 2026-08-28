import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { parseSimpleFrontmatter } from "./frontmatter.js";

/**
 * probe/src/frontmatter-scan.ts — **스캔 단계에서 원문 파일을 안전하게 여는 단일 관문.**
 *
 * ⚠️ **스캐너는 셋이다**(`sources/skills.ts`의 `readSkillDir` · `sources/bundled.ts`의
 * `scanBundledSkills`·`scanFlatMdKind`). 보안 심사 M-1을 처음 고칠 때 번들 쪽 둘만 세고
 * 독립 스킬 스캐너를 빠뜨렸다 — 3차 심사가 `EXIT=137`(FIFO에 영구 블록)로 실증했고, 독립
 * 스킬은 번들보다 **모집단이 더 크다.** 같은 판정을 세 곳이 각자 구현하면 또 갈리므로 여기
 * 하나로 모은다(CLAUDE.md: "리뷰 지적은 항목이 아니라 범위로 닫는다").
 *
 * 두 축을 함께 막는다:
 * - **M-1(FIFO 무한 대기)** — `statSync().isFile()`로 일반 파일이 아닌 것(FIFO·소켓·디바이스)을
 *   **열기 전에** 배제한다. FIFO를 `readFileSync`하면 영구 블록되고, 그 스캐너를 타는
 *   `ctk gen`과 `ctk web`의 자산 상세 조회까지 함께 멈춘다(동기 읽기 · 단일 이벤트 루프).
 *   **심볼릭 링크는 여기서 판정하지 않는다** — 호출자마다 정책이 반대다(아래 함수 주석).
 * - **M-2(무제한 읽기)** — 상한을 넘는 파일은 앞부분만 잘라 읽는다. 실증: 27바이트 매칭 대상을
 *   찾으면서 형제 60MB가 함께 읽혀 RSS +95MB였다.
 */

/**
 * frontmatter 파싱용 스캔 읽기의 상한. `gen`의 `DEFAULT_MAX_ASSET_SOURCE_BYTES`(200KB, 최종
 * 매칭된 파일 하나를 읽을 때)와는 **다른 축**이다 — 이 상한은 "매칭 전, 후보 전원"에 적용되므로
 * 훨씬 작게 잡는다.
 */
export const FRONTMATTER_SCAN_MAX_BYTES = 64 * 1024;

export type FrontmatterScanRead =
  /** 일반 파일이 아니어서 열지 않았다 — FIFO·소켓·디바이스(링크를 따라간 최종 대상 기준). */
  | { ok: false; reason: "not_a_regular_file" }
  /** 파일이 없거나 읽기에 실패했다. */
  | { ok: false; reason: "read_failed" }
  | { ok: true; content: string; truncated: boolean };

/**
 * 스캔용으로 파일 앞부분을 읽는다. **`readFileSync`를 직접 부르지 말고 이 함수를 쓴다.**
 *
 * ⚠️ `truncated: true`는 **"상한을 넘겨 앞부분만 읽었다"**는 물리적 사실일 뿐이고, 그 자체가
 * "판정을 신뢰할 수 없다"는 뜻은 **아니다**. 판정 신뢰도는 닫는 구획자가 읽은 범위 안에 있느냐로
 * 갈리므로 `scanFrontmatter()`(아래)가 따로 판정한다 — 이 함수를 직접 쓰는 호출자는 그 구분을
 * 스스로 해야 하므로, **frontmatter를 파싱할 목적이면 `scanFrontmatter()`를 쓴다.**
 */
export function readForFrontmatterScan(absPath: string): FrontmatterScanRead {
  let stat;
  try {
    // ⚠️ **`lstat`이 아니라 `stat`이다(링크를 따라간다).** 이 함수는 "일반 파일인가"만 판정하고
    // **심볼릭 링크 정책은 정하지 않는다** — 두 호출자의 정책이 정반대이기 때문이다:
    //   · 독립 스킬(`sources/skills.ts`) — 링크로 심는 설치가 **정당하고 흔하다**(실측 54건).
    //     발견은 링크를 따라가고, 그 링크를 허용할지는 `gen`의 위생 계층이 봉쇄 루트로 판정한다.
    //   · 번들 하위 툴(`sources/bundled.ts`) — 서드파티 트리라 링크를 **거부한다.** 그쪽은
    //     이 함수를 부르기 **전에** 자기 `lstat` 검사로 링크를 걸러낸다.
    // 여기서 `lstat`을 쓰면 독립 스킬의 링크가 발견 단계에서 잘려 `gen`의 판정 자체가 사라진다
    // (실제로 그렇게 만들었다가 `plan.test.ts` 8건이 깨졌다 — 링크 스킬 축 전체가 죽었다).
    // `stat`은 링크를 따라가되 최종 대상이 FIFO·소켓·디바이스면 `isFile()`이 false라 M-1은 막힌다.
    stat = statSync(absPath);
  } catch {
    return { ok: false, reason: "read_failed" };
  }
  if (!stat.isFile()) return { ok: false, reason: "not_a_regular_file" };

  try {
    if (stat.size <= FRONTMATTER_SCAN_MAX_BYTES) {
      return { ok: true, content: readFileSync(absPath, "utf8"), truncated: false };
    }
    const fd = openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(FRONTMATTER_SCAN_MAX_BYTES);
      const bytesRead = readSync(fd, buf, 0, FRONTMATTER_SCAN_MAX_BYTES, 0);
      return { ok: true, content: buf.subarray(0, bytesRead).toString("utf8"), truncated: true };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}


/**
 * frontmatter 판정을 신뢰할 수 없는 사유. 지금은 하나뿐이지만 **`boolean`으로 두지 않는다** —
 * 사유가 늘면 호출자가 갈라야 하고, `boolean`은 그 축을 지운다(CLAUDE.md 안전 원칙 7).
 */
export type FrontmatterUnmeasured = "unterminated_within_scan_limit";

export type FrontmatterScan =
  /** 일반 파일이 아니어서 열지 않았다 — FIFO·소켓·디바이스(링크를 따라간 최종 대상 기준). */
  | { ok: false; reason: "not_a_regular_file" }
  /** 파일이 없거나 읽기에 실패했다. */
  | { ok: false; reason: "read_failed" }
  | {
      ok: true;
      /**
       * ⚠️ **`unmeasured`가 `null`이 아니면 이 값은 항상 빈 객체다**(fail-closed). 판정할 수
       * 없는데 반쪽짜리 값을 돌려주면 호출자가 그것을 자칭 `name`으로 쓴다 — 그게 L-A가
       * 지적한 결함의 실체다. **판정할 수 없으면 값을 주지 않는다**(안전 원칙 7).
       */
      frontmatter: Record<string, string>;
      /** `null`이면 신뢰할 수 있다. 값이 있으면 호출자는 건수를 세어 사용자에게 드러낸다. */
      unmeasured: FrontmatterUnmeasured | null;
    };

/**
 * **frontmatter를 파싱하는 단일 관문**(3차 심사 L-A의 처방, 2026-08-28).
 *
 * ⚠️ **왜 `readForFrontmatterScan` + `parseSimpleFrontmatter`를 각자 부르면 안 되는가.**
 * `parseSimpleFrontmatter`는 닫는 `---`가 없으면 파일 끝까지 소비하며 **last-write-wins**를
 * 적용한다. 그래서 상한(64KB) 밖에 두 번째 `name:`이 있으면 **잘린 쪽과 안 잘린 쪽의 판정이
 * 달라진다** — 이전 주석은 "빈 결과로 자연히 처리한다"고 주장했으나 L-A가 실측으로 반증했다.
 * 두 호출을 각자 하면 그 사실을 호출자마다 다시 기억해야 하고, 실제로 `sources/skills.ts`는
 * `truncated`를 **읽지도 않았다**(독립 스킬은 번들보다 모집단이 더 크다).
 *
 * **판정 기준은 "잘렸는가"가 아니라 "닫는 구획자를 봤는가"다**(ROADMAP의 처방 그대로).
 * - 첫 줄이 `---`가 아니다 → frontmatter가 없다. 잘렸든 아니든 판정은 `{}`로 같다 → 신뢰.
 * - 닫는 `---`를 읽은 범위 안에서 봤다 → 블록 전체를 읽었다 → 신뢰(잘렸어도 무관하다).
 * - 그 밖 → **판정 불가.** 상한 밖에 남은 키가 결과를 뒤집을 수 있다.
 *
 * 이 규칙 덕분에 "잘렸다"의 대부분은 신뢰 축에 남는다 — frontmatter는 파일 맨 앞에 있고
 * 64KB를 넘는 frontmatter는 정상 자산에 없다. **과잉 차단을 만들지 않으면서** 판정이 뒤집힐
 * 수 있는 경우만 골라낸다.
 */
export function scanFrontmatter(absPath: string): FrontmatterScan {
  const read = readForFrontmatterScan(absPath);
  if (!read.ok) return read;
  if (!read.truncated) {
    return { ok: true, frontmatter: parseSimpleFrontmatter(read.content), unmeasured: null };
  }
  if (!hasCompleteFrontmatterBlock(read.content)) {
    // 판정 불가 — 빈 객체를 준다. 호출자는 자칭 값을 쓸 수 없고(fail-closed) `unmeasured`로
    // 그 사실을 셀 수 있다.
    return { ok: true, frontmatter: {}, unmeasured: "unterminated_within_scan_limit" };
  }
  return { ok: true, frontmatter: parseSimpleFrontmatter(read.content), unmeasured: null };
}

/**
 * 읽은 범위 안에서 frontmatter 블록이 **닫혔는지** 본다. `parseSimpleFrontmatter`의 소비 규칙과
 * 같은 판정을 써야 한다 — 여기서 다르게 적으면 두 곳이 갈린다(첫 줄 `---`, 이후 `---`를 만나면 종료).
 */
function hasCompleteFrontmatterBlock(content: string): boolean {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return true; // frontmatter가 애초에 없다 — 판정은 `{}`로 확정이다.
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") return true;
  }
  return false;
}

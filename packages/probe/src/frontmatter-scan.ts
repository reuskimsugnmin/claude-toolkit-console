import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

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
 * ⚠️ `truncated: true`는 **"이 파일의 frontmatter 판정을 신뢰할 수 없다"**는 뜻이다 —
 * `parseSimpleFrontmatter`는 닫는 `---`가 없으면 끝까지 소비하며 last-write-wins를 적용하므로,
 * 상한 밖에 두 번째 `name:`이 있으면 잘린 쪽과 안 잘린 쪽의 판정이 **달라진다**(3차 심사 L-A가
 * 실측으로 반증했다 — 이전 주석은 "빈 결과로 자연히 처리한다"고 **주장**했으나 거짓이었다).
 * 호출자는 이 플래그를 삼키지 말고 건수를 세어 사용자에게 드러낸다.
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

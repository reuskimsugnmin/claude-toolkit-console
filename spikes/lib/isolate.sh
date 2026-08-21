#!/usr/bin/env bash
# spikes/lib/isolate.sh
#
# 격리 규약 (plan §6.0 셸 시맨틱은 그대로 유지). 두 가지 실측 이유로
# plan의 원문 스크립트를 다음 두 지점에서 보강했다 (부록 항목 1·2·4 반영):
#
# 1. (부록 항목 2 — digest 비용) 실측 ~/.claude = 285,948 파일 / 7.3GB.
#    원문처럼 매번 전체 트리를 `shasum -a 256`로 훑으면(before 1회 + after
#    1회, 게다가 filtered 변형까지 별도로 다시 훑으면 4회) 스파이크 1회
#    실행이 수 분씩 걸린다. 그래서 기본 판정 신호는 "경로+크기+mtime"
#    퀵다이제스트 1회 훑기로 낮추고, sha256 전체 다이제스트는 옵션
#    (CTK_FULL_SHA256=1)으로만 돈다. **strict/filtered 두 변형은 같은
#    원시 다이제스트 결과에서 grep으로 파생시키고 파일시스템을 두 번
#    훑지 않는다** — 이것이 "정확도는 유지하며 비용만 낮춘다"는 요구의
#    실제 구현이다: quick digest가 다르면(추가/삭제/mtime 변경) 그 자체가
#    변경 신호이고, 같으면 내용도 동일하다고 간주해도 오탐 위험이
#    실질적으로 없다(같은 프로세스 실행 몇 초 사이 mtime·size가 그대로인데
#    내용만 바뀌는 경우는 없다).
#
# 2. (부록 항목 1 — 오케스트레이터 자체 churn) 이 스크립트를 실행 중인
#    Claude Code 세션 자신이 ~/.claude.json·backups/를 초 단위로 고친다.
#    이는 "격리 실패"가 아니라 관측된 원인이며, AC-2.7 Tier 2 churn
#    허용목록 개념을 격리 판정에도 적용해 제외한다(ctk_assert_isolated_filtered).
#    엄격판(ctk_assert_isolated)은 원인 기록용으로 별도 유지한다.
#
# 3. (부록 항목 4 — return이 함수 밖에서 무력) 모든 실패는 `return 1`로
#    명시적으로 올린다. 파이프라인 안에서 실패를 리턴하지 않는다.

set -uo pipefail

# ---- quick digest: path + size + mtime (no content read) --------------
ctk_real_home_quickdigest() {
  local out="${1:?digest 출력 경로 필수}" tmp
  tmp="$(mktemp)" || return 1
  : > "$tmp"
  if [ -d "$CTK_REAL_HOME/.claude" ]; then
    ( cd "$CTK_REAL_HOME/.claude" \
      && find . -type f -exec stat -f '%N %z %m' {} + ) >> "$tmp" || return 1
  fi
  if [ -f "$CTK_REAL_HOME/.claude.json" ]; then
    stat -f '.claude.json %z %m' "$CTK_REAL_HOME/.claude.json" >> "$tmp" || return 1
  fi
  if [ -d "$CTK_REAL_HOME/.config/claude" ]; then
    ( cd "$CTK_REAL_HOME/.config/claude" \
      && find . -type f -exec stat -f '%N %z %m' {} + ) >> "$tmp" || return 1
  fi
  sort "$tmp" > "$out" || return 1
  rm -f "$tmp"
}

# Tier-2 churn allowlist (AC-0.8 실측 전 임시값 — 부록 항목 2, plan §2.7-b 예시
# 값을 초기값으로 사용. AC-0.8 실측 결과가 이 목록을 대체할 권위임).
CTK_CHURN_ALLOWLIST_REGEX='(^|/)\.claude\.json |(^|/)backups/|(^|/)history\.jsonl |(^|/)statsig/|(^|/)projects/|(^|/)shell-snapshots/|(^|/)todos/|(^|/)stats-cache\.json |(^|/)mcp-needs-auth-cache\.json |(^|/)paste-cache/|(^|/)sessions/|(^|/)plugins/repos/'

ctk_quickdigest_filtered_from() {
  # $1 = raw quickdigest file, $2 = output filtered file (파일시스템 재훑기 없음)
  grep -v -E "$CTK_CHURN_ALLOWLIST_REGEX" "$1" > "$2" || true
}

# ---- strict sha256 digest (plan §6.0 원문 — 옵션, CTK_FULL_SHA256=1일 때만) --
ctk_real_home_digest() {
  local out="${1:?digest 출력 경로 필수}" tmp
  tmp="$(mktemp)" || return 1
  : > "$tmp"
  if [ -d "$CTK_REAL_HOME/.claude" ]; then
    ( cd "$CTK_REAL_HOME/.claude" && find . -type f -exec shasum -a 256 {} + ) >> "$tmp" || return 1
  fi
  if [ -f "$CTK_REAL_HOME/.claude.json" ]; then
    shasum -a 256 "$CTK_REAL_HOME/.claude.json" >> "$tmp" || return 1
  fi
  if [ -d "$CTK_REAL_HOME/.config/claude" ]; then
    ( cd "$CTK_REAL_HOME/.config/claude" && find . -type f -exec shasum -a 256 {} + ) >> "$tmp" || return 1
  fi
  sort "$tmp" > "$out" || return 1
  rm -f "$tmp"
}

ctk_isolate() {                       # 모든 파괴적 검증의 첫 줄
  # 이 셸 프로세스 자체의 $HOME은 절대 바꾸지 않는다 — 바꾸면
  # ctk_real_home_quickdigest/digest가 "실제 홈" 대신 격리 트리를 재는
  # 자기참조가 된다. 격리는 자식 `claude` 프로세스에만 HOME=$CTK_HOME/
  # CLAUDE_CONFIG_DIR=... 환경변수 주입으로 건다 (spikes/lib/spawn-claude.sh).
  CTK_REAL_HOME="${CTK_REAL_HOME:-$HOME}"
  export CTK_REAL_HOME
  CTK_HOME="$(mktemp -d)" || { echo "FAIL isolation_violation: mktemp"; return 1; }
  export CTK_HOME
  export CLAUDE_CONFIG_DIR="$CTK_HOME/.claude"
  export CTK_CONFIG_DIR="$CLAUDE_CONFIG_DIR"
  mkdir -p "$CTK_CONFIG_DIR" || { echo "FAIL isolation_violation: mkdir"; return 1; }
  # 픽스처 경로는 cwd에 의존하지 않는 절대경로로 (Minor 11)
  cp -R "${CTK_REPO_ROOT:?CTK_REPO_ROOT 필수}/fixtures/home/.claude/." "$CTK_CONFIG_DIR/" \
    || { echo "FAIL isolation_violation: fixture copy"; return 1; }

  ctk_real_home_quickdigest "$CTK_HOME/.real-home-before.quick" \
    || { echo "FAIL isolation_violation: quick digest"; return 1; }
  [ -s "$CTK_HOME/.real-home-before.quick" ] \
    || { echo "FAIL isolation_violation: empty baseline (감시 대상 3곳이 모두 비었거나 읽기 실패)"; return 1; }
  ctk_quickdigest_filtered_from "$CTK_HOME/.real-home-before.quick" "$CTK_HOME/.real-home-before.quick.filtered"

  if [ "${CTK_FULL_SHA256:-0}" = "1" ]; then
    ctk_real_home_digest "$CTK_HOME/.real-home-before.sha256" \
      || { echo "FAIL isolation_violation: sha256 digest"; return 1; }
  fi
}

ctk_assert_isolated() {               # 엄격판 (quick digest 기준 — 기본)
  ctk_real_home_quickdigest "$CTK_HOME/.real-home-after.quick" \
    || { echo "FAIL isolation_violation: quick digest"; return 1; }
  [ -s "$CTK_HOME/.real-home-after.quick" ] \
    || { echo "FAIL isolation_violation: empty after-digest"; return 1; }
  diff "$CTK_HOME/.real-home-before.quick" "$CTK_HOME/.real-home-after.quick" \
    || { echo "FAIL isolation_violation"; return 1; }
}

ctk_assert_isolated_filtered() {      # Tier-2 churn 제외판 — 부록 항목 1·2 적용
  ctk_real_home_quickdigest "$CTK_HOME/.real-home-after.quick" \
    || { echo "FAIL isolation_violation: quick digest"; return 1; }
  ctk_quickdigest_filtered_from "$CTK_HOME/.real-home-after.quick" "$CTK_HOME/.real-home-after.quick.filtered"
  diff "$CTK_HOME/.real-home-before.quick.filtered" "$CTK_HOME/.real-home-after.quick.filtered" \
    || { echo "FAIL isolation_violation (filtered)"; return 1; }
}

ctk_teardown() {
  [ -n "${CTK_HOME:-}" ] && [ -d "$CTK_HOME" ] && rm -rf "$CTK_HOME"
  unset CTK_HOME CTK_CONFIG_DIR CLAUDE_CONFIG_DIR
}

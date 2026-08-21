#!/usr/bin/env bash
# spikes/02-project-plugins.sh — AC-0.2 [차단]
#
# Question: is a plugin installed at USER scope actually disabled when the
# PROJECT's .claude/settings.json sets `enabledPlugins: {"<id>": false}`?
#
# Signal (discovered empirically, see spikes/results/AC-0.2.md "방법론"):
# invoking a plugin slash command as `/<plugin-name>:<command-name>` routes
# and validates the command BEFORE any network/auth call. Two possible
# early responses distinguish "recognized" from "not recognized" without
# ever reaching the model (so this spike costs ~$0, no --max-budget-usd
# spend actually occurs in the isolated/auth-broken environment this repo
# was authored in — see AC-0.10 for why isolated auth is broken here):
#   - "Unknown command: /synth:synth-probe"    -> NOT recognized (disabled)
#   - "Not logged in · Please run /login"      -> recognized, blocked only
#                                                  by auth (i.e. WOULD run)
#   - (an actual model response)               -> recognized AND ran (e.g.
#                                                  in an environment where
#                                                  isolated auth does work)
#
# Control group (Missing item ⓓ in the plan): confirm the synthetic plugin
# is recognized when enabledPlugins is left at its installed default
# (true) BEFORE testing whether a project-level `false` flips it — a
# fixture that never gets recognized at all would make "미존중" and
# "invalid_fixture" indistinguishable.
# NOTE: this script OVERWRITES results/AC-0.*.md on every run (`>` not `>>`).
# The results/ file for this AC also carries hand-written analysis appended
# after the first run (root-cause writeups, verdict tables) — rerunning this
# script wipes that back to just the auto-generated numbers. Re-append the
# analysis from this file's git history / the Step 0 report if you rerun it.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CTK_REPO_ROOT="${CTK_REPO_ROOT:-$HERE}"
source "$HERE/lib/isolate.sh"
source "$HERE/lib/spawn-claude.sh"
source "$HERE/lib/patch-fixture.sh"

mkdir -p "$HERE/results"
RESULT_FILE="$HERE/results/AC-0.2.md"

# Classify one `/synth:synth-probe` invocation's raw output into a signal.
classify() {
  local text="$1"
  if echo "$text" | grep -q "Unknown command"; then
    echo "not_recognized"
  elif echo "$text" | grep -q "Not logged in"; then
    echo "recognized_blocked_by_auth"
  elif echo "$text" | grep -q "SYNTH_PROBE_OK"; then
    echo "recognized_and_ran"
  else
    echo "unclassified"
  fi
}

# One probe run: fresh isolated home, install the synth plugin at user
# scope (real CLI, no auth needed — AC-0.8/this-file's own control confirm
# that), optionally drop a project .claude/settings.json override, invoke
# the command from that project cwd, classify the response.
run_probe() {
  local label="$1" project_override="$2"   # project_override = path or ""
  ctk_isolate || { echo "FAIL ctk_isolate ($label)" >&2; return 1; }
  ctk_install_synth_plugin || { echo "FAIL install ($label)" >&2; ctk_teardown; return 1; }

  local projdir
  projdir="$(mktemp -d)"
  if [ -n "$project_override" ]; then
    mkdir -p "$projdir/.claude"
    cp "$project_override" "$projdir/.claude/settings.json"
  fi

  local out
  out="$(echo "/synth:synth-probe" | ctk_spawn_claude_in_cwd "$projdir" -p --max-budget-usd 0.02 --output-format text 2>&1)"
  local signal
  signal="$(classify "$out")"
  echo "[$label] signal=$signal raw=$(echo "$out" | head -1)" >&2
  echo "$signal"

  rm -rf "$projdir"
  ctk_teardown
}

{
  echo "# AC-0.2 결과 (자동 생성 — $(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo
  echo "## 방법론 (실측으로 확정 — 최초 설계에서 변경됨)"
  echo
  echo "\`/synth-probe\`(bare)는 항상 \`Unknown command\`였다 — 플러그인 커맨드는"
  echo "\`/<plugin-name>:<command-name>\` 형식(예: \`/synth:synth-probe\`)으로만 라우팅된다는"
  echo "것을 실측으로 발견했다. 이 형식은 **인증 이전에 라우팅이 결정된다** — 격리 홈에서"
  echo "OAuth가 깨져 있어도(AC-0.10ⓒ 참조) \`Unknown command\`(미인식) vs \`Not logged in\`"
  echo "(인식됨, 인증 단계에서만 막힘)을 구분할 수 있다. 이 신호로 **모델 호출 없이 0원**으로"
  echo "AC-0.2를 판정한다."
  echo
} > "$RESULT_FILE"

echo "== 대조군ⓓ: enabledPlugins 미설정(설치 기본값=true) 상태에서 인식되는가 =="
CONTROL_SIGNAL="$(run_probe "control (no project override)" "")"

echo "== 본측정 3회: 프로젝트 settings.json에 enabledPlugins:{synth@synth-mp:false} =="
M1="$(run_probe "measurement 1" "$HERE/fixtures/project/.claude/settings.json")"
M2="$(run_probe "measurement 2" "$HERE/fixtures/project/.claude/settings.json")"
M3="$(run_probe "measurement 3" "$HERE/fixtures/project/.claude/settings.json")"

{
  echo "## 결과"
  echo
  echo "- 대조군ⓓ (설치 기본값 true, 프로젝트 오버라이드 없음): **$CONTROL_SIGNAL**"
  echo "- 본측정 1 (프로젝트 enabledPlugins: false): **$M1**"
  echo "- 본측정 2: **$M2**"
  echo "- 본측정 3: **$M3**"
  echo
  if [ "$CONTROL_SIGNAL" != "recognized_blocked_by_auth" ] && [ "$CONTROL_SIGNAL" != "recognized_and_ran" ]; then
    echo "## 판정: invalid_fixture"
    echo
    echo "대조군이 '인식됨' 신호를 내지 못했다 — 합성 플러그인이 애초에 인식되지 않는다."
    echo "존중/미존중 어느 쪽으로도 쓸 수 없다. 픽스처를 고쳐야 한다."
  else
    ALL_FLIPPED="yes"
    for s in "$M1" "$M2" "$M3"; do
      [ "$s" = "not_recognized" ] || ALL_FLIPPED="no"
    done
    if [ "$ALL_FLIPPED" = "yes" ]; then
      echo "## 판정: **존중 (respected)** — 3회 전원 일치"
      echo
      echo "대조군에서는 인식되고(auth 단계까지 도달), 프로젝트 \`enabledPlugins:false\`가 걸리자"
      echo "3회 모두 \`Unknown command\`로 뒤집혔다. **프로젝트 \`enabledPlugins\`가 user-scope"
      echo "설치를 실제로 존중한다.**"
    else
      echo "## 판정: 미존중 (not respected) 또는 판정불가 — 3회 전원 일치하지 않음"
      echo
      echo "측정값이 일치하지 않거나 뒤집히지 않았다 — 원문 로그를 참조해 원인을 확인해야 한다."
    fi
  fi
} >> "$RESULT_FILE"

cat "$RESULT_FILE"

#!/usr/bin/env bash
# spikes/01-isolation.sh — AC-0.1 [차단]
#
# Question: does injecting HOME=$CTK_HOME + CLAUDE_CONFIG_DIR=$CTK_CONFIG_DIR
# into a `claude` subprocess's env keep it from touching the REAL ~/.claude,
# ~/.claude.json, ~/.config/claude?
#
# 부록 항목 1·8: in THIS environment, the orchestrating Claude Code session
# (i.e. whatever is running this very script) itself mutates ~/.claude.json
# and backups/ every few seconds. That churn is NOT evidence the spike
# subprocess broke isolation. This script runs BOTH the strict diff (which
# is expected to show churn, and we record why) and the Tier-2-filtered
# diff (which is the actual AC-0.1 judgement once known harness/session
# churn is excluded).
#
# Run: CTK_REPO_ROOT=/abs/path/to/spikes bash spikes/01-isolation.sh
# NOTE: this script OVERWRITES results/AC-0.*.md on every run (`>` not `>>`).
# The results/ file for this AC also carries hand-written analysis appended
# after the first run (root-cause writeups, verdict tables) — rerunning this
# script wipes that back to just the auto-generated numbers. Re-append the
# analysis from this file's git history / the Step 0 report if you rerun it.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CTK_REPO_ROOT="${CTK_REPO_ROOT:-$HERE}"
# shellcheck source=lib/isolate.sh
source "$HERE/lib/isolate.sh"
# shellcheck source=lib/spawn-claude.sh
source "$HERE/lib/spawn-claude.sh"
# shellcheck source=lib/patch-fixture.sh
source "$HERE/lib/patch-fixture.sh"

RESULT_FILE="$HERE/results/AC-0.1.md"
mkdir -p "$HERE/results"

echo "== AC-0.1: isolation spike =="

ctk_isolate || { echo "FAIL: ctk_isolate itself failed"; exit 1; }
ctk_install_synth_plugin || { echo "FAIL: ctk_install_synth_plugin failed"; exit 1; }
echo "CTK_HOME=$CTK_HOME"
echo "CTK_CONFIG_DIR=$CTK_CONFIG_DIR"
echo "CTK_REAL_HOME=$CTK_REAL_HOME"

# Sanity: fixture is present in the isolated tree.
if [ ! -f "$CTK_CONFIG_DIR/settings.json" ]; then
  echo "FAIL: fixture copy did not land in isolated config dir"; exit 1
fi

echo "-- running isolated claude subprocess (--version, then plugin list --json) --"
ctk_spawn_claude --version > "$CTK_HOME/.child-version.txt" 2>&1
V_RC=$?
cat "$CTK_HOME/.child-version.txt"

ctk_spawn_claude plugin list --json > "$CTK_HOME/.child-plugin-list.json" 2> "$CTK_HOME/.child-plugin-list.stderr.txt"
PL_RC=$?
echo "plugin list rc=$PL_RC"

echo "-- checking child process actually saw the isolated home, not the real one --"
# The child's plugin list should include our synthetic synth@synth-mp plugin
# (proves it read the ISOLATED installed_plugins.json) and must NOT include
# any of the real marketplaces present in the orchestrator's actual ~/.claude
# (proves it did not fall back to the real one).
CHILD_SAW_SYNTH=no
if grep -q 'synth@synth-mp' "$CTK_HOME/.child-plugin-list.json" 2>/dev/null; then
  CHILD_SAW_SYNTH=yes
fi
CHILD_SAW_REAL=no
if grep -q 'claude-plugins-official' "$CTK_HOME/.child-plugin-list.json" 2>/dev/null; then
  CHILD_SAW_REAL=yes
fi
echo "child saw synthetic plugin: $CHILD_SAW_SYNTH"
echo "child saw real marketplace (should be no): $CHILD_SAW_REAL"

echo "-- strict diff (expected to show orchestrator's own churn) --"
STRICT_RESULT="unmeasured"
if ctk_assert_isolated; then
  STRICT_RESULT="PASS (0 diff lines)"
else
  STRICT_LINES="$(diff "$CTK_HOME/.real-home-before.quick" "$CTK_HOME/.real-home-after.quick" | wc -l | tr -d ' ')"
  STRICT_RESULT="FAIL ($STRICT_LINES diff lines — see below for churn analysis)"
  echo "-- diff sample (first 20 lines) --"
  diff "$CTK_HOME/.real-home-before.quick" "$CTK_HOME/.real-home-after.quick" | head -20
fi
echo "strict result: $STRICT_RESULT"

echo "-- filtered diff (Tier-2 churn allowlist excluded — 부록 항목 2) --"
FILTERED_RESULT="unmeasured"
if ctk_assert_isolated_filtered; then
  FILTERED_RESULT="PASS (0 diff lines outside churn allowlist)"
else
  FILTERED_LINES="$(diff "$CTK_HOME/.real-home-before.quick.filtered" "$CTK_HOME/.real-home-after.quick.filtered" | wc -l | tr -d ' ')"
  FILTERED_RESULT="FAIL ($FILTERED_LINES diff lines even after excluding known churn)"
  echo "-- filtered diff (should be empty) --"
  diff "$CTK_HOME/.real-home-before.quick.filtered" "$CTK_HOME/.real-home-after.quick.filtered" | head -40
fi
echo "filtered result: $FILTERED_RESULT"

BEFORE_COUNT="$(wc -l < "$CTK_HOME/.real-home-before.quick" | tr -d ' ')"
AFTER_COUNT="$(wc -l < "$CTK_HOME/.real-home-after.quick" | tr -d ' ')"

{
  echo "# AC-0.1 결과 (자동 생성 — $(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo
  echo "- claude --version (child, isolated): $(cat "$CTK_HOME/.child-version.txt")"
  echo "- child process exit rc: version=$V_RC, plugin-list=$PL_RC"
  echo "- child saw synthetic plugin (synth@synth-mp): $CHILD_SAW_SYNTH"
  echo "- child saw real marketplace (claude-plugins-official) — should be 'no': $CHILD_SAW_REAL"
  echo "- real-home strict digest: before=$BEFORE_COUNT lines, after=$AFTER_COUNT lines"
  echo "- strict diff (no exclusions): $STRICT_RESULT"
  echo "- filtered diff (Tier-2 churn excluded): $FILTERED_RESULT"
  echo
  echo "## 판정"
  if [ "$CHILD_SAW_SYNTH" = "yes" ] && [ "$CHILD_SAW_REAL" = "no" ] && [[ "$FILTERED_RESULT" == PASS* ]]; then
    echo "PASS — 격리 성립. 자식 프로세스는 격리 트리만 봤고(합성 플러그인 인식, 실제 마켓플레이스 미인식),"
    echo "실제 홈은 Tier-2 churn 허용목록 제외 시 변경 0건이었다."
  else
    echo "판정불가/FAIL — 아래 세부 사유 참조."
  fi
} > "$RESULT_FILE"

echo
echo "== 결과 파일: $RESULT_FILE =="
cat "$RESULT_FILE"

ctk_teardown

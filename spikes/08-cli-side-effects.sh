#!/usr/bin/env bash
# spikes/08-cli-side-effects.sh — AC-0.8 [차단]
#
# Question: for `claude plugin list --json` / `plugin details <id>` /
# `plugin enable <id>` / `plugin disable <id>`, what config-dir paths change
# (file added/removed/content changed), and specifically: does
# enable/disable touch installed_plugins.json (it must NOT — that's the
# premise decision 6C and AC-2.1c/AC-2.7-c rely on)?
#
# Runs entirely inside an isolated CTK_HOME (never touches the real home).
# Each command gets its own fresh isolated tree so effects don't compound.
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
RESULT_FILE="$HERE/results/AC-0.8.md"

# Full sha256 snapshot of just the isolated config dir (small tree — fine to
# hash fully, this is NOT the 7.3GB real home).
config_snapshot() {
  local out="$1"
  ( cd "$CTK_CONFIG_DIR" && find . -type f -exec shasum -a 256 {} + ) | sort > "$out"
}

run_one_command() {
  local label="$1"; shift
  ctk_isolate || { echo "FAIL ctk_isolate for $label"; return 1; }
  ctk_patch_fixture_placeholders
  local ipj="$CTK_CONFIG_DIR/plugins/installed_plugins.json"
  local ipj_before
  ipj_before="$(shasum -a 256 "$ipj" | awk '{print $1}')"
  config_snapshot "$CTK_HOME/.before.snap"

  ctk_spawn_claude "$@" > "$CTK_HOME/.cmd.stdout" 2> "$CTK_HOME/.cmd.stderr"
  local rc=$?

  config_snapshot "$CTK_HOME/.after.snap"
  local ipj_after
  ipj_after="$(shasum -a 256 "$ipj" | awk '{print $1}')"

  local changed_paths
  changed_paths="$( (diff "$CTK_HOME/.before.snap" "$CTK_HOME/.after.snap" || true) | (grep -E '^[<>]' || true) | awk '{print $3}' | sort -u)"
  local ipj_unchanged="yes"
  [ "$ipj_before" = "$ipj_after" ] || ipj_unchanged="no"

  {
    echo "### \`$label\` (exit rc=$rc)"
    echo
    echo "- command: \`claude $*\`"
    echo "- installed_plugins.json sha256 unchanged: **$ipj_unchanged** (before=$ipj_before, after=$ipj_after)"
    echo "- changed paths (added/removed/modified, relative to \$CLAUDE_CONFIG_DIR):"
    if [ -z "$changed_paths" ]; then
      echo "  - (none)"
    else
      echo "$changed_paths" | sed 's/^/  - /'
    fi
    echo "- stdout (first 15 lines):"
    echo '```'
    head -15 "$CTK_HOME/.cmd.stdout"
    echo '```'
    if [ -s "$CTK_HOME/.cmd.stderr" ]; then
      echo "- stderr (first 15 lines):"
      echo '```'
      head -15 "$CTK_HOME/.cmd.stderr"
      echo '```'
    fi
    echo
  } >> "$RESULT_FILE"

  ctk_teardown
}

{
  echo "# AC-0.8 결과 (자동 생성 — $(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo
  echo "각 명령을 **독립된 격리 홈**(합성 마켓플레이스+플러그인 픽스처 포함)에서 1회씩 실행하고,"
  echo "실행 전후 \$CLAUDE_CONFIG_DIR 트리 전체(작아서 sha256 전량 — 실제 홈이 아님)를 대조했다."
  echo
} > "$RESULT_FILE"

run_one_command "plugin list --json" plugin list --json
run_one_command "plugin details synth@synth-mp" plugin details synth@synth-mp
run_one_command "plugin enable synth@synth-mp" plugin enable synth@synth-mp -s user
run_one_command "plugin disable synth@synth-mp" plugin disable synth@synth-mp -s user

# Supplementary: `enable` on a plugin that starts DISABLED (the fixture's
# default is enabled=true, so the standalone `enable` run above hit the
# "already enabled" no-op path — this run flips it off first in the SAME
# isolated home so `enable` does a real disabled->enabled transition).
run_enable_from_disabled() {
  ctk_isolate || { echo "FAIL ctk_isolate for enable-from-disabled setup"; return 1; }
  ctk_patch_fixture_placeholders
  ctk_spawn_claude plugin disable synth@synth-mp -s user > /dev/null 2>&1
  local ipj="$CTK_CONFIG_DIR/plugins/installed_plugins.json"
  local ipj_before
  ipj_before="$(shasum -a 256 "$ipj" | awk '{print $1}')"
  config_snapshot "$CTK_HOME/.before.snap"
  ctk_spawn_claude plugin enable synth@synth-mp -s user > "$CTK_HOME/.cmd.stdout" 2> "$CTK_HOME/.cmd.stderr"
  local rc=$?
  config_snapshot "$CTK_HOME/.after.snap"
  local ipj_after
  ipj_after="$(shasum -a 256 "$ipj" | awk '{print $1}')"
  local ipj_unchanged="yes"
  [ "$ipj_before" = "$ipj_after" ] || ipj_unchanged="no"
  local changed_paths
  changed_paths="$( (diff "$CTK_HOME/.before.snap" "$CTK_HOME/.after.snap" || true) | (grep -E '^[<>]' || true) | awk '{print $3}' | sort -u)"
  {
    echo "### \`plugin enable synth@synth-mp\` (supplementary — starting from disabled, exit rc=$rc)"
    echo
    echo "- installed_plugins.json sha256 unchanged: **$ipj_unchanged**"
    echo "- changed paths:"
    if [ -z "$changed_paths" ]; then echo "  - (none)"; else echo "$changed_paths" | sed 's/^/  - /'; fi
    echo "- stdout:"
    echo '```'
    cat "$CTK_HOME/.cmd.stdout"
    echo '```'
    echo
  } >> "$RESULT_FILE"
  ctk_teardown
}
run_enable_from_disabled

cat "$RESULT_FILE"

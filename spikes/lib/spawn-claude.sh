#!/usr/bin/env bash
# spikes/lib/spawn-claude.sh
#
# Spike stand-in for the production packages/probe/src/harness/spawn-claude.ts
# wrapper (plan §1.3 결정 6). All `claude` subprocess launches in the spikes
# go through this function so isolation env vars are injected consistently
# and never accidentally leak the real $HOME to the child.
#
# Requires: ctk_isolate to have been called first (CTK_HOME/CTK_CONFIG_DIR set).
#
# Usage: ctk_spawn_claude [extra claude args...]
#   Prompt goes via stdin if CTK_SPAWN_STDIN_PROMPT is set, else args are
#   passed through verbatim (caller's responsibility to keep it minimal).

set -uo pipefail

ctk_spawn_claude() {
  : "${CTK_HOME:?ctk_isolate 먼저 호출 필요}"
  : "${CTK_CONFIG_DIR:?ctk_isolate 먼저 호출 필요}"
  local tmp_cwd
  tmp_cwd="$(mktemp -d)" || return 1
  (
    cd "$tmp_cwd" || exit 1
    env -i \
      HOME="$CTK_HOME" \
      CLAUDE_CONFIG_DIR="$CTK_CONFIG_DIR" \
      PATH="$PATH" \
      TERM="${TERM:-xterm}" \
      USER="${USER:-}" \
      LOGNAME="${LOGNAME:-}" \
      SHELL="${SHELL:-/bin/bash}" \
      TMPDIR="${TMPDIR:-/tmp}" \
      claude "$@"
  )
  local rc=$?
  rm -rf "$tmp_cwd"
  return $rc
}

# Like ctk_spawn_claude, but (a) uses a caller-provided cwd instead of a
# throwaway empty dir (needed for AC-0.2's project-level .claude/settings.json
# to be discovered), and (b) sends the prompt via stdin rather than argv
# (plan §1.3 결정6 wrapper spec: "프롬프트는 argv가 아니라 stdin 전달").
# Usage: echo "$PROMPT" | ctk_spawn_claude_in_cwd "$PROJECT_DIR" -p --max-budget-usd 0.05 ...
ctk_spawn_claude_in_cwd() {
  : "${CTK_HOME:?ctk_isolate 먼저 호출 필요}"
  : "${CTK_CONFIG_DIR:?ctk_isolate 먼저 호출 필요}"
  local cwd="${1:?cwd 필수}"; shift
  (
    cd "$cwd" || exit 1
    env -i \
      HOME="$CTK_HOME" \
      CLAUDE_CONFIG_DIR="$CTK_CONFIG_DIR" \
      PATH="$PATH" \
      TERM="${TERM:-xterm}" \
      USER="${USER:-}" \
      LOGNAME="${LOGNAME:-}" \
      SHELL="${SHELL:-/bin/bash}" \
      TMPDIR="${TMPDIR:-/tmp}" \
      claude "$@"
  )
  return $?
}

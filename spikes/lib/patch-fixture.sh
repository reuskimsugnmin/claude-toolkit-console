#!/usr/bin/env bash
# spikes/lib/patch-fixture.sh
#
# History: an earlier version of this file hand-crafted
# plugins/known_marketplaces.json + plugins/installed_plugins.json (and
# settings.json's extraKnownMarketplaces) directly. That was WRONG — real
# `claude` sessions still reported "Unknown command: /synth-probe" against
# the hand-crafted state, meaning some registration detail was hand-crafted
# incorrectly (never fully root-caused, and not worth reverse-engineering
# further). The reliable approach is to let the REAL CLI do the registration
# via `claude plugin marketplace add` + `claude plugin install`, which are
# local/filesystem operations that do NOT require network auth (verified —
# see spikes/results/AC-0.2.md for the confirming observation), so they work
# fine even in isolation.
#
# spikes/fixtures/marketplace-source/synth-mp/ is the plain (unregistered)
# marketplace source repo. This installs it into the just-isolated
# CLAUDE_CONFIG_DIR at user scope.
set -uo pipefail

ctk_install_synth_plugin() {
  : "${CTK_HOME:?ctk_isolate 먼저 호출 필요}"
  : "${CTK_CONFIG_DIR:?ctk_isolate 먼저 호출 필요}"
  local src="${CTK_REPO_ROOT:?}/fixtures/marketplace-source/synth-mp"
  local tmp_cwd
  tmp_cwd="$(mktemp -d)" || return 1
  (
    cd "$tmp_cwd" || exit 1
    env -i HOME="$CTK_HOME" CLAUDE_CONFIG_DIR="$CTK_CONFIG_DIR" PATH="$PATH" \
      TERM="${TERM:-xterm}" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
      SHELL="${SHELL:-/bin/bash}" TMPDIR="${TMPDIR:-/tmp}" \
      claude plugin marketplace add "$src"
  ) > "$CTK_HOME/.install-marketplace.log" 2>&1 || { cat "$CTK_HOME/.install-marketplace.log"; return 1; }
  (
    cd "$tmp_cwd" || exit 1
    env -i HOME="$CTK_HOME" CLAUDE_CONFIG_DIR="$CTK_CONFIG_DIR" PATH="$PATH" \
      TERM="${TERM:-xterm}" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
      SHELL="${SHELL:-/bin/bash}" TMPDIR="${TMPDIR:-/tmp}" \
      claude plugin install synth@synth-mp -s user -y
  ) > "$CTK_HOME/.install-plugin.log" 2>&1 || { cat "$CTK_HOME/.install-plugin.log"; return 1; }
  rm -rf "$tmp_cwd"
}

# Backward-compat no-op alias — nothing left to placeholder-patch now that
# registration goes through the real CLI, but earlier spike scripts call
# this name; keep it so they don't need editing.
ctk_patch_fixture_placeholders() {
  ctk_install_synth_plugin
}

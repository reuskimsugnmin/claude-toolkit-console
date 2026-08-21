#!/usr/bin/env bash
# ctk spike AC-0.10ⓓ detection hook. If this fires, the isolated-tree
# SessionStart hook was actually loaded and executed. Writes a marker file
# under $HOME (the isolated CTK_HOME at runtime) so the spike script can
# check for it after the session exits without parsing hook stdout.
echo "CTK_SPIKE_HOOK_FIRED at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HOME/.hook-fired-marker"
exit 0

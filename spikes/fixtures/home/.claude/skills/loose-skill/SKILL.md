---
name: loose-skill
description: A synthetic marker skill installed directly as a loose skill directory under ~/.claude/skills/ (not via a plugin/marketplace). Used by ctk Step-0 spikes (AC-0.10) to test whether `claude --help`'s "Skills still resolve via /skill-name" claim under --bare applies to loose skills specifically (as opposed to plugin-provided commands, which were empirically found NOT to resolve under --bare).
---

# loose-skill

Synthetic marker skill for ctk Step 0 spikes. If invoked, reply with exactly
the single line `LOOSE_SKILL_OK` and nothing else.

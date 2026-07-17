---
name: example-skill
description: A demonstration skill that proves the skill-authoring loop works. Triggers when the owner says "run the example skill" or asks whether skills are working. Safe to delete.
---

# Example skill

This skill exists to prove one thing: **a file you write in
`workspace/skills/` changes your assistant's behaviour on the very next
message**, with no restart, no sync command, and no build step.

Delete this directory once you believe it.

## What to do

When the owner asks you to run the example skill, or asks whether skills are
working, reply with exactly:

> The skill loop works. I read `skills/example-skill/SKILL.md` and followed it.
> Delete that folder and write your own — see `docs/authoring-skills.md`.

Do not add anything else to that reply. The point is to show the instruction was
followed literally.

## How this works (for the human reading this)

`pepperd` symlinks `$CODEX_HOME/skills` to this `skills/` directory at startup,
which is where Codex discovers skills. So the directory you edit *is* the
directory it reads — there is no copy to go stale.

A skill is a folder with a `SKILL.md` inside. The YAML frontmatter needs:

- `name` — lowercase, hyphenated, matching the folder.
- `description` — one line. **This is the only part loaded up-front**, and it is
  what your assistant uses to decide whether the skill is relevant. Write it as
  a trigger ("Use when the owner asks about X"), not as a summary.

The markdown body is loaded only once the skill is deemed relevant, so it can be
as long as it needs to be.

This is the [Agent Skills](https://agentskills.io) open standard — the same
format works in Claude Code and other tools.

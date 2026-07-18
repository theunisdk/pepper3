# Authoring skills

A skill is a folder with a `SKILL.md` in it. That's the whole mechanism.

The template ships a real one to crib from: `workspace/skills/google/SKILL.md`
(calendar + email via the gws CLI) — a worked example of trigger-shaped
descriptions, tool recipes, and confirmation rules.

```
workspace/skills/
  daily-checkin/
    SKILL.md
```

`pepperd` symlinks `$CODEX_HOME/skills` to your `workspace/skills/` at startup,
and that's where Codex looks for them. **The directory you edit is the directory
it reads** — no copy, no sync, no restart. Edits to an existing skill are in
effect on the next message. One nuance, observed live: the *list* of skills is
snapshotted when a thread starts, so a **brand-new** skill isn't visible to an
already-running conversation — send `/new` after creating one (scheduled
isolated jobs always get fresh threads, so they see it immediately).

## The anatomy

```markdown
---
name: daily-checkin
description: Records what the owner worked on. Use when they reply to the daily
  check-in question, or say "log that I worked on X".
---

# Daily check-in

## Recording an entry

Append one line to `timesheet.md` in the workspace root, creating it if needed:

    - YYYY-MM-DD | <hours> | <project> | <what they said>

Use the date from the `[Now: ...]` header on this turn — never guess it.
If they don't give hours, ask once. If they say "same as yesterday", read the
last line of the file rather than assuming.

Then confirm in one short line: "Logged: 3h on billing."
```

Two rules that matter more than they look:

**`name`** — lowercase, hyphenated, matches the folder.

**`description`** — this is the only part loaded up front. Your assistant reads
*just this line* to decide whether the skill is relevant to what you said. So
write it as a **trigger**, not a summary:

| Bad (summary) | Good (trigger) |
|---|---|
| `Handles timesheet functionality` | `Use when the owner reports what they worked on, or replies to the daily check-in.` |
| `Calendar utilities` | `Use when the owner asks about their schedule, or wants to create/move a meeting.` |

The body is loaded only once the skill is judged relevant, so it can be as long
as it needs to be. Put the fiddly details there, not in the description.

## Worked example: a daily check-in

Most personal automations are this shape — *ask me something on a schedule, do
something with my answer*. Here's the whole thing.

### 1. Write the skill

`workspace/skills/daily-checkin/SKILL.md` — as above.

### 2. Ask for the schedule

> **You:** Ask me what I worked on every weekday at 16:30.

Your assistant runs:

```bash
pepperctl cron add --name daily-checkin --cron '30 16 * * 1-5' \
  --mode main --prompt 'Ask the owner what they worked on today.'
```

From that moment the **daemon** owns the schedule. The model does not have to
remember; it cannot forget.

### 3. What happens at 16:30

The prompt arrives **on your own conversation thread** (`--mode main`). So when
you reply "3h on billing", it's just the next message in the same conversation —
the question and your answer share one context. The skill fires, the line is
appended, you get one short confirmation.

That's the whole reason `--mode main` is the default. A job that asks a question
on a *separate* thread produces an assistant that has no idea what your reply
refers to.

### 4. Check it's real

```
/jobs
```
or, for history:
```bash
pepperctl runs --name daily-checkin
```

## `main` vs `isolated`

| | Use for | Why |
|---|---|---|
| `--mode main` (default) | Anything expecting a reply | The prompt and your answer share your thread |
| `--mode isolated` | Fire-and-forget reports | A throwaway thread; keeps a 200-line morning brief from bloating your real conversation |

## Adding a tool

Skills describe *what to do*. Tools are *what it can do*.

```bash
cat > workspace/tools/weather <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
curl -fsSL "https://wttr.in/${1:-Johannesburg}?format=3"
EOF
chmod +x workspace/tools/weather
```

Then add one line under "Custom tools" in `workspace/AGENTS.md`:

```markdown
- `weather [city]` — current conditions, one line. Defaults to Johannesburg.
```

A tool your assistant doesn't know about is a tool it will never use. The
`AGENTS.md` line is not optional bookkeeping — it *is* the discovery mechanism.

## Debugging

**It ignored my skill.** Almost always the `description`: it didn't read as
relevant to what you said. Rewrite it as a trigger with the words you actually
use. Check `/status` shows skills linked.

**It ignored my *brand-new* skill mid-conversation.** Skills are discovered at
thread start. Send `/new` and ask again — if it works on the fresh thread, the
skill is fine; your old thread just predated it.

**It fired at the wrong time.** `pepperctl cron list` shows the timezone each
job uses. Cron is evaluated in the job's `tz`, not the server's.

**It didn't fire at all.** `pepperctl runs --name <job>` — Pepper records every
occurrence, including ones it skipped and why. Silence is a bug here, not a
mystery.

## Style that works

- **Be blunt and specific.** "Append one line to `timesheet.md`" beats "manage
  the timesheet appropriately."
- **Say what to do when it's ambiguous.** "If they don't give hours, ask once."
  Ambiguity is where an assistant invents things.
- **Name exact paths and formats.** You are writing for something that will
  otherwise guess.
- **Reference the date header.** Anything date-sensitive should say "use the
  date from the `[Now: ...]` header" — the thread may be weeks old.
- **Keep one skill to one job.** Two loosely-related jobs in one skill means the
  description can only trigger on one of them.

The format is the [Agent Skills](https://agentskills.io) open standard, so
anything you write here also works in Claude Code and other tools.

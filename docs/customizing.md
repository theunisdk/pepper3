# Customizing your assistant

Everything your assistant is — personality, rules, knowledge, procedures,
capabilities — is plain files in the workspace. One mechanism, five layers:

| You want to change… | Edit | Takes effect |
|---|---|---|
| Personality, tone, standing rules | `SOUL.md` | next `/new` |
| Durable facts about you | `MEMORY.md` | next `/new` |
| This week's context | `notes/YYYY-MM-DD.md` | next `/new` |
| A repeatable procedure | `skills/<name>/SKILL.md` | body edits: next message; **new** skills: next `/new` |
| A capability | executable in `tools/` + a line in `SOUL.md` | next message |

`AGENTS.md` is deliberately **not** on this list: it holds the mechanical rules
(only-final-response, confirmations, safety) and is made read-only at startup.
Personality lives in `SOUL.md`; machinery lives in `AGENTS.md`.

## From Telegram

Just tell it. These all work from your phone:

> "Remember that I take Fridays off" → appends to `MEMORY.md`
> "From now on, keep replies under three sentences" → edits `SOUL.md`, shows
> you the change, commits it, reminds you it lands on `/new`
> "Learn this: when I say 'log expense', append to expenses.md" → writes a new
> skill (visible from the next `/new`)

This does not violate the no-auto-learning rule — the assistant never changes
itself *unprompted*. You asking in chat is you authoring the behaviour; chat is
just the editor.

`/soul` shows the current SOUL.md any time.

## Every change is a commit (local-only)

The workspace is a standalone git repo, created automatically:

- The assistant commits each behaviour edit with a one-line message; anything
  uncommitted gets swept into a commit at daemon startup. Nothing changes
  silently.
- **History never leaves the box.** No remote is configured, the app repo
  gitignores the workspace entirely, and your EBS snapshots already back it
  up. If you want off-box history, add your own **private** remote — never the
  public template repo.

Useful, from a shell on the box:

    git -C ~/pepper/workspace log --oneline     # personality history
    git -C ~/pepper/workspace diff HEAD~1       # what changed last
    git -C ~/pepper/workspace revert HEAD       # the undo button

## The honest fine print

Making `AGENTS.md` read-only (0444) stops *accidental* edits — the agent's
file tools will fail — but the agent owns the file, so it is not a hard
security boundary. The git history is the detection layer. On EC2 you can make
it a real boundary: `sudo chown root:root ~pepper/pepper/workspace/AGENTS.md`
after first boot (re-run after you merge template updates into it).

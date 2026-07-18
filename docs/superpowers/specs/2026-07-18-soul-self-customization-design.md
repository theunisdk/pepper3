# Pepper — SOUL.md & Self-Customization from Chat: Design Spec

**Date:** 2026-07-18
**Status:** Approved (owner); building
**Builds on:** [2026-07-16-pepper-personal-agent-design.md](2026-07-16-pepper-personal-agent-design.md)

## 1. Purpose

Make "change how the assistant behaves" a first-class, safe operation the owner can perform **from Telegram** — while keeping the determinism contract: Pepper never changes itself unprompted; owner-directed edits via chat are the owner authoring behaviour, with chat as the editor.

Three gaps close:
1. **Blast radius** — today the owner-editable persona lives inside `AGENTS.md` next to the mechanical safety rails; an agent editing the file it runs on can clobber them. Split them structurally.
2. **Audit/undo** — behaviour edits accumulate invisibly. Version the workspace with git (local-only).
3. **Effect timing** — skill-list snapshotting (observed live) means edits land at thread start; the protocol must say so.

## 2. Design

### 2.1 The SOUL.md / AGENTS.md split

- **`SOUL.md`** (new, in `workspace.template/`): everything owner-editable moves here — Identity, "Your owner", and the "Custom tools" inventory. Header states the contract: this file is yours; Pepper edits it **only when you ask**, shows the diff, and commits.
- **`AGENTS.md`** becomes purely mechanical (output rules, memory conventions, CLI method, scheduling, safety, `pepperctl send` rule) plus a new mechanical **self-edit protocol** section: on an owner request to change behaviour → edit `SOUL.md` (or the named skill), show a diff summary, say "takes effect on `/new`", commit to the workspace git repo with a one-line message. Never edit `AGENTS.md`; never change behaviour unprompted (existing rule, restated at the point of use).
- **Loading:** the daemon injects `SOUL.md` into standing context at every thread start, **before** `MEMORY.md`, and — like `MEMORY.md` — it is never truncated under budget pressure. (Same effective timing as Codex's native `AGENTS.md` load: thread start.)
- **Read-only enforcement:** `initWorkspace` chmods `AGENTS.md` to `0444`. Honest framing: the agent runs as the file's owner, and Landlock does not govern chmod, so this is an **accident barrier** (file tools fail on write), not a security boundary against a determined bypass — the git audit trail is the detection layer, and the docs say exactly this. (EC2 hardening note: root-owning AGENTS.md post-boot makes it a real boundary; documented, not automated.)

### 2.2 Workspace git (local-only)

- `initWorkspace` runs `git init` in the workspace if absent (with a repo-local identity `Pepper <pepper@localhost>` so commits never depend on global git config), writes a workspace `.gitignore` (`run/`), and makes an initial commit.
- On every startup, uncommitted drift is committed as a catch-all (`"uncommitted workspace changes found at startup"`) — nothing ever silently accumulates outside history.
- **No remote, ever, by default.** The workspace repo is standalone; the app repo's `.gitignore` already excludes `/workspace/` and `var/`, so nested history cannot leak into the public repo. Docs state: EBS snapshots are the backup; add your own **private** remote only if you want off-box history.
- Rollback story: `git -C <workspace> log/diff/revert` — behaviour history is commit history.

### 2.3 `/soul` Telegram command

View-only: replies with the current `SOUL.md` content (or a hint if missing). Handled by the daemon out-of-band like the other slash commands. Editing stays conversational ("change X…" → protocol above) — no write-from-command surface.

### 2.4 Migration for existing workspaces

`initWorkspace` copies the template only on first boot, so existing deployments get: `SOUL.md` created from the template **if missing**; git initialised if absent; chmod applied each startup. The restructured `AGENTS.md` does **not** auto-propagate (the live file is the owner's); docs note the manual merge, and the local test env is synced by hand.

## 3. Testing / acceptance

- Unit: standing context includes `SOUL.md` first and never truncates it (extend context tests); new `tests/workspace.test.ts` — SOUL created when missing, git initialised with initial commit, startup drift auto-committed, `AGENTS.md` mode 0444, `.gitignore` present, idempotent re-runs.
- Live: an isolated job instructs Pepper (per the protocol) to add a rule to `SOUL.md`; verify the file changed, the workspace git log shows the commit, and a fresh thread's standing context carries the rule. `/soul` returns the content.
- `npm run audit` green; no workspace path ever tracked by the app repo.

## 4. Out of scope

Editing SOUL.md via slash command (chat conversation is the editor); automated AGENTS.md template-upgrade merging; any remote for the workspace repo; per-rule granularity/permissions.

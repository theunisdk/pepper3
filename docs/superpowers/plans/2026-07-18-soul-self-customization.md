# SOUL.md & Self-Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split owner-editable persona into `SOUL.md` (agent-editable on request, loaded every thread), make `AGENTS.md` purely mechanical and read-only, version the workspace with a **local-only** git repo, add a `/soul` view command, and document the from-Telegram customization protocol.

**Architecture:** Template restructure (T1) → standing-context loading (T2) → workspace bootstrap: SOUL ensure + git + chmod (T3) → `/soul` command + docs (T4). Spec: `docs/superpowers/specs/2026-07-18-soul-self-customization-design.md`.

**Tech Stack:** TypeScript (ESM, `.js` specifiers, strict + noUncheckedIndexedAccess), vitest, `node:child_process.execSync` for git.

## Global Constraints

- **PUBLIC repo**; `npm run audit` must pass before push. The workspace git repo must have **no remote** and must never become trackable by the app repo (already gitignored — do not weaken that).
- All imports use `.js` specifiers.
- `MEMORY.md` and `SOUL.md` are **never truncated** by the standing-context budget; only daily notes are.
- The self-edit contract wording must keep the determinism rule intact: Pepper edits behaviour files **only when the owner asks**, never unprompted.
- Commit after each task with the message given in the task.

---

### Task 1: Template restructure — SOUL.md, mechanical AGENTS.md, workspace .gitignore

**Files:**
- Create: `workspace.template/SOUL.md`, `workspace.template/.gitignore`
- Modify: `workspace.template/AGENTS.md`

**Interfaces:**
- Produces: the template files Tasks 2–3 load and test against. No code.

- [ ] **Step 1: Create `workspace.template/SOUL.md`** with exactly:

```markdown
# Soul

This file is **yours**. It holds everything that makes this assistant *your*
assistant: identity, tone, standing rules, who you are, and the tools you've
added. It is loaded at the start of every conversation.

Change it two ways, both equally valid:

- Edit it directly, like any file.
- **Tell your assistant in chat** — "from now on, keep replies under three
  sentences". It will edit this file, show you the diff, commit the change to
  the workspace's local git history, and remind you it takes effect on `/new`.

Your assistant never changes this file unprompted. Every change is a commit in
the workspace repo — `git -C <workspace> log` is the history of its
personality, and `git revert` is the undo button.

## Identity

- Your name is Pepper.
- You serve exactly one person: your owner.
- Tone: direct and warm. No filler, no "Certainly!", no restating the question.

## Rules

<!-- Standing behaviour rules you've added. One bullet each, e.g.:
- Keep replies under three sentences unless I ask for detail.
- Never use emoji.
-->

_None yet._

## Your owner

<!-- Tell your assistant about yourself. It reads this every conversation.
     Examples:
     - I'm a software developer; default to technical depth.
     - I'm in Africa/Johannesburg. Working hours 08:00-17:00.
     - When I say "the box", I mean my EC2 instance.
-->

_Not filled in yet._

## Custom tools

<!-- Document each executable you drop into tools/. One line each, e.g.:
- `weather [city]` — current conditions, one line. Defaults to Johannesburg.
-->

_None yet._
```

- [ ] **Step 2: Create `workspace.template/.gitignore`** with exactly:

```
# Runtime; never part of the workspace's behaviour history.
run/
```

- [ ] **Step 3: Restructure `workspace.template/AGENTS.md`**

Apply these exact edits:

(a) Replace the opening (everything from `# Operating instructions` through the end of the `## Identity _(yours)_` section, i.e. up to but excluding `## How to reply`) with:

```markdown
# Operating instructions

You are a personal assistant running as a daemon. You talk to your owner over
Telegram. This file is loaded on every turn — it is the closest thing you have
to instinct.

> **This file is mechanical and read-only.** It defines how you operate, not
> who you are. Everything personal — identity, tone, standing rules, owner
> context, custom tools — lives in `SOUL.md`, which is loaded alongside this
> file and which you may edit **when your owner asks**. You never edit this
> file.
```

(b) In the `## Memory (mechanical — do not remove)` section, replace the line:

```markdown
- `MEMORY.md` — durable facts and preferences about your owner. Loaded every
  time. When asked to remember something durable, **append** to it. Never
  rewrite or reorder it; never delete an entry unless asked.
```

with:

```markdown
- `SOUL.md` — your identity, standing rules, owner context, and tool
  inventory. Loaded every time. Edited only via the self-edit protocol below.
- `MEMORY.md` — durable facts and preferences about your owner. Loaded every
  time. When asked to remember something durable, **append** to it. Never
  rewrite or reorder it; never delete an entry unless asked.
```

(c) In the `## Tools` section, replace the `### Custom tools _(yours — document each one here)_` subsection (heading, comment block, and `_None yet._`) with:

```markdown
Custom tools your owner has added are documented in `SOUL.md` under
"Custom tools" — check there for what's available beyond the basics.
```

(d) Insert a new section immediately **after** the `### Using command-line tools (mechanical — do not remove)` subsection and **before** `## Scheduling (mechanical)`:

```markdown
### Changing your own behaviour (mechanical — do not remove)

When your owner asks you to behave differently from now on — a rule, a tone
change, a preference ("from now on…", "always…", "stop doing…"):

1. Edit `SOUL.md` (or the relevant `skills/*/SKILL.md` for procedures). Never
   edit `AGENTS.md` — it is read-only, and you do not attempt to change that.
2. Reply with a short summary of the exact change you made (quote the added or
   changed lines).
3. Remind them: **it takes effect from the next new thread** — they can `/new`
   any time.
4. Commit it: `git -C . add -A && git -C . commit -m "<one line describing the
   change>"` (the workspace is a local-only git repo; this is their undo
   button and audit trail).

You never make these edits unprompted. A behaviour change without an owner
request in this conversation is a bug, not initiative.
```

(e) Delete the entire `## Your owner _(yours)_` section (heading, comment block, and `_Not filled in yet._`) at the end of the file.

- [ ] **Step 4: Verify structure**

Run: `grep -c '(yours)' workspace.template/AGENTS.md` → `0`; `grep -c 'Changing your own behaviour' workspace.template/AGENTS.md` → `1`; `head -3 workspace.template/SOUL.md` shows `# Soul`.

- [ ] **Step 5: Commit**

```bash
git add workspace.template/SOUL.md workspace.template/.gitignore workspace.template/AGENTS.md
git commit -m "feat: SOUL.md owner file; AGENTS.md purely mechanical + self-edit protocol"
```

---

### Task 2: Load SOUL.md in standing context

**Files:**
- Modify: `src/context.ts`, `tests/context.test.ts`

**Interfaces:**
- Consumes: existing `buildStandingContext(cfg, at)` in `src/context.ts`.
- Produces: standing context that includes `SOUL.md` first, never truncated. No signature changes.

- [ ] **Step 1: Add failing tests**

Append to `tests/context.test.ts` (inside the `describe('buildStandingContext', ...)` block):

```typescript
  it('includes SOUL.md before MEMORY.md', () => {
    const cfg = ws();
    writeFileSync(join(cfg.workspacePath, 'SOUL.md'), '# Soul\n- reply in haiku');
    writeFileSync(join(cfg.workspacePath, 'MEMORY.md'), '- likes tea');
    const ctx = buildStandingContext(cfg, new Date('2026-07-16T09:00:00Z'));
    expect(ctx.text).toContain('reply in haiku');
    expect(ctx.text.indexOf('reply in haiku')).toBeLessThan(ctx.text.indexOf('likes tea'));
  });

  it('never truncates SOUL.md under budget pressure', () => {
    const cfg = { ...ws(), standingContextBudget: 2000 };
    const soul = '# Soul\n' + 'S'.repeat(3000);
    writeFileSync(join(cfg.workspacePath, 'SOUL.md'), soul);
    writeFileSync(join(cfg.workspacePath, 'notes', '2026-07-16.md'), 'N'.repeat(3000));
    const ctx = buildStandingContext(cfg, new Date('2026-07-16T09:00:00Z'));
    expect(ctx.text).toContain('S'.repeat(3000));
    expect(ctx.truncated).toBe(true);
  });

  it('is non-empty when only SOUL.md exists', () => {
    const cfg = ws();
    writeFileSync(join(cfg.workspacePath, 'SOUL.md'), '# Soul\n- a rule');
    expect(buildStandingContext(cfg).text).toContain('a rule');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/context.test.ts` — the three new tests FAIL (SOUL.md content absent).

- [ ] **Step 3: Implement**

In `src/context.ts`, inside `buildStandingContext`:

(a) After the `const memoryPath = ...; const memory = readIfPresent(memoryPath); if (memory?.trim()) files.push(memoryPath);` block, the file currently reads MEMORY then notes. Add SOUL **above** the memory block:

```typescript
  const soulPath = join(cfg.workspacePath, 'SOUL.md');
  const soul = readIfPresent(soulPath);
  if (soul?.trim()) files.push(soulPath);
```

(b) Change the empty-workspace guard from:

```typescript
  if (!memory?.trim() && notes.length === 0) {
    return { text: '', truncated: false, files: [] };
  }
```

to:

```typescript
  if (!soul?.trim() && !memory?.trim() && notes.length === 0) {
    return { text: '', truncated: false, files: [] };
  }
```

(c) After the existing `memBlock` line, add a soul block and include it in the budget and output. Replace:

```typescript
  const memBlock = memory?.trim() ? `\n\n## MEMORY.md (durable — never invent changes to this)\n\n${memory.trim()}` : '';

  let budgetLeft = cfg.standingContextBudget - header.length - memBlock.length;
```

with:

```typescript
  const soulBlock = soul?.trim() ? `\n\n## SOUL.md (your identity and standing rules — follow these)\n\n${soul.trim()}` : '';
  const memBlock = memory?.trim() ? `\n\n## MEMORY.md (durable — never invent changes to this)\n\n${memory.trim()}` : '';

  let budgetLeft = cfg.standingContextBudget - header.length - soulBlock.length - memBlock.length;
```

and change the final assembly from:

```typescript
  const text = `${header}${memBlock}${noteBlocks.join('')}`.trim();
```

to:

```typescript
  const text = `${header}${soulBlock}${memBlock}${noteBlocks.join('')}`.trim();
```

Also update the truncation warning comment/log line's parenthetical from "(MEMORY.md was not)" to "(SOUL.md and MEMORY.md were not)".

- [ ] **Step 4: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit` — all pass.

- [ ] **Step 5: Commit**

```bash
git add src/context.ts tests/context.test.ts
git commit -m "feat: load SOUL.md into standing context first, never truncated"
```

---

### Task 3: Workspace bootstrap — SOUL ensure, local git, read-only AGENTS.md

**Files:**
- Modify: `src/workspace.ts`
- Create: `tests/workspace.test.ts`

**Interfaces:**
- Consumes: template files from Task 1; existing `initWorkspace(cfg)` and `templateDir()` in `src/workspace.ts`.
- Produces: same `initWorkspace(cfg): WorkspaceStatus` signature (no interface change; new behaviours are filesystem-observable).

- [ ] **Step 1: Write failing tests**

Create `tests/workspace.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../src/workspace.js';
import type { PepperConfig } from '../src/config.js';

function cfgIn(dir: string): PepperConfig {
  return {
    ownerTelegramIds: [1],
    timezone: 'UTC',
    turnTimeoutMs: 60_000,
    standingContextBudget: 20_000,
    workspacePath: join(dir, 'workspace'),
    codexHome: join(dir, 'codex-home'),
    dbPath: join(dir, 'db.sqlite'),
    dailyNoteDays: 2,
    cronGraceMs: 60_000,
    sandboxWritableRoots: [],
  };
}

function gitLog(ws: string): string {
  return execSync(`git -C "${ws}" log --oneline`, { encoding: 'utf8' }).trim();
}

describe('initWorkspace', () => {
  it('creates the workspace with SOUL.md and a local git repo with one commit', () => {
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);

    expect(existsSync(join(cfg.workspacePath, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(cfg.workspacePath, '.git'))).toBe(true);
    expect(gitLog(cfg.workspacePath).split('\n')).toHaveLength(1);
    // Local-only: no remote may ever be configured by us.
    const remotes = execSync(`git -C "${cfg.workspacePath}" remote`, { encoding: 'utf8' }).trim();
    expect(remotes).toBe('');
  });

  it('makes AGENTS.md read-only (0444) as an accident barrier', () => {
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);
    const mode = statSync(join(cfg.workspacePath, 'AGENTS.md')).mode & 0o777;
    expect(mode).toBe(0o444);
  });

  it('is idempotent — a second run adds no commits', () => {
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);
    initWorkspace(cfg);
    expect(gitLog(cfg.workspacePath).split('\n')).toHaveLength(1);
  });

  it('auto-commits drift found at startup', () => {
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);
    writeFileSync(join(cfg.workspacePath, 'MEMORY.md'), '# Memory\n- drifted');
    initWorkspace(cfg);
    const log = gitLog(cfg.workspacePath);
    expect(log.split('\n')).toHaveLength(2);
    expect(log).toContain('uncommitted workspace changes');
  });

  it('recreates SOUL.md from the template if it went missing', () => {
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);
    rmSync(join(cfg.workspacePath, 'SOUL.md'));
    initWorkspace(cfg);
    expect(existsSync(join(cfg.workspacePath, 'SOUL.md'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/workspace.test.ts` — FAIL (no SOUL.md in fresh copy until Task 1's template lands — it has; no `.git`; mode not 0444).

- [ ] **Step 3: Implement**

In `src/workspace.ts`:

(a) Extend the fs import line to include `chmodSync` and `copyFileSync`, and add:

```typescript
import { execSync } from 'node:child_process';
```

(b) In `initWorkspace`, after the `for (const sub of ...) mkdirSync(...)` loop and the `mkdirSync(cfg.codexHome, ...)` line, insert:

```typescript
  // Existing workspaces predate SOUL.md: create it from the template so the
  // self-edit protocol always has its target file.
  const soulPath = join(cfg.workspacePath, 'SOUL.md');
  if (!existsSync(soulPath)) {
    const templateSoul = join(templateDir(), 'SOUL.md');
    if (existsSync(templateSoul)) {
      copyFileSync(templateSoul, soulPath);
      logger.info({ soulPath }, 'created SOUL.md from template');
    }
  }

  // AGENTS.md is mechanical and not the agent's to edit. 0444 is an accident
  // barrier (file tools fail on write), not a security boundary — the agent
  // owns the file and chmod is not sandbox-governed. The workspace git history
  // below is the detection layer.
  const agentsPath = join(cfg.workspacePath, 'AGENTS.md');
  if (existsSync(agentsPath)) chmodSync(agentsPath, 0o444);

  initWorkspaceGit(cfg.workspacePath);
```

(c) Add at the bottom of the file:

```typescript
/**
 * The workspace is a standalone, LOCAL-ONLY git repo: behaviour edits become
 * commits (audit + undo). No remote is ever configured here — this history
 * contains the owner's memory and rules and must never leave the box unless
 * the owner adds a private remote themselves.
 */
function initWorkspaceGit(ws: string): void {
  const git = (args: string) => execSync(`git -C "${ws}" ${args}`, { stdio: 'pipe' }).toString();
  try {
    if (!existsSync(join(ws, '.git'))) {
      git('init -q');
      // Repo-local identity so commits never depend on global git config.
      git('config user.name Pepper');
      git('config user.email pepper@localhost');
      git('add -A');
      git('commit -q -m "workspace created"');
      logger.info({ ws }, 'initialised local workspace git repo');
      return;
    }
    if (git('status --porcelain').trim().length > 0) {
      git('add -A');
      git('commit -q -m "uncommitted workspace changes found at startup"');
      logger.info({ ws }, 'committed workspace drift found at startup');
    }
  } catch (e) {
    // Never let bookkeeping stop the assistant from starting.
    logger.warn({ ws, err: (e as Error).message }, 'workspace git bookkeeping failed');
  }
}
```

- [ ] **Step 4: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit` — all pass (note: `tests/context.test.ts` and `tests/integration.test.ts` create bare temp workspaces without git; they never call `initWorkspace`, so they are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/workspace.ts tests/workspace.test.ts
git commit -m "feat: workspace bootstrap — SOUL ensure, local-only git history, read-only AGENTS.md"
```

---

### Task 4: `/soul` command + docs

**Files:**
- Modify: `src/chat/gateway.ts`, `src/pepperd.ts`, `README.md`, `CLAUDE.md`
- Create: `docs/customizing.md`

- [ ] **Step 1: Add the command**

In `src/chat/gateway.ts`, change:

```typescript
const COMMANDS = ['new', 'status', 'jobs', 'cancel'] as const;
```

to:

```typescript
const COMMANDS = ['new', 'status', 'jobs', 'cancel', 'soul'] as const;
```

In `src/pepperd.ts`: add to the fs-less import block at the top:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
```

(keep the existing `import { resolve } from 'node:path';` — merge into one line: `import { join, resolve } from 'node:path';`)

In `onCommand`'s switch, add before `default:`:

```typescript
        case 'soul': {
          const soulPath = join(cfg.workspacePath, 'SOUL.md');
          if (!existsSync(soulPath)) return 'No SOUL.md yet — restart pepperd to create it from the template.';
          return readFileSync(soulPath, 'utf8');
        }
```

- [ ] **Step 2: Create `docs/customizing.md`** with exactly:

```markdown
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
```

- [ ] **Step 3: README + CLAUDE.md touches**

README.md, "Making it yours" table: change the first row from `| Change its personality, tone, rules | \`workspace/AGENTS.md\` |` to `| Change its personality, tone, rules | \`workspace/SOUL.md\` — or just tell it in chat |`, and add below the table: `Full guide, including managing it all from Telegram: [docs/customizing.md](docs/customizing.md).`

README.md, "Chat commands" table: add row `| \`/soul\` | Show the current SOUL.md (your rules and identity) |`.

CLAUDE.md, "Invariants that must not be broken" list — add:

```markdown
- **SOUL.md is the owner-editable layer; AGENTS.md is mechanical and read-only.** `SOUL.md` loads via standing context (never truncated, like `MEMORY.md`); `initWorkspace` chmods `AGENTS.md` to 0444 (accident barrier, not a security boundary — the workspace's local git history is the detection layer). The workspace git repo must never get a remote from our code.
```

- [ ] **Step 4: Gates + commit**

Run: `npx vitest run && npx tsc --noEmit && npm run build && npm run audit` — all green.

```bash
git add src/chat/gateway.ts src/pepperd.ts docs/customizing.md README.md CLAUDE.md
git commit -m "feat: /soul command; customizing guide (from-Telegram protocol, local-only git)"
```

---

### Task 5: Final verification (orchestrator-run)

- [ ] Gates: full suite, typecheck, build, audit.
- [ ] Sync the throwaway local workspace: copy new `AGENTS.md` + `SOUL.md` + `.gitignore` into `var/local/workspace/`, restart the local daemon so `initWorkspace` runs (git init, chmod).
- [ ] Live: isolated job instructing Pepper per the protocol to add a rule to SOUL.md; verify file content, workspace `git log`, and that `/soul`-equivalent read shows it.
- [ ] Push `origin main`.

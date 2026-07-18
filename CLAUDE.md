# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> ## ⚠️ This is a PUBLIC repository
>
> Nothing private or deployment-specific may ever be committed: no secrets, API keys, bot tokens, AWS account IDs, KMS ARNs, S3 bucket names, EC2 instance IDs, or real Telegram user IDs — and no `terraform.tfvars`, `*.tfstate*`, `auth.json`, or a populated `pepper.config.json`. All of these are already gitignored; keep them that way and never `git add -f` them.
>
> **Run `npm run audit` before every push to the remote.** It scans tracked files and fails on leaked identifiers/secrets, and reads additional real-value patterns from a gitignored `.audit-secrets`. It is verified to actually catch planted secrets, so a green audit is meaningful — but it is a backstop, not a licence to be careless.
>
> The live `workspace/` and `var/` are runtime state, gitignored, never source. When in doubt about whether something is safe to commit, run the audit and check `git status` — do not commit and hope.

## What this is

Pepper is a **template** for a single-user personal AI assistant: a Node/TypeScript daemon (`pepperd`) that chats over Telegram, runs scheduled jobs, and drives OpenAI Codex on the owner's ChatGPT subscription. It ships deliberately blank — no domain skills — and is extended by editing files in a workspace, not by writing more `src/`.

The design is a reaction to OpenClaw/Hermes failures (answer bleed, tool output leaking into chat, reset amnesia, silent cron misfires). Much of what looks over-engineered exists to make each of those failures *structurally impossible* rather than prompt-mitigated. **Before "simplifying" any of the invariants below, read [docs/superpowers/specs/](docs/superpowers/specs/) and [docs/spike-findings.md](docs/spike-findings.md) — they explain why each one is load-bearing.**

## Commands

```bash
npm test                          # vitest, all unit + integration tests (no Codex/network needed)
npx vitest run tests/queue.test.ts        # a single test file
npx vitest run -t "coalesces"             # tests matching a name
npm run typecheck                 # tsc --noEmit
npm run build                     # tsc -> dist/  (required before `npm start`)
npm run dev                       # tsx watch src/pepperd.ts (local, needs config + env)
npm run spike                     # integration test against REAL Codex — needs a `codex login`
npm run audit                     # MUST pass before pushing to the public remote
```

Running locally: copy `pepper.config.example.json` to `pepper.config.json`, set `TELEGRAM_BOT_TOKEN` and `PEPPER_OWNER_TELEGRAM_IDS` in the env, `codex login` into the configured `codexHome`, then `npm run build && npm start`. The whole test suite runs without any of that — see the Engine boundary below.

## Architecture

### The Engine boundary (the single most important thing)

Everything cognitive is behind `Engine` ([src/engine/types.ts](src/engine/types.ts)): `runTurn` / `runIsolated` / `resetThread` / `health`. The gateway, queue, and scheduler talk **only** to this interface, never to Codex directly.

- `CodexEngine` ([src/engine/codex/adapter.ts](src/engine/codex/adapter.ts)) is the real implementation.
- `FakeEngine` ([src/engine/fake.ts](src/engine/fake.ts)) implements the same interface with no network. This is why the entire daemon — including the scheduler and control socket — is tested end-to-end with no subscription and no quota burn ([tests/integration.test.ts](tests/integration.test.ts)).

When touching daemon logic, prefer keeping it above the boundary so it stays testable against `FakeEngine`. Anything Codex-specific belongs in `src/engine/codex/`.

### Data flow

Telegram (grammY long-poll) → allowlist check → `TurnQueue` → `Engine` → Codex → `finalResponse` back to Telegram. The scheduler and the `pepperctl` control socket feed into the same queue/engine. `src/pepperd.ts` is the composition root that wires it all together.

### Invariants that must not be broken

Each of these prevents a specific, named bug. Changing them reintroduces it.

- **Only `finalResponse` reaches Telegram.** `CodexEngine.execute` logs every non-`agent_message` item (tool calls, reasoning, command output) and drops it. There is intentionally no code path from a tool item to a chat message. (Prevents debug/tool-output leaking into chat.)
- **One turn in flight per chat; mid-turn messages coalesce.** `TurnQueue` ([src/chat/queue.ts](src/chat/queue.ts)) never runs two turns concurrently on one thread and merges messages that arrive mid-turn into the *next* turn. (Prevents replies that answer a previous question.)
- **The scheduler is occurrence-keyed.** `UNIQUE(job_id, scheduled_for)` in [src/db.ts](src/db.ts) + `claimRun` in [src/scheduler/jobs.ts](src/scheduler/jobs.ts): an occurrence is claimed by inserting its run row *before* firing, so the live ticker and restart catch-up can race without double-firing or silently skipping. Never key firing on wall-clock `now`. (Prevents silent cron misfires.)
- **Durable state lives on disk, re-injected per thread.** `buildStandingContext` ([src/context.ts](src/context.ts)) reloads `MEMORY.md` + dated notes whenever a thread starts; a **date header is prepended to every turn** (threads live for weeks, so a turn-1 timestamp goes stale). `MEMORY.md` is never truncated under budget pressure — daily notes are. (Prevents reset amnesia.)
- **Subscription-only guard.** `sanitiseEnv` ([src/engine/codex/env.ts](src/engine/codex/env.ts)) strips `OPENAI_API_KEY` and friends from Codex's environment and logs when it does — otherwise one stray env var silently switches from the ChatGPT subscription to per-token API billing.
- **Auth health is computed, not queried.** `checkAuth` ([src/engine/codex/auth.ts](src/engine/codex/auth.ts)) decodes the JWT `exp` from `auth.json` itself. Do not shell out to `codex login status` — it reports "logged in" for long-dead credentials (see spike findings).
- **The control socket lives inside the workspace.** `workspace/run/pepperd.sock`, not `/run`. The agent's shell runs in Codex's workspace-scoped sandbox; a socket outside it may be unreachable. `pepperctl` ([src/pepperctl.ts](src/pepperctl.ts)) is a CLI, not an MCP server, because headless MCP tool-approval stalls (see spike findings).
- **Skills are a symlink, not a copy.** On startup `initWorkspace` ([src/workspace.ts](src/workspace.ts)) symlinks `$CODEX_HOME/skills` → `workspace/skills`, so an edited skill is live on the next turn with no sync step.

### Template vs. runtime

- `workspace.template/` is the shipped blank starting point (tracked). On first boot `pepperd` copies it to the live `workspacePath`.
- The live `workspace/` (and `var/`, `*.sqlite`, `pepper.config.json`, `auth.json`) is **runtime state and gitignored** — never source.
- `AGENTS.md`, `MEMORY.md`, and `skills/**/SKILL.md` in the workspace are the assistant's *behaviour*, not code. Changing what the assistant does usually means editing those, not `src/`. See [docs/authoring-skills.md](docs/authoring-skills.md).

### Constraints from the M1 spike

[docs/spike-findings.md](docs/spike-findings.md) records what was verified against real Codex. Load-bearing consequences:

- `@openai/codex-sdk` is **pinned exactly** (currently `0.144.5`) because it vendors the `codex` binary — pinning the SDK pins the runtime. Don't loosen it casually.
- Codex refresh tokens are **single-use/rotating**: never copy `auth.json` between hosts or run `codex` from two places sharing one `CODEX_HOME`; re-login instead.

## Infrastructure & public-repo hygiene

- Terraform: reusable module in `terraform/modules/pepper/`, consumed by the deployment root `instances/pepper/`. SSM-only access, no ingress, secrets in Parameter Store, **no OpenAI API key is ever provisioned** (the daemon runs on the subscription). `telegram_allowed_users` has **no default** — that's the security control; do not add one.
- The public-repo rule is stated in full at the top of this file. Enforcement lives in [scripts/audit-public.sh](scripts/audit-public.sh) (`npm run audit`). The audit script itself must contain **no real identifiers** — hardcoding one there would publish the very thing it guards against; put real values in the gitignored `.audit-secrets` instead.

## Conventions

- ESM throughout, `.js` import specifiers (NodeNext resolution), `strict` + `noUncheckedIndexedAccess` TypeScript.
- Errors carry meaning across the Engine boundary via typed classes (`EngineAuthError`, `ThreadResumeError`, `ContextExhaustedError`) that `pepperd` maps to owner-facing behaviour — prefer extending those over generic `Error` when the caller needs to react.
- Logs go to pino/journald; they are the *only* place tool/model internals appear.

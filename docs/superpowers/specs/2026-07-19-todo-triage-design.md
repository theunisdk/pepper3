# Pepper — Todo Store & Hourly Concierge Triage: Design Spec

**Date:** 2026-07-19
**Status:** Approved (owner decisions taken); building
**Builds on:** [2026-07-18-context-feeds-design.md](2026-07-18-context-feeds-design.md)

## 1. Purpose

The core loop: every hour at :05, Pepper processes Concierge's hourly delta and turns items the owner should act on into entries in a **CRUD todo list with stable IDs (T1, T2, …)** — governed by an owner rulebook that will grow through chat-based refinement.

### Owner decisions (2026-07-19)

| Decision | Choice |
|---|---|
| Hourly cadence | **Silent unless action** — message only when todos were created or something is urgent; quiet hours send nothing |
| Personal items | **Treated like work** — triaged and announced like any business context (supersedes the earlier SOUL rule hiding `personal_private` from proactive messages; that rule is amended) |
| Third work context | **Activated at the source** — concierge config change (its repo) so items classify as the third work context on ingestion; Pepper rules reference it cleanly |

## 2. Design — three layers, same doctrine as everything else

### 2.1 The store: daemon-owned (pattern 3 — the daemon owns the guarantees)

`todos` table in Pepper's SQLite. **IDs are daemon-assigned** (`T<rowid>`, AUTOINCREMENT so numbers are never reused); the model never invents one. **Dedup is structural**: a todo created from a feed item records the item's deterministic id in `source_id` with a UNIQUE constraint — re-adding the same source returns the existing todo (`created: false`) instead of a duplicate, no matter how many hourly runs re-see the item. Manual todos (`source_id` NULL, multiple allowed) share the same table and ID space.

Shape: `id, title, context (default 'unclassified'), status (open|done|dropped), source_id UNIQUE nullable, due_date (YYYY-MM-DD, nullable), created_at, updated_at, closed_at`.

Surfaces:
- `pepperctl todo add --title <t> [--context c] [--source id] [--due d]` (prints `T14 created` or `T9 already covers this source`), `todo list [--all|--status s] [--context c]`, `todo done|drop <T-id>`, `todo update <T-id> [--title|--context|--due]` — over the existing control socket (agent-reachable, sandbox-proof).
- `/todos` Telegram command: open todos grouped by context, `T14 · title (due …)`.

### 2.2 The rules: `workspace/triage.md` (private, chat-refined)

The rulebook the hourly run obeys. Deliberately **not** in the skill (public, stable mechanics) and **not** in SOUL.md (loaded every thread; a growing rulebook would tax every conversation). Edited exactly like SOUL.md: owner says "from now on…" → Pepper edits, shows the change, `pepperctl commit`, effective next run. Pepper may **propose** rules when it notices recurring patterns; only the owner's yes writes one (determinism doctrine).

Starter content: context list (the owner's work contexts + personal), the owner decisions above, and default thresholds — refined from chat thereafter.

### 2.3 The mechanics: an "Hourly triage" section in the canonical concierge skill (public plug)

Defaults, all overridable by `triage.md`: process `hourly.json` only (the delta — natural incremental input); skip `marketing`/`automated`; `needs_response` → "Reply to …" todo; `detected_actions` with dates → dated todos; `risk_score ≥ 70` → todo; calendar conflicts / `prep_required` → todo. Every feed-derived todo passes `--source <item-id>` (the dedup contract). Report per the cadence decision: created todos and urgent items only; **if nothing, reply with exactly nothing** (an empty reply sends no Telegram message — existing scheduler behaviour).

### 2.4 The job + transport

- Cron job `concierge-triage`, `5 * * * *`, **isolated** mode (fresh thread, feed skill discovered, main-thread hygiene).
- Fresh files: the feed sync must now be automatic. Local bridge: a `workspace/tools/sync-concierge` tool (private workspace, contains the bucket name) that the triage run executes first — a documented, pragmatic exception to "transport outside the assistant" for the local box; at EC2 deploy the systemd timer owns transport and the tool becomes a no-op convenience. SOUL's Custom tools section documents it.

### 2.5 Concierge-side (its repo, uncommitted for owner review)

Activate the third work context (rename/activate `us_client`) in `businessContexts.ts`; map its mailbox in `accounts.ts` if one is configured. Takes effect on their next concierge deploy; until then such items arrive `unclassified` and triage rules may name senders as a stopgap.

## 3. Acceptance

1. Unit: store CRUD, T-numbering monotonic and never reused, source dedup (`created:false` on repeat), status transitions, list filters; control/pepperctl round-trip.
2. Live: manual trigger of the triage run against today's real delta → todos created with T-ids and correct contexts; **second run creates zero duplicates**; `/todos` shows the grouped list; a quiet delta produces no Telegram message.
3. Audit green (no bucket identifiers in tracked files; the sync tool lives in the private workspace).

## 4. Out of scope (v1)

Recurring todos; reminders/escalation on due dates (natural later: a daily job reading the store); todo edit via Telegram slash-commands (chat handles it); daily.json stale-item sweep (the delta covers new arrivals; "about to drop" remains ad hoc); concierge deploy itself.

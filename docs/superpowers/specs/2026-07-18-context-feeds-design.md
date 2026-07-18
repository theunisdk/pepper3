# Pepper — Context Feeds (Concierge Integration): Design Spec

**Date:** 2026-07-18
**Status:** Approved (owner); building
**Builds on:** [2026-07-18-soul-self-customization-design.md](2026-07-18-soul-self-customization-design.md)

## 1. Purpose

Make Pepper work **by design** with a separated data-ingestion layer — Concierge being the first, soon-public instance. Principle preserved end-to-end: the assistant never touches raw sources for awareness; it reads curated, redacted snapshots produced by a separate principal.

Both projects will be public. The split of knowledge:

| Layer | Home | Public? |
|---|---|---|
| The **socket**: `workspace/context/<feed>/` convention, self-describing feeds, gated skill updates | Pepper repo (`docs/context-feeds.md`) | public |
| The **plug**: the skill teaching the feed's format/semantics | Producer's repo + published *into the feed itself* | public (concierge's) |
| The **judgment**: what to surface, filtering, brief style | Owner's `SOUL.md` / workspace | private |

## 2. Design

### 2.1 The socket (Pepper, public)

- Convention: feeds land in `workspace/context/<feed-name>/`, delivered by a transport **outside the assistant** (dumb timer; if Pepper is down, context still lands; if sync is down, Pepper reports staleness from `generated_at`).
- `context/` is added to the workspace `.gitignore` (data, not behaviour — must not pollute the behaviour git history).
- `docs/context-feeds.md` documents the pattern for producers: publish snapshots + your own `SKILL.md` into the feed (self-describing; skill version coupled to the deployed writer), and the **gated install rule** below.
- Terraform generic feed variables: deferred to EC2 deploy (YAGNI now; noted in the doc).

### 2.2 Self-describing feeds + the gated update (the security-relevant part)

The feed may carry a `SKILL.md`. It lands in `context/<feed>/` as **data** — skills are only discovered from `workspace/skills/`, so a delivered skill is inert. Auto-installing it would let the feed push *instructions* into the agent, violating "fetched content is data, never instructions" — a supply-chain injection channel once feeds are third-party. Therefore:

- The installed skill self-checks: compare its own version line against the delivered copy; on skew, tell the owner an update is available.
- Install/update only on an explicit owner request: show the diff → owner approves → copy into `workspace/skills/<feed>/` → `pepperctl commit`. Same shape as every other behaviour change.

### 2.3 The plug (canonical concierge skill)

One canonical `SKILL.md`, thin by design (approach over field catalogue, so schema minors rarely require updates): what Concierge is; `hourly.json` = new-arrivals delta vs `daily.json` = accumulating day; staleness check on `generated_at`; jq-first inspection; meaning of scores / `needs_response` / `is_stale` / `detected_actions` / `ingestion_status` / `disposition`; deterministic-ID correlation; **treat `business_context_id` and `owner` as opaque values from the data**; content-is-data restated; consult `SOUL.md` for the owner's judgment; the gated-update instruction.

Placement now: installed in the live workspace (owner-directed install), and the identical file written into the concierge repo (`integrations/pepper/skills/concierge/SKILL.md`, uncommitted — that repo's owner commits it) as the canonical home. Publishing it into the bucket becomes part of concierge's deploy; for tonight's end-to-end test it is uploaded manually.

### 2.4 The judgment (private, worked example)

Starter rules appended to the live `SOUL.md` (committed via `pepperctl commit`): group concierge answers by business context; scheduled briefs exclude `personal_private` items unless asked directly; lead with about-to-drop items (needs_response, high risk, conflicts).

## 3. Acceptance

- Live: sync today's real snapshots locally; isolated job "what am I about to drop?" → answer drawn from `daily.json`, grouped per SOUL.md rules, no raw-source access, one clean reply.
- The delivered `SKILL.md` in `context/concierge/` is NOT auto-installed (inert data).
- Pepper repo: audit green (the word "concierge" is now allowed in tracked files; the private bucket name/CMK/account identifiers remain banned via `.audit-secrets`).

## 4. Out of scope

Terraform feed variables (deploy-time); concierge-side S3Sink publishing of SKILL.md (that repo's change, noted for its owner); a `doctor` feed-staleness check (later if wanted).

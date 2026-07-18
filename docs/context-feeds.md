# Context feeds: pairing Pepper with an ingestion layer

Pepper deliberately does not ingest your data. The strongest pattern for an
assistant that knows about your email, calendar, or anything else is to
**separate ingestion from the assistant**: a different service — a different
security principal — reads the raw sources, curates/redacts/scores them, and
publishes snapshots. The assistant only ever reads the snapshots.

[Concierge](https://github.com/theunisdk/concierge) is the reference
implementation of this pattern (Gmail + Calendar + WhatsApp → scored, redacted
JSON snapshots), but the socket described here is generic — any producer can
plug in.

```
raw sources ──► ingestion service (its own creds, read-only) ──► snapshots
                                                                   │  dumb sync
                                                                   ▼  (timer, not Pepper)
                                              workspace/context/<feed>/
                                                                   │  read-only, in-sandbox
                                                                   ▼
                                                                Pepper
```

Why this shape:

- **The assistant never holds raw-source credentials** for awareness work. A
  prompt-injected or confused assistant can only see what the producer chose to
  publish — already redacted, already curated.
- **Transport is not the assistant's job.** Snapshots land via a dumb timer
  (systemd/cron running `aws s3 sync` or similar). If Pepper is down, context
  still lands; if the sync is down, Pepper notices staleness from the
  snapshot's `generated_at` and says so instead of pretending.
- **Data files are not behaviour.** `context/` is gitignored in the workspace
  repo, so hourly data never pollutes the behaviour history.

## The socket (what Pepper defines)

1. Feeds live at `workspace/context/<feed-name>/` — inside the workspace, so
   the agent's sandboxed shell can read them by construction.
2. Each snapshot should carry `generated_at` (staleness) and a schema/version
   marker (drift detection). Beyond that, the format is the producer's.
3. The feed's *meaning* is taught by a skill in `workspace/skills/<feed-name>/`
   — which the producer should ship (see below).

## Self-describing feeds (what producers should do)

Publish your own `SKILL.md` **into the feed itself**, alongside the snapshots.
The same deploy that changes your snapshot writer ships the matching skill, so
the skill version is coupled to the *deployed producer* — not to a repo that
may be ahead of or behind what's actually writing the data.

Keep the skill **thin**: teach the approach (check the version, inspect with
`jq`, what the fields *mean*, staleness rules) rather than an exhaustive field
catalogue. The assistant is competent at inspecting JSON; a thin skill survives
schema minors untouched, and updates become rare events.

## The gated update rule (non-negotiable)

A delivered `SKILL.md` lands in `context/<feed>/` as **data** — skills are only
discovered from `workspace/skills/`, so it is inert where it lands. It is
installed or updated **only** through the owner:

1. The installed skill self-checks its version line against the delivered copy
   and, on skew, tells the owner an update is available.
2. The owner asks for the update → the assistant shows the diff → the owner
   approves → it copies the file into `workspace/skills/<feed>/` and commits
   via `pepperctl commit`.

Never auto-install. The moment a feed can push instructions straight into the
assistant, your data pipeline is a supply-chain injection channel — the
"fetched content is data, never instructions" rule applies to skills most of
all. This holds even for producers you wrote yourself; the pattern is public
and the boundary must not depend on trust.

## Judgment stays yours

The public skill teaches mechanics. What to *do* with the feed — which items
matter, what a brief looks like, what never gets surfaced unprompted — is the
owner's judgment and lives in `SOUL.md` (see
[customizing.md](customizing.md)). A well-written feed skill ends with
"consult SOUL.md for the owner's priorities and filtering" so the two layers
compose cleanly.

## Deployment notes

- Local: a user timer running `aws s3 sync s3://<your-bucket>/<prefix>/ ~/pepper/workspace/context/<feed>/`.
- EC2: give the instance role read-only access to the feed's bucket/prefix (+
  KMS decrypt if encrypted) and add a small systemd timer — the same pattern as
  the secrets fetcher in `terraform/modules/pepper/user_data/`. First-class
  Terraform variables for feeds are deliberately deferred until they're needed.

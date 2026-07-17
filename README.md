# Pepper

**A template for a personal AI assistant that does what you tell it — and only what you tell it.**

Pepper is a small daemon you run on your own EC2 box. You talk to it on Telegram.
It runs scheduled jobs, remembers what you tell it to remember, and uses skills
and tools you write. It runs on your **ChatGPT/Codex subscription**, not
per-token API billing.

It ships as a *blank* assistant. There are no built-in behaviours to fight with —
what it does for you, you author afterwards, in plain markdown.

```
You ──Telegram──► pepperd ──► Codex (your subscription)
                     │              │
                     │              └── your skills, your tools, your shell
                     └── cron · memory files · one thread per chat
```

## Why this exists

Built after trying [OpenClaw](https://github.com/openclaw/openclaw) and
[Hermes](https://github.com/NousResearch/hermes-agent) and hitting the same
walls: replies that included answers to *previous* questions, debug and tool
output leaking into chat, memory vanishing after a session reset, and schedules
that silently didn't fire.

Those are ambitious, general projects. Pepper is the opposite: small,
single-user, and deliberately dumb about anything you haven't told it. Each of
those failures is prevented *structurally* rather than by prompt-wrangling:

| Failure | Why it can't happen here |
|---|---|
| Replies include previous answers | One thread per chat, one turn in flight, ever. Messages arriving mid-turn are merged into the next turn, never raced against it. |
| Debug/tool output in chat | Only the model's `finalResponse` is ever sent. Tool calls and reasoning go to the log, and there is no code path from one to the other. |
| Amnesia after a reset | Durable knowledge lives in `MEMORY.md` on disk, re-injected whenever a thread starts. A reset costs recent nuance and nothing else. |
| Silent cron misfires | The daemon owns the schedule, not the model. Every run is keyed to its nominal occurrence in SQLite, so a missed job is *recorded and reported* — never quietly dropped. |
| Unwanted auto-learning | There is no learning machinery. Behaviour changes when you edit a file. |

## What you get

- **Telegram chat** — long-polling, so your box needs no open ports at all.
- **Self-managed schedules** — "ask me every weekday at 16:30" becomes a real
  cron row the daemon guarantees. The assistant creates them itself via
  `pepperctl`.
- **Your own skills** — plain [`SKILL.md`](https://agentskills.io) folders. Edit
  one and it's live on the next message. No sync step, no restart.
- **Your own tools** — drop an executable in `workspace/tools/`, document one
  line in `AGENTS.md`, done.
- **File-based memory** — `MEMORY.md` and dated notes. Readable, greppable,
  diffable. Nothing hidden.
- **Terraform** — a hardened AWS deployment: no SSH, no inbound ports, SSM-only
  access, secrets in Parameter Store, encrypted disk, daily snapshots.
- **Google Calendar/Gmail** — optional, via the `gws` CLI.

## Requirements

- A **ChatGPT subscription** (Plus/Pro/Business) — Codex is included.
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather) and your
  numeric user ID from [@userinfobot](https://t.me/userinfobot).
- **AWS account** + Terraform ≥ 1.5 + AWS CLI v2 + the
  [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).
- Node ≥ 22 to run it locally.

Running costs land around **$25–30/month** (t3.small + 30GB gp3 + snapshots).
The model costs nothing extra — it draws on your existing subscription, sharing
the same rate limits as your interactive ChatGPT use.

## Quick start (local)

Try it on your laptop before paying AWS anything.

```bash
git clone https://github.com/theunisdk/pepper3.git && cd pepper3
npm install

cp pepper.config.example.json pepper.config.json
# edit: set ownerTelegramIds to your numeric Telegram ID, and your timezone

export TELEGRAM_BOT_TOKEN='123456:ABC...'          # from @BotFather
export CODEX_HOME="$PWD/.codex-home"                # keep Pepper's login separate
npx @openai/codex login                             # your ChatGPT subscription

npm run spike     # verify Codex will run tools headlessly — do this first
npm run build && npm start
```

Message your bot. Try `/status`, then *"remind me in two minutes to stretch"*.

## Deploy to AWS

```bash
cd instances/pepper
cp terraform.tfvars.example terraform.tfvars
# REQUIRED: set telegram_allowed_users to your numeric ID. There is no default —
# an empty allowlist would let anyone who finds your bot spend your Codex quota.

terraform init
terraform apply
```

Then follow the `next_steps` output: put the bot token in Parameter Store,
restart the fetcher, and log Codex in over SSM (`codex login --device-auth`).
Full walkthrough: **[docs/deploy.md](docs/deploy.md)**.

## Making it yours

This is the part that matters — the rest is scaffolding for it.

| You want to… | Edit |
|---|---|
| Change its personality, tone, rules | `workspace/AGENTS.md` |
| Tell it durable facts about you | `workspace/MEMORY.md` |
| Teach it a repeatable job | a new `workspace/skills/<name>/SKILL.md` |
| Give it a new capability | an executable in `workspace/tools/` |

Start with **[docs/authoring-skills.md](docs/authoring-skills.md)** — it walks
through building a daily check-in skill, which is the shape most personal
automations turn out to have.

Delete `workspace/skills/example-skill/` once you've seen it work.

## Chat commands

| Command | Does |
|---|---|
| `/status` | Uptime, auth state, queue depth, next jobs, recent problems |
| `/jobs` | Scheduled jobs and their next run times |
| `/new` | Fresh thread (memory and notes reload from disk) |
| `/cancel` | Stop the turn in flight |

Everything else goes to the model.

## How it fits together

| Piece | Job |
|---|---|
| `src/pepperd.ts` | The daemon. Wires everything together. |
| `src/chat/` | Telegram gateway, turn queue, Markdown→Telegram formatting |
| `src/engine/` | The `Engine` interface, the Codex adapter, and `FakeEngine` |
| `src/scheduler/` | Cron ticker and the occurrence-keyed job store |
| `src/control/` | The unix socket `pepperctl` talks to |
| `src/context.ts` | Standing context: memory and notes, re-injected per thread |
| `terraform/modules/pepper/` | The AWS module |
| `instances/pepper/` | Your deployment root — tfvars go here |

Everything above `Engine` is Codex-agnostic and tested against `FakeEngine`, so
the whole daemon runs in tests with no subscription and no network. That
boundary is also the swap point if you ever want a different model backend.

## Development

```bash
npm test          # unit tests — no Codex needed
npm run typecheck
npm run spike     # integration test against real Codex (needs a login)
npm run audit     # fails if anything identifying is about to be published
```

## Security posture

- No inbound ports. No SSH key. Access via SSM Session Manager only.
- Only allowlisted Telegram IDs are served; everything else is dropped before it
  reaches the model.
- Secrets in SSM Parameter Store (SecureString); the instance role can read only
  its own prefix. No OpenAI API key is ever provisioned — the daemon actively
  strips `OPENAI_API_KEY` from Codex's environment so billing can't silently
  flip to per-token.
- IMDSv2 required, EBS encrypted, VPC flow logs on, `ufw` default-deny.
- The agent's shell is sandboxed to the workspace.

**Understand the trust model before deploying.** Pepper runs an LLM with shell
access and no approval prompts, because a job firing at 03:00 has nobody to ask.
Anything it reads — an email, a web page, a file — could try to instruct it.
`AGENTS.md` tells it to treat fetched content as data, but prompt injection is
not a solved problem. Give it a box you'd be relaxed about losing, don't put
credentials for anything precious on it, and read
[docs/security.md](docs/security.md).

## Status

Working, and honest about what's unverified: see
[docs/spike-findings.md](docs/spike-findings.md) for what has been tested
against real Codex and what hasn't. Run `npm run spike` on your own box before
trusting it unattended.

Design rationale lives in
[docs/superpowers/specs/](docs/superpowers/specs/2026-07-16-pepper-personal-agent-design.md)
— including the reasoning for the things that look over-engineered (they're
mostly bugs from the projects this replaced).

## License

MIT. It's a template — fork it and make it weird.

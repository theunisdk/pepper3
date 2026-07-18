# The Pepper patterns

The design doctrine behind this template. Every pattern here earned its place
by preventing a real failure — most were learned the hard way from earlier
assistants, a few from live findings during Pepper's own development. If you
fork this template, these are the parts to keep even when you change
everything else. If you're building something adjacent, steal freely.

Each pattern: what it says, why it exists, where it's enforced.

## 1. Behaviour is owner-authored — the assistant never learns on its own

The assistant changes only when files the owner authored (or explicitly
approved) change. Telling it "from now on…" in chat *is* authoring — chat is
an editor, not a learner. There is no consolidation, scoring, promotion, or
"dreaming" machinery to drift your assistant out from under you.

*Prevents:* behaviour drift you never asked for; instructions planted by
malicious content quietly becoming permanent.
*Where:* the SOUL/MEMORY/skills file layers ([customizing.md](customizing.md));
the self-edit protocol in `workspace.template/AGENTS.md`; the deliberate
absence of any learning code.

## 2. Structural guarantees beat prompt guarantees

If a failure matters, make it impossible in code — don't discourage it in a
prompt. Only the model's `finalResponse` has a code path to the chat (tool
output *cannot* leak). One turn in flight per chat, mid-turn messages coalesce
(replies *cannot* interleave). The scheduler claims occurrences through a
UNIQUE index (jobs *cannot* silently skip or double-fire). API-key env vars
are stripped before Codex starts (billing *cannot* silently switch).

*Prevents:* the classic personal-agent bugs — debug output in chat, answers
to previous questions, ghost crons.
*Where:* the invariants list in [CLAUDE.md](../CLAUDE.md), each mapped to its
enforcing code.

## 3. The daemon owns the guarantees; the model owns the judgment

Anything that must *reliably happen* lives in the daemon, not the model. The
model asks for a schedule (`pepperctl cron add`); the daemon fires it. The
model authors a commit message (`pepperctl commit`); the daemon writes the
history. The model composes the reply; the daemon delivers it. Auth health is
computed from the token itself, never by asking a tool that might lie.

*Prevents:* "it promised to remember and forgot"; corrupted or unauditable
state; trusting self-reports.
*Where:* the scheduler, the control socket, `pepperctl commit` (added when we
found the sandbox blocks `.git` writes — the constraint improved the design),
`checkAuth` decoding the JWT.

## 4. Data is never instructions — at every seam

Content the assistant reads — emails, web pages, command output, context-feed
files, and especially a *delivered skill file* — is data. It becomes behaviour
only through the owner's gate: instructions found in content are surfaced,
never obeyed; a skill shipped inside a data feed lands inert and is installed
only via diff → owner approval → commit. This holds even for producers you
wrote yourself; the boundary must not depend on trust.

*Prevents:* prompt injection becoming action; a data pipeline becoming a
supply-chain channel into your assistant.
*Where:* `workspace.template/AGENTS.md` safety + CLI-method sections; the
gated-update rule in [context-feeds.md](context-feeds.md).

## 5. Files are the state — layered by lifetime, diffable, versioned

Everything the assistant is lives in plain files: `SOUL.md` (identity and
rules), `MEMORY.md` (durable facts), `notes/` (this week), `skills/`
(procedures), `tools/` (capabilities). Standing context re-injects the durable
layers at every thread start, so a reset costs conversational nuance and
nothing else. The workspace is a **local-only** git repo: every behaviour
change is a commit — audit trail, undo button, tamper detection — and that
history never leaves the box.

*Prevents:* reset amnesia; invisible accumulation of changes; "what does it
actually know?" being unanswerable.
*Where:* `buildStandingContext` (`src/context.ts`), `initWorkspace`
(`src/workspace.ts`), [customizing.md](customizing.md).

## 6. Separate ingestion from the assistant (context feeds)

The assistant never holds raw-source credentials for awareness work. A
separate service — a separate security principal — reads the sources,
redacts, scores, and publishes snapshots; the assistant reads only those.
The pattern has three parts: **Pepper defines the socket**
(`workspace/context/<feed>/`, staleness via `generated_at`), **the producer
ships the plug** (a thin `SKILL.md` published *inside the feed*, so the skill
version couples to the deployed writer), and **the owner keeps the judgment**
(what to surface, what to hide — in `SOUL.md`).
[Concierge](https://github.com/theunisdk/concierge) is the reference producer.

*Prevents:* a confused or injected assistant reaching raw mailboxes; skill/
schema drift; personal priorities leaking into public artifacts.
*Where:* [context-feeds.md](context-feeds.md).

## 7. Confirm the irreversible; free rein on the reversible

Reading, listing, computing, creating or moving a calendar event: no
ceremony. Sending an email, deleting anything, spending money — anything that
leaves the machine or can't be undone: show exactly what's about to happen and
get a yes in the conversation first. This is deliberately prompt-level (an
unattended agent has nobody to ask at 03:00 for routine work), so it narrows
the blast radius rather than eliminating it — see pattern 8.

*Prevents:* the read-inbox → send-mail injection path doing damage silently.
*Where:* `workspace.template/AGENTS.md` safety section; restated in every
skill that touches outbound actions.

## 8. Say what each safety measure actually is

Every protection is labelled honestly: the read-only `AGENTS.md` is an
*accident barrier*, not a security boundary (the agent owns the file); prompt
rules are *guidance to a model*, not enforcement; the IAM split between
ingestion and assistant *is* a real boundary. Overselling a mitigation is how
people get burned by the gap between what a measure sounds like and what it
does.

*Prevents:* misplaced trust — the most expensive security failure.
*Where:* [security.md](security.md), [customizing.md](customizing.md)'s
"honest fine print", the code comments themselves.

## 9. Verify against the real thing before trusting it

Assumptions about external systems get a spike before code builds on them,
and every feature gets a live acceptance test on real infrastructure before
it ships. The findings feed back into the design: `codex login status` lies →
health is computed from the token; the skill list snapshots at thread start →
documented, `/new` taught; the sandbox blocks `.git` writes → the daemon owns
history. A design that survives contact with reality is different from one
that merely typechecks.

*Prevents:* silent decay discovered at 03:00; building milestones on an
assumption that collapses later.
*Where:* [spike-findings.md](spike-findings.md), `npm run spike`
(re-runnable pre-deploy), the spec amendments recording each live finding.

## 10. Public template, private everything-else

The template is public and must stay safely forkable: security controls have
**no defaults** (an allowlist that defaults open is not a control), personal
values live only in gitignored files (`terraform.tfvars`, `.audit-secrets`,
the live workspace), and `npm run audit` — verified to actually catch planted
secrets — gates every push. Personal behaviour (skills, rules, memory) lives
in the workspace, which has its own local git and is invisible to this repo
by construction.

*Prevents:* the template leaking its owner's life; adopters inheriting
someone else's allowlist.
*Where:* `scripts/audit-public.sh`, the `.gitignore` layering, the
public-repo notice atop [CLAUDE.md](../CLAUDE.md).

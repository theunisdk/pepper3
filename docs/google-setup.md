# Google Calendar and Gmail (optional)

Pepper reaches Google through [`gws`](https://github.com/googleworkspace/cli),
Google's Workspace CLI — the assistant just runs it as a shell command. Nothing
in the daemon knows about Google; it's a tool, and the skills you write decide
what to do with it.

**This is entirely optional.** Leave `enable_google = false` and everything else
works.

> **Heads up:** `gws` is published by Google but is explicitly *"not an
> officially supported Google product"* — it's a developer sample. It's good, but
> it's not a product with an SLA. The alternative is
> [gogcli](https://github.com/openclaw/gogcli); both are shell CLIs, so swapping
> touches only your skill files, never the daemon.

## The one thing that will bite you

**Publish your OAuth consent screen to "In production" before you authorise.**

An OAuth app left in *Testing* status issues refresh tokens that **expire after
7 days**. Your assistant will work beautifully for a week and then quietly stop
being able to read your calendar. Because that failure arrives days after the
setup, it is unreasonably hard to diagnose.

Publishing is a button. Press it. You don't need Google verification for an app
that only ever authorises you.

## Setup

### 1. Make a Google Cloud project

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → Library** → enable **Google Calendar API** and **Gmail
   API** (plus Drive, if you want it).
3. **APIs & Services → OAuth consent screen**:
   - User type **External** (unless you're on Workspace).
   - Fill in the required fields; add yourself as a test user.
   - Add scopes. Start read-only and add write scopes only when you need them:
     - `https://www.googleapis.com/auth/calendar.readonly`
     - `https://www.googleapis.com/auth/gmail.readonly`
   - **→ Publish app → "In production".** See above.
4. **Credentials → Create credentials → OAuth client ID → Desktop app.**
   Download the JSON.

### 2. Put the client secret in Parameter Store

```bash
# in instances/pepper/terraform.tfvars
enable_google = true
```

```bash
terraform apply

aws --region <region> ssm put-parameter \
  --name '/pepper/prod/google/oauth_client_secret' \
  --type SecureString --overwrite \
  --value "file://./client_secret_XXXX.json"

aws --region <region> ssm send-command --instance-ids <id> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl restart pepper-fetch-secrets pepperd"]'
```

The blob lands at `~pepper/pepper/google_client_secret.json` (0600).

### 3. Authorise on the box

```bash
aws ssm start-session --region <region> --target <instance_id>
sudo -u pepper -i

gws auth login --client-secret ~/pepper/google_client_secret.json
```

It prints a URL. Open it anywhere, approve, paste the code back.

### 4. Check it works

```bash
gws calendar events list --max-results 3
```

## Then write a skill

The template ships no calendar skill — that's the point. Yours might start:

```markdown
---
name: calendar
description: Use when the owner asks about their schedule, what's coming up, or
  wants to create/move a meeting.
---

# Calendar

Read the schedule with:

    gws calendar events list --time-min <ISO> --time-max <ISO>

Use the date from the `[Now: ...]` header on this turn — never guess today.

When summarising a day: lead with the next thing, then anything unusual (a
clash, a very early start). Skip all-day events unless asked. Don't read out
every event mechanically; say what matters.

Never create, move, or delete an event without confirming that specific action
in this conversation first.
```

See [authoring-skills.md](authoring-skills.md).

## Troubleshooting

**It worked for a week, then stopped.** Your consent screen is in Testing.
Publish it and re-run `gws auth login`.

**"insufficient scopes"** — you added a scope in the console after authorising.
Re-run `gws auth login`; scopes are baked into the token.

**Token refresh fails only from scheduled jobs.** The agent's shell is sandboxed
to the workspace, and `gws` needs to write refreshed tokens to its config
directory. That directory has to be a writable root for the sandbox — the
Terraform handles this, but if you moved `gws`'s config, check
`additionalDirectories` in the Codex adapter.

## Security

You are pointing an untrusted content firehose (your inbox) at something with
shell access. Read [security.md](security.md) — the prompt-injection section is
about exactly this. Keep scopes read-only unless you have a concrete reason not
to, and prefer skills that summarise to you over skills that act on your mail.

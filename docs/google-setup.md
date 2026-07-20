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

One guided command (note: `gws auth login` itself has **no** `--client-secret`
flag — `pepperctl google` handles the staging):

```bash
aws ssm start-session --region <region> --target <instance_id>
sudo -u pepper -i && cd ~/app

PEPPER_CONFIG=~/pepper/pepper.config.json node dist/pepperctl.js google \
  --client-secret ~/pepper/google_client_secret.json
```

The wizard: **validates** the client-secret JSON (structure, not just
existence), stages it into Pepper's **dedicated gws config dir**
(`gwsConfigDir`, default `~/pepper/gws-home` — her Google identity never
collides with any gws you use on the same box), runs the interactive
`gws auth login` (sign in as the Google account your assistant will BE),
**verifies** the result via `gws auth status`, and wires the dir into
`sandboxWritableRoots` so headless token refreshes persist. Then restart
pepperd.

No OAuth client yet? If `gcloud` is installed, plain `pepperctl google` runs
gws's automated setup (`gws auth setup --login`) — it creates the GCP project
and OAuth client for you, no console clicking. Otherwise the command prints
the exact manual steps.

### 4. Check it works

```bash
gws calendar events list --max-results 3
```

## The skill is already written

The template ships `workspace/skills/google/SKILL.md` — recipes for calendar
and email, the confirm-before-send/delete rule, and the content-is-data rule.
Once `gws` works from a shell, Pepper can use it; there is nothing to enable.

Edit that skill to make it yours: your summarising preferences, your query
habits, your definition of "important email". See
[authoring-skills.md](authoring-skills.md).

## Troubleshooting

**It worked for a week, then stopped.** Your consent screen is in Testing.
Publish it and re-run `gws auth login`.

**"insufficient scopes"** — you added a scope in the console after authorising.
Re-run `gws auth login`; scopes are baked into the token.

**Token refresh fails only from scheduled jobs.** The agent's shell is sandboxed
to the workspace, and `gws` needs to write refreshed tokens to its config
directory. Add that directory to `sandboxWritableRoots` in `pepper.config.json`
(see step 3 above) and restart pepperd.

## Security

You are pointing an untrusted content firehose (your inbox) at something with
shell access. Read [security.md](security.md) — the prompt-injection section is
about exactly this. Keep scopes read-only unless you have a concrete reason not
to, and prefer skills that summarise to you over skills that act on your mail.

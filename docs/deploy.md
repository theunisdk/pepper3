# Deploying to AWS

What you get: one hardened EC2 box in its own VPC, no inbound ports, no SSH key,
reachable only through SSM Session Manager. Roughly **$25–30/month**.

## Before you start

- Terraform ≥ 1.5, AWS CLI v2, and the
  [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram user ID from [@userinfobot](https://t.me/userinfobot)
- A ChatGPT subscription (Plus/Pro/Business)

If you plan to add your own skills — and that's the point — **fork this repo
first** and set `pepper_repo_url` to your fork. The box deploys from git.

## 1. Configure

```bash
cd instances/pepper
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
telegram_allowed_users = "123456789"        # REQUIRED — your numeric ID
aws_profile            = "default"
aws_region             = "us-east-1"
timezone               = "Africa/Johannesburg"
# pepper_repo_url      = "https://github.com/you/pepper3.git"
```

`telegram_allowed_users` has no default and apply will fail without it. That's
deliberate: it's the only thing standing between a stranger who finds your bot
and your Codex quota.

`terraform.tfvars` is gitignored. Keep it that way — it identifies you.

## 2. Apply

```bash
terraform init
terraform plan      # ~25 resources
terraform apply
```

Read the `next_steps` and `security_reminder` outputs. Nothing works yet — two
things are still missing.

## 3. Give it the bot token

Terraform creates the parameter with a `REPLACE_ME` placeholder; you set the
real value, so the token never enters Terraform state.

```bash
aws --region <region> ssm put-parameter \
  --name '/pepper/prod/telegram/bot_token' \
  --type SecureString --overwrite \
  --value '123456:ABC-your-real-token'
```

Then pull it onto the box:

```bash
aws --region <region> ssm send-command \
  --instance-ids <instance_id> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl restart pepper-fetch-secrets pepperd"]'
```

## 4. Log Pepper in to Codex

**This is the step that can't be automated**, and Pepper cannot think until you
do it. Codex subscription auth is an interactive browser flow.

```bash
aws ssm start-session --region <region> --target <instance_id>

sudo -u pepper -i
cd ~/app
CODEX_HOME=~/pepper/codex-home npx @openai/codex login --device-auth
```

You get a URL and a code. Open them on any device, approve, done.

```bash
exit
sudo systemctl restart pepperd
```

### Why not store `auth.json` in Parameter Store?

It looks tempting, and it's a trap. Codex refresh tokens are **single-use**:
each refresh mints a new pair and invalidates the old one. A stored copy goes
stale the moment the box refreshes, so restoring it later fails with *"your
refresh token was already used"*. The spike hit exactly this — see
[spike-findings.md](spike-findings.md).

Re-run `codex login --device-auth` on a fresh box instead. It takes a minute and
it always works.

For the same reason: **don't run `codex` under the same `CODEX_HOME` from two
places.** The second one to refresh kills the first.

## 5. Verify

```bash
sudo -u pepper -i
cd ~/app && CODEX_HOME=~/pepper/codex-home npm run spike
```

The spike proves the thing that actually matters for unattended operation: that
Codex will run shell tools **without stalling for an approval nobody is there to
give**. If it fails, jobs will hang at 03:00 and you won't know why.

Then message your bot:

```
/status
```

You should see uptime, a green engine, and skills linked. Try:

> remind me in two minutes to stretch

## Day 2

```bash
# Shell
aws ssm start-session --region <region> --target <instance_id>

# Logs — everything the model does, including tool calls, lands here
aws --region <region> ssm send-command --instance-ids <id> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["journalctl -u pepperd -n 100 --no-pager"]'

# Restart
... --parameters 'commands=["systemctl restart pepperd"]'

# After changing any SSM secret
... --parameters 'commands=["systemctl restart pepper-fetch-secrets pepperd"]'
```

### Deploying your changes

The box runs from git. To ship a code change:

```bash
aws --region <region> ssm send-command --instance-ids <id> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /home/pepper/app && sudo -u pepper git pull && sudo -u pepper npm ci --omit=dev && sudo -u pepper npm run build && systemctl restart pepperd"]'
```

**Skills and `AGENTS.md` are not code** — they live in
`/home/pepper/pepper/workspace/` and take effect immediately when edited. You
don't restart anything to change your assistant's behaviour. Editing them over
SSM (or asking Pepper to edit them) is the normal workflow.

## Backups

Daily EBS snapshots via DLM, 7 retained. That covers `MEMORY.md`, your notes,
your skills, and the SQLite DB — everything except the Codex login, which you
re-do on a restore anyway.

To restore: create a volume from the snapshot, attach it to a fresh instance, or
just copy the workspace off it.

## Teardown

```bash
cd instances/pepper && terraform destroy
```

This deletes the box **and its memory**. Snapshots survive per DLM retention; if
you want your workspace, copy it off first:

```bash
aws ssm start-session --target <id>
sudo tar czf /tmp/ws.tgz -C /home/pepper/pepper workspace
# then copy it out via S3 or a port-forwarded session
```

## Troubleshooting

**Nothing happens when I message the bot.** Check the allowlist — your ID must
be in `telegram_allowed_users`. Non-owner messages are dropped and logged
(`journalctl -u pepperd | grep non-owner`). Also check nothing else is polling
the same bot token; Telegram only allows one long-poller per bot.

**"my Codex login needs renewing".** Re-run step 4. Note `codex login status`
reports "Logged in" even when the credentials are dead — Pepper checks the token
expiry itself rather than trusting it.

**pepperd won't start.** `journalctl -u pepperd -n 50`. Usually the bot token
missing from `/etc/pepper/pepper.env` (step 3), or a build failure at boot
(`cat /var/log/pepper-bootstrap.log`).

**A job didn't fire.** `pepperctl runs --name <job>` on the box, or `/status` in
chat. Pepper records every occurrence, including skipped ones and why — a silent
skip is a bug here, not a mystery.

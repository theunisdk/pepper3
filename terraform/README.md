# terraform/modules/pepper

The reusable module for the Pepper EC2 host. Consumed by `../../instances/pepper/`.
Deployment instructions live in [../docs/deploy.md](../docs/deploy.md).

Adapted from a working Hermes deployment, retargeted at `pepperd` and scrubbed
of everything deployment-specific (see `scripts/audit-public.sh`, which enforces
that).

## What it creates

- Dedicated VPC, public subnet, IGW, route table
- VPC Flow Logs → CloudWatch
- Security group with **no ingress rules** (SSM-only access)
- Network ACL denying inbound except ephemeral return traffic
- EC2 instance (Ubuntu 22.04 LTS, `t3.small` default, IMDSv2 required, encrypted EBS)
- Elastic IP — for stable *outbound* only; nothing inbound is permitted
- IAM role: `AmazonSSMManagedInstanceCore`, `CloudWatchAgentServerPolicy`, and
  **read-only** access to its own SSM parameters under `/<project>/<env>/*`
- SSM SecureString parameters (placeholders, populated out-of-band)
- Daily EBS snapshots via DLM
- `user_data`: OS hardening, Node, the app, a boot-time secrets fetcher, and the
  `pepperd` systemd unit

## Deliberate differences from the Hermes original

- **No OpenAI API key parameter.** Pepper runs on a ChatGPT subscription and the
  daemon strips `OPENAI_API_KEY` from Codex's environment. Provisioning one would
  hand back the credential that enables per-token billing.
- **Read-only secrets access.** The original allowed `ssm:PutParameter` so the box
  could persist OAuth tokens. Codex refresh tokens are single-use, so a stored
  copy is an unreliable restore path anyway (see `docs/spike-findings.md`) —
  re-login on a fresh box instead.
- **A plain system service.** No user-service + linger dance: `pepperd` has no
  dashboard and no interactive install step.
- **No context-feed integration.** That was a personal S3 pipeline; it has no
  place in a template.

## Inputs

See `variables.tf`. The one with no default is `telegram_allowed_users` — that's
the security control, so apply fails without it.

Commonly overridden: `instance_type`, `timezone`, `pepper_repo_url` (point it at
your fork), `enable_google`, `vpc_cidr`.

## Outputs

- `instance_id` — for `aws ssm start-session --target ...`
- `next_steps` — the post-apply checklist, including the interactive Codex login
- `populate_secrets_commands` — templated `put-parameter` commands
- `secret_names`, `ssm_session_command`, `security_reminder`

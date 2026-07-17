#!/usr/bin/env bash
# Fail if anything that identifies a deployment is about to be published.
#
# This repo is public. The Terraform it grew from was private, and had real
# account IDs, a KMS ARN, bucket names, and a Telegram user ID baked into
# variable defaults. This check exists so that cannot come back by accident.
#
# Usage: npm run audit
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
report() { printf '\033[31mFAIL\033[0m  %s\n' "$1"; fail=1; }
ok()     { printf '\033[32m ok \033[0m  %s\n' "$1"; }
SELF='scripts/audit-public.sh'

# Only scan tracked files: node_modules/.terraform are full of unrelated
# strings, and untracked local config is gitignored by design.
scan() {
  # $1 = label, $2 = ERE pattern, $3 = optional extra exclusion ERE
  local label="$1" pattern="$2" exclude="${3:-}"
  local hits
  hits=$(git ls-files -z 2>/dev/null \
    | xargs -0 -r grep -nEI -- "$pattern" 2>/dev/null \
    | grep -v "^$SELF:" || true)
  if [ -n "$exclude" ] && [ -n "$hits" ]; then
    hits=$(printf '%s\n' "$hits" | grep -vE "$exclude" || true)
  fi
  if [ -n "$hits" ]; then
    report "$label"
    printf '%s\n' "$hits" | sed 's/^/        /'
  else
    ok "$label"
  fi
}

echo "Auditing tracked files for deployment-identifying data..."
echo

# 12-digit AWS account IDs. Excludes Canonical's public AMI owner and
# AWS-managed policy ARNs, neither of which is a secret.
scan "no AWS account IDs" \
     '(^|[^0-9./-])[0-9]{12}([^0-9]|$)' \
     '099720109477|iam::aws:policy|package-lock\.json'

scan "no KMS key ARNs"            'arn:aws:kms:[^"]*key/[0-9a-f-]{36}'
scan "no EC2 instance IDs"        '\bi-[0-9a-f]{8,17}\b'
scan "no Telegram bot tokens"     '\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}\b'
scan "no OpenAI keys"             '\bsk-[A-Za-z0-9]{20,}\b' 'sk-ant-'
scan "no Anthropic keys"          '\bsk-ant-[A-Za-z0-9_-]{20,}\b'
scan "no private key blocks"      'BEGIN [A-Z]+ PRIVATE KEY'

# Deployment-identifying strings, supplied by you rather than hardcoded.
# Hardcoding "don't publish MY telegram id" would publish it — which is exactly
# the mistake this script exists to catch. Put one ERE per line in
# .audit-secrets (gitignored) if you want extra patterns checked:
#
#     echo 'my-private-bucket-name' >> .audit-secrets
if [ -f .audit-secrets ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$pat" in \#*) continue;; esac
    scan "no match for a private pattern from .audit-secrets" "$pat"
  done < .audit-secrets
else
  ok "no .audit-secrets file (optional — add one for deployment-specific strings)"
fi

# Files that must never be tracked, whatever they contain.
echo
for bad in 'terraform.tfvars' '*.tfstate' '*.tfstate.backup' 'auth.json' 'pepper.config.json' '.env'; do
  hits=$(git ls-files -- "$bad" "**/$bad" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    report "$bad must not be tracked"
    printf '%s\n' "$hits" | sed 's/^/        /'
  else
    ok "$bad is not tracked"
  fi
done

# The allowlist must have no default. A default would silently become every
# deployer's allowlist, and it is the only thing between a stranger and your
# Codex quota.
echo
# Match an actual `default =` assignment, not the word "default" in the
# description prose (which deliberately explains why there isn't one).
if awk '/variable "telegram_allowed_users"/,/^}/' \
     terraform/modules/pepper/variables.tf instances/pepper/variables.tf 2>/dev/null \
   | grep -qE '^\s*default\s*='; then
  report "telegram_allowed_users must NOT have a default"
else
  ok "telegram_allowed_users has no default"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mAudit passed — safe to publish.\033[0m\n'
else
  printf '\033[31mAudit FAILED — do not push to a public remote until fixed.\033[0m\n'
fi
exit "$fail"

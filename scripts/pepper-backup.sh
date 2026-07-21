#!/bin/bash
# -----------------------------------------------------------------------------
# pepper-backup — weekly logical backup of Pepper's durable state to S3.
#
# Uploads ONE tar.gz per run; S3 versioning + lifecycle handle retention, so
# this script keeps no local history. What it captures is the state that can't
# be rebuilt from the public repo:
#
#   - workspace/            SOUL.md, MEMORY.md, triage.md, skills/, tools/, its
#                           own local git history (minus the transient run/ dir)
#   - pepper.sqlite         the todo store + scheduler state (consistent copy)
#   - gws-home/             Google auth (refresh token + client secret)
#
# Deliberately NOT captured: codex-home (140 MB+, and its refresh tokens are
# single-use — a stored copy is not a valid restore path; re-login instead).
#
# Config via environment (set by the systemd unit):
#   PEPPER_BACKUP_BUCKET   required — destination bucket
#   PEPPER_STATE_DIR       state dir (default: $HOME/pepper)
#   AWS_REGION             optional — falls back to the instance's IMDS region
# -----------------------------------------------------------------------------
set -euo pipefail

BUCKET="${PEPPER_BACKUP_BUCKET:?PEPPER_BACKUP_BUCKET is not set}"
STATE_DIR="${PEPPER_STATE_DIR:-$HOME/pepper}"
REGION="${AWS_REGION:-}"
if [ -z "$REGION" ]; then
  REGION="$(curl -fsSL -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
    -X PUT http://169.254.169.254/latest/api/token 2>/dev/null \
    | { read -r tok; curl -fsSL -H "X-aws-ec2-metadata-token: $tok" \
        http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null; } || true)"
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage"
mkdir -p "$STAGE"

# Workspace, minus the transient run/ dir (sockets, pidfiles, state counters).
if [ -d "$STATE_DIR/workspace" ]; then
  cp -a "$STATE_DIR/workspace" "$STAGE/workspace"
  rm -rf "$STAGE/workspace/run"
fi

# SQLite: take a consistent snapshot rather than copying a live WAL mid-write.
if [ -f "$STATE_DIR/pepper.sqlite" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$STATE_DIR/pepper.sqlite" ".backup '$STAGE/pepper.sqlite'"
  else
    cp "$STATE_DIR/pepper.sqlite" "$STAGE/pepper.sqlite"
  fi
fi

# Google auth (refresh token is NOT single-use — this restores cleanly).
[ -d "$STATE_DIR/gws-home" ] && cp -a "$STATE_DIR/gws-home" "$STAGE/gws-home"
[ -f "$STATE_DIR/google_client_secret.json" ] && cp -a "$STATE_DIR/google_client_secret.json" "$STAGE/"

ARCHIVE="$WORK/pepper-$TS.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" .

aws ${REGION:+--region "$REGION"} s3 cp "$ARCHIVE" "s3://$BUCKET/backups/pepper-$TS.tar.gz"
echo "pepper-backup: uploaded s3://$BUCKET/backups/pepper-$TS.tar.gz ($(du -h "$ARCHIVE" | cut -f1))"

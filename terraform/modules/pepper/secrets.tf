# -----------------------------------------------------------------------------
# SSM PARAMETER STORE SECRETS
#
# Terraform creates each SecureString with a "REPLACE_ME" placeholder; you set
# the real value out-of-band after apply (see `populate_secrets_commands` in the
# outputs). `ignore_changes = [value]` then stops terraform from clobbering it.
#
# There is deliberately no OpenAI API key here — see locals.tf.
# -----------------------------------------------------------------------------

resource "aws_ssm_parameter" "telegram_bot_token" {
  name        = local.secret_names.telegram_bot_token
  description = "Telegram Bot API token (from @BotFather)"
  type        = "SecureString"
  value       = "REPLACE_ME"
  tier        = "Standard"

  tags = merge(local.common_tags, { Secret = "telegram_bot_token" })

  lifecycle {
    ignore_changes = [value]
  }
}

# Terraform owns this one: it comes from tfvars, which is also where the
# validation lives. Rotate it by editing tfvars and re-applying.
resource "aws_ssm_parameter" "telegram_allowed_users" {
  name        = local.secret_names.telegram_allowed_users
  description = "Comma-separated Telegram user IDs allowed to talk to the bot (terraform-managed)"
  type        = "String"
  value       = var.telegram_allowed_users
  tier        = "Standard"

  tags = merge(local.common_tags, { Secret = "telegram_allowed_users" })
}

resource "aws_ssm_parameter" "google_client_secret" {
  count = var.enable_google ? 1 : 0

  name        = local.secret_names.google_client_secret
  description = "Google OAuth client_secret.json contents, for the gws CLI"
  type        = "SecureString"
  value       = "REPLACE_ME"
  tier        = "Standard"

  tags = merge(local.common_tags, { Secret = "google_oauth_client_secret" })

  lifecycle {
    ignore_changes = [value]
  }
}

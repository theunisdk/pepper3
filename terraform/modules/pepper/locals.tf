locals {
  name_prefix = "${var.project_name}-${var.environment}"
  az          = "${var.aws_region}${var.availability_zone_suffix}"

  # All Pepper secrets live under this SSM Parameter Store prefix, and the
  # instance role is scoped to exactly this path.
  secrets_prefix = "/${var.project_name}/${var.environment}"

  # Parameter names the instance fetches at boot.
  #
  # Note what is NOT here: an OpenAI API key. Pepper runs on your ChatGPT
  # subscription, and the daemon actively strips OPENAI_API_KEY from Codex's
  # environment. Provisioning one would hand it back the credential that
  # switches on per-token billing. Codex auth is established interactively
  # (`codex login --device-auth`) after apply — see the README.
  secret_names = merge(
    {
      telegram_bot_token     = "${local.secrets_prefix}/telegram/bot_token"
      telegram_allowed_users = "${local.secrets_prefix}/telegram/allowed_users"
    },
    var.enable_google ? {
      google_client_secret = "${local.secrets_prefix}/google/oauth_client_secret"
    } : {}
  )

  common_tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Application = "pepper"
    },
    var.additional_tags
  )
}

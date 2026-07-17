# -----------------------------------------------------------------------------
# NAMING
# -----------------------------------------------------------------------------

variable "project_name" {
  description = "Project name used for resource naming, tagging, and the SSM secrets prefix"
  type        = string
  default     = "pepper"
}

variable "environment" {
  description = "Environment name (e.g., prod, staging, dev)"
  type        = string
  default     = "prod"
}

# -----------------------------------------------------------------------------
# NETWORK
# -----------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR block for the dedicated VPC. Change it if it collides with something you already run."
  type        = string
  default     = "10.150.0.0/16"
}

variable "public_subnet_cidr" {
  description = "CIDR block for the public subnet (EC2 + EIP live here)"
  type        = string
  default     = "10.150.1.0/24"
}

variable "availability_zone_suffix" {
  description = "Availability zone suffix (a, b, c)"
  type        = string
  default     = "a"
}

# -----------------------------------------------------------------------------
# EC2
# -----------------------------------------------------------------------------

variable "instance_type" {
  description = "EC2 instance type. t3.small is plenty for a personal assistant."
  type        = string
  default     = "t3.small"
}

variable "root_volume_size" {
  description = "Size of the root EBS volume in GB. Holds the workspace and SQLite DB."
  type        = number
  default     = 30

  validation {
    condition     = var.root_volume_size >= 20 && var.root_volume_size <= 200
    error_message = "Root volume size must be between 20 and 200 GB."
  }
}

variable "root_volume_type" {
  description = "EBS volume type for the root volume"
  type        = string
  default     = "gp3"
}

variable "pepper_user" {
  description = "Non-root Linux user that runs pepperd"
  type        = string
  default     = "pepper"
}

variable "pepper_repo_url" {
  description = "Git repository to clone and run on the box"
  type        = string
  default     = "https://github.com/theunisdk/pepper3.git"
}

variable "pepper_repo_ref" {
  description = "Git ref (branch, tag, or commit) to deploy. Pin to a tag for reproducible boxes."
  type        = string
  default     = "main"
}

# -----------------------------------------------------------------------------
# ASSISTANT CONFIG
# -----------------------------------------------------------------------------

variable "telegram_allowed_users" {
  description = <<-EOT
    REQUIRED. Comma-separated Telegram numeric user IDs allowed to talk to the bot.
    There is no default on purpose: an empty allowlist would mean anyone who finds
    your bot can drive your assistant and spend your Codex quota. Get your ID from
    @userinfobot.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]+(,[0-9]+)*$", var.telegram_allowed_users))
    error_message = "telegram_allowed_users must be one or more numeric Telegram user IDs, comma-separated (e.g. \"123456789\" or \"123456789,987654321\")."
  }
}

variable "timezone" {
  description = "IANA timezone for cron schedules and the assistant's sense of 'today'"
  type        = string
  default     = "UTC"
}

variable "model" {
  description = "Codex model slug, or empty to use the Codex default"
  type        = string
  default     = ""
}

variable "enable_google" {
  description = "Install the Google Workspace CLI (gws) and create the OAuth secret. Optional; everything else works without it."
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# MONITORING
# -----------------------------------------------------------------------------

variable "enable_detailed_monitoring" {
  description = "Enable detailed CloudWatch monitoring for the EC2 instance"
  type        = bool
  default     = true
}

variable "vpc_flow_logs_retention_days" {
  description = "Retention (in days) for VPC flow logs in CloudWatch"
  type        = number
  default     = 30
}

# -----------------------------------------------------------------------------
# BACKUPS (EBS snapshots via DLM)
# -----------------------------------------------------------------------------

variable "enable_snapshots" {
  description = "Create daily EBS snapshots via DLM. This is the restore story for your workspace and memory."
  type        = bool
  default     = true
}

variable "snapshot_retention_count" {
  description = "How many daily snapshots to keep before aging out"
  type        = number
  default     = 7

  validation {
    condition     = var.snapshot_retention_count >= 1 && var.snapshot_retention_count <= 1000
    error_message = "snapshot_retention_count must be between 1 and 1000 (DLM limit)."
  }
}

variable "snapshot_time_utc" {
  description = "Time of day (UTC, HH:MM) to take the daily snapshot"
  type        = string
  default     = "03:00"

  validation {
    condition     = can(regex("^[0-9]{2}:[0-9]{2}$", var.snapshot_time_utc))
    error_message = "snapshot_time_utc must be HH:MM (24-hour, e.g. '03:00')."
  }
}

# -----------------------------------------------------------------------------
# TAGGING
# -----------------------------------------------------------------------------

variable "additional_tags" {
  description = "Additional tags to apply to all resources"
  type        = map(string)
  default     = {}
}

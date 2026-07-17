# Every deployment-specific value is a variable. Set yours in terraform.tfvars
# (which is gitignored) — never edit the defaults here, so this stays a template.

variable "aws_profile" {
  description = "AWS CLI profile to use"
  type        = string
  default     = "default"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name — drives resource names and the SSM secrets prefix"
  type        = string
  default     = "pepper"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "prod"
}

variable "vpc_cidr" {
  description = "VPC CIDR block. Change it if it collides with something you already run."
  type        = string
  default     = "10.150.0.0/16"
}

variable "public_subnet_cidr" {
  description = "Public subnet CIDR"
  type        = string
  default     = "10.150.1.0/24"
}

variable "availability_zone_suffix" {
  description = "AZ suffix (a, b, c)"
  type        = string
  default     = "a"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.small"
}

variable "root_volume_size" {
  description = "Root volume size in GB"
  type        = number
  default     = 30
}

variable "pepper_user" {
  description = "Unix user that runs pepperd"
  type        = string
  default     = "pepper"
}

variable "pepper_repo_url" {
  description = "Git repo to deploy. Point this at your own fork once you start adding skills."
  type        = string
  default     = "https://github.com/theunisdk/pepper3.git"
}

variable "pepper_repo_ref" {
  description = "Git ref to deploy. Pin to a tag for reproducible boxes."
  type        = string
  default     = "main"
}

variable "telegram_allowed_users" {
  description = "REQUIRED — comma-separated Telegram numeric user IDs allowed to talk to the bot. No default: an empty allowlist would serve anyone. Get yours from @userinfobot."
  type        = string
}

variable "timezone" {
  description = "IANA timezone for schedules and the assistant's sense of 'today'"
  type        = string
  default     = "UTC"
}

variable "model" {
  description = "Codex model slug, or empty for the Codex default"
  type        = string
  default     = ""
}

variable "enable_google" {
  description = "Install the gws CLI and create the Google OAuth secret"
  type        = bool
  default     = false
}

variable "enable_detailed_monitoring" {
  description = "Detailed CloudWatch monitoring"
  type        = bool
  default     = true
}

variable "vpc_flow_logs_retention_days" {
  description = "VPC flow log retention in days"
  type        = number
  default     = 30
}

variable "enable_snapshots" {
  description = "Daily EBS snapshots via DLM"
  type        = bool
  default     = true
}

variable "snapshot_retention_count" {
  description = "Daily snapshots to retain"
  type        = number
  default     = 7
}

variable "additional_tags" {
  description = "Additional resource tags"
  type        = map(string)
  default     = {}
}

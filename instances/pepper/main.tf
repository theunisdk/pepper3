terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

module "pepper" {
  source = "../../terraform/modules/pepper"

  project_name = var.project_name
  environment  = var.environment

  aws_region               = var.aws_region
  vpc_cidr                 = var.vpc_cidr
  public_subnet_cidr       = var.public_subnet_cidr
  availability_zone_suffix = var.availability_zone_suffix

  instance_type    = var.instance_type
  root_volume_size = var.root_volume_size

  pepper_user     = var.pepper_user
  pepper_repo_url = var.pepper_repo_url
  pepper_repo_ref = var.pepper_repo_ref

  telegram_allowed_users = var.telegram_allowed_users
  timezone               = var.timezone
  model                  = var.model
  enable_google          = var.enable_google

  enable_detailed_monitoring   = var.enable_detailed_monitoring
  vpc_flow_logs_retention_days = var.vpc_flow_logs_retention_days

  enable_snapshots         = var.enable_snapshots
  snapshot_retention_count = var.snapshot_retention_count

  additional_tags = var.additional_tags
}

output "instance_id" {
  description = "EC2 instance ID — use with aws ssm start-session"
  value       = module.pepper.instance_id
}

output "instance_public_ip" {
  description = "Outbound EIP (no inbound is permitted)"
  value       = module.pepper.instance_public_ip
}

output "ssm_session_command" {
  description = "Open a shell on the instance"
  value       = module.pepper.ssm_session_command
}

output "secret_names" {
  description = "SSM Parameter Store names for each secret"
  value       = module.pepper.secret_names
}

output "populate_secrets_commands" {
  description = "Templated put-parameter commands — fill in the values"
  value       = module.pepper.populate_secrets_commands
}

output "next_steps" {
  description = "What to do after apply"
  value       = module.pepper.next_steps
}

output "security_reminder" {
  description = "Security posture summary"
  value       = module.pepper.security_reminder
}

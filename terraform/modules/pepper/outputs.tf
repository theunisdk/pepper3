output "vpc_id" {
  description = "ID of the dedicated VPC"
  value       = aws_vpc.main.id
}

output "instance_id" {
  description = "EC2 instance ID (use with `aws ssm start-session --target ...`)"
  value       = aws_instance.pepper.id
}

output "instance_public_ip" {
  description = "Elastic IP — outbound only; no inbound is permitted"
  value       = aws_eip.pepper.public_ip
}

output "ami_id" {
  description = "Ubuntu AMI in use"
  value       = data.aws_ami.ubuntu.id
}

output "secret_names" {
  description = "SSM Parameter Store names for each secret"
  value       = local.secret_names
}

output "ssm_session_command" {
  description = "Open an interactive shell on the instance"
  value       = "aws ssm start-session --region ${data.aws_region.current.name} --target ${aws_instance.pepper.id}"
}

output "populate_secrets_commands" {
  description = "Run these after apply to set the real secret values. (telegram_allowed_users is terraform-managed and not listed.)"
  value = {
    for k, name in local.secret_names :
    k => "aws --region ${data.aws_region.current.name} ssm put-parameter --name '${name}' --type SecureString --overwrite --value '<REAL VALUE HERE>'"
    if k != "telegram_allowed_users"
  }
}

output "next_steps" {
  description = "What to do after apply"
  value       = <<-EOT
    PEPPER IS DEPLOYED — three things left:

    1. Set the Telegram bot token (get one from @BotFather):
         aws --region ${data.aws_region.current.name} ssm put-parameter \
           --name '${local.secret_names.telegram_bot_token}' \
           --type SecureString --overwrite --value '<token>'

    2. Refresh secrets on the box:
         aws --region ${data.aws_region.current.name} ssm send-command \
           --instance-ids ${aws_instance.pepper.id} \
           --document-name AWS-RunShellScript \
           --parameters 'commands=["systemctl restart pepper-fetch-secrets pepperd"]'

    3. Log Pepper in to Codex (interactive, one-time — it cannot think until you do):
         aws ssm start-session --region ${data.aws_region.current.name} --target ${aws_instance.pepper.id}
         sudo -u ${var.pepper_user} -i
         cd ~/app && PEPPER_CONFIG=~/pepper/pepper.config.json node dist/pepperctl.js login --device-auth
         exit && sudo systemctl restart pepperd

    Then message your bot on Telegram. Verify with: npm run spike
  EOT
}

output "security_reminder" {
  description = "Security posture summary"
  value       = <<-EOT
    PEPPER SECURITY POSTURE:
      - Security group: NO ingress rules, egress only
      - Access: SSM Session Manager only (no SSH key, no port 22)
      - Telegram: long-polling, so no inbound endpoint is needed
      - Allowlist: only these Telegram user IDs are served: ${var.telegram_allowed_users}
      - Secrets: SSM Parameter Store SecureString, instance role scoped to ${local.secrets_prefix}/*
      - No OpenAI API key is provisioned: Pepper runs on your ChatGPT subscription
      - IMDSv2: required (SSRF protection)
      - EBS: encrypted at rest; ${var.enable_snapshots ? "daily DLM snapshots, ${var.snapshot_retention_count} retained" : "SNAPSHOTS DISABLED"}
      - VPC Flow Logs: ${var.vpc_flow_logs_retention_days}d retention
  EOT
}

# -----------------------------------------------------------------------------
# EC2 INSTANCE
# Ubuntu 22.04 LTS. No SSH key — SSM Session Manager is the only way in.
# -----------------------------------------------------------------------------

resource "aws_instance" "pepper" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  vpc_security_group_ids      = [aws_security_group.pepper.id]
  subnet_id                   = aws_subnet.public.id
  iam_instance_profile        = aws_iam_instance_profile.pepper.name
  monitoring                  = var.enable_detailed_monitoring
  associate_public_ip_address = true

  # No key_name. Access is via `aws ssm start-session`.

  root_block_device {
    volume_size           = var.root_volume_size
    volume_type           = var.root_volume_type
    encrypted             = true
    delete_on_termination = true
  }

  # IMDSv2 required — an agent that fetches URLs is an SSRF risk by nature.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  user_data = templatefile("${path.module}/user_data/init.sh.tftpl", {
    pepper_user             = var.pepper_user
    aws_region              = data.aws_region.current.name
    repo_url                = var.pepper_repo_url
    repo_ref                = var.pepper_repo_ref
    timezone                = var.timezone
    model                   = var.model
    enable_google           = var.enable_google
    secret_telegram         = aws_ssm_parameter.telegram_bot_token.name
    secret_telegram_allowed = aws_ssm_parameter.telegram_allowed_users.name
    secret_google           = var.enable_google ? aws_ssm_parameter.google_client_secret[0].name : ""
    enable_s3_backups       = var.enable_s3_backups ? "true" : "false"
    backup_bucket           = var.enable_s3_backups ? aws_s3_bucket.backups[0].bucket : ""
  })

  user_data_replace_on_change = false

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-instance"
  })

  volume_tags = local.common_tags

  lifecycle {
    ignore_changes = [
      ami,       # don't replace the box (and its memory) on every AMI release
      user_data, # tweaking the bootstrap script shouldn't destroy the instance
    ]
  }
}

# Stable outbound IP. Nothing inbound is permitted; this exists so the address
# Telegram and OpenAI see doesn't change on every stop/start.
resource "aws_eip" "pepper" {
  instance = aws_instance.pepper.id
  domain   = "vpc"

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-eip"
  })

  depends_on = [aws_internet_gateway.main]
}

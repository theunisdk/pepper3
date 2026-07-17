# -----------------------------------------------------------------------------
# SECURITY GROUP
#
# Intentionally NO ingress rules. Access to the instance is exclusively via
# AWS Systems Manager Session Manager (SSM), which works without any inbound
# port being open — the SSM agent on the instance establishes an outbound
# tunnel to AWS.
#
# To reach Pepper' loopback web dashboard (port var.pepper_dashboard_port on
# 127.0.0.1), use SSM port forwarding:
#
#   aws ssm start-session \
#     --profile <profile> --region <region> \
#     --target <instance_id> \
#     --document-name AWS-StartPortForwardingSession \
#     --parameters portNumber=${var.pepper_dashboard_port},localPortNumber=${var.pepper_dashboard_port}
# -----------------------------------------------------------------------------

resource "aws_security_group" "pepper" {
  name        = "${local.name_prefix}-sg"
  description = "Pepper EC2 - SSM-only access, no inbound ports"
  vpc_id      = aws_vpc.main.id

  # No ingress rules. SSM works via outbound-initiated tunnels.

  egress {
    description = "All outbound (Telegram/Google/OpenAI APIs, apt, GitHub, SSM endpoints)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# -----------------------------------------------------------------------------
# NETWORK ACL
# Subnet-level defense in depth. Mirrors the SG: no inbound except ephemeral
# return traffic for outbound flows.
# -----------------------------------------------------------------------------

resource "aws_network_acl" "public" {
  vpc_id     = aws_vpc.main.id
  subnet_ids = [aws_subnet.public.id]

  # Inbound TCP ephemeral ports — return traffic for outbound SSM/HTTPS sessions
  ingress {
    protocol   = "tcp"
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 1024
    to_port    = 65535
  }

  # Inbound UDP ephemeral ports — DNS responses, NTP
  ingress {
    protocol   = "udp"
    rule_no    = 110
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 1024
    to_port    = 65535
  }

  # Explicit deny everything else inbound
  ingress {
    protocol   = "-1"
    rule_no    = 32766
    action     = "deny"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  egress {
    protocol   = "-1"
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-nacl"
  })
}

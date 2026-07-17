# -----------------------------------------------------------------------------
# IAM ROLE FOR THE EC2 INSTANCE
#
#   - SSM Session Manager access (this is the ONLY way in; there is no SSH key)
#   - CloudWatch metrics + logs
#   - Read its own secrets under ${local.secrets_prefix}/*, and nothing else
#   - Decrypt SecureStrings, but only via the SSM service
# -----------------------------------------------------------------------------

resource "aws_iam_role" "pepper" {
  name = "${local.name_prefix}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.pepper.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "cloudwatch" {
  role       = aws_iam_role.pepper.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy" "pepper_secrets" {
  name = "${local.name_prefix}-secrets-access"
  role = aws_iam_role.pepper.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read-only. Unlike the Hermes deployment this was adapted from, Pepper
        # never writes secrets back: its only credential that rotates is the
        # Codex auth.json, and the M1 spike showed refresh tokens are single-use,
        # so a stored copy is unreliable as a restore path anyway. Re-login on a
        # fresh box instead.
        Sid    = "ReadOwnSecrets"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
        ]
        Resource = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${local.secrets_prefix}/*"
      },
      {
        Sid      = "DecryptSecureStringViaSSM"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${data.aws_region.current.name}.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_iam_instance_profile" "pepper" {
  name = "${local.name_prefix}-instance-profile"
  role = aws_iam_role.pepper.name

  tags = local.common_tags
}

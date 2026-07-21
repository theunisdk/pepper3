# -----------------------------------------------------------------------------
# S3 LOGICAL BACKUPS
#
# Complements the EBS snapshots in backups.tf. Where DLM gives a block-level
# restore of the whole volume (tied to the account/volume), this is a portable,
# off-instance archive: a weekly tar.gz of the assistant's *logical* state
# (workspace + SQLite DB + Google auth) that survives even the instance and its
# volume being deleted, and can be pulled down and restored anywhere.
#
# Security posture: a dedicated customer-managed KMS key (rotated), a bucket
# with all public access blocked, ACLs disabled, versioning on, TLS enforced,
# and lifecycle expiry. The instance role can write to this one bucket and use
# this one key — nothing more.
# -----------------------------------------------------------------------------

resource "aws_kms_key" "backups" {
  count = var.enable_s3_backups ? 1 : 0

  description             = "Encrypts Pepper S3 logical backups"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-backups-key" })
}

resource "aws_kms_alias" "backups" {
  count = var.enable_s3_backups ? 1 : 0

  name          = "alias/${local.name_prefix}-backups"
  target_key_id = aws_kms_key.backups[0].key_id
}

# Bucket name is derived from the account ID so it is globally unique without
# leaking anything: the account ID is a data-source reference, never a literal
# in these tracked files.
resource "aws_s3_bucket" "backups" {
  count = var.enable_s3_backups ? 1 : 0

  bucket = "${local.name_prefix}-backups-${data.aws_caller_identity.current.account_id}"

  # Guard rail: terraform will refuse to destroy a non-empty backup bucket.
  force_destroy = false

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-backups" })
}

resource "aws_s3_bucket_versioning" "backups" {
  count = var.enable_s3_backups ? 1 : 0

  bucket = aws_s3_bucket.backups[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  count = var.enable_s3_backups ? 1 : 0

  bucket = aws_s3_bucket.backups[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backups[0].arn
    }
    # S3 Bucket Keys cut KMS request costs for repeated puts to near zero.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  count = var.enable_s3_backups ? 1 : 0

  bucket                  = aws_s3_bucket.backups[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  count = var.enable_s3_backups ? 1 : 0

  bucket = aws_s3_bucket.backups[0].id
  rule {
    object_ownership = "BucketOwnerEnforced" # ACLs disabled entirely
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  count = var.enable_s3_backups ? 1 : 0

  bucket = aws_s3_bucket.backups[0].id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"

    filter {
      prefix = "backups/"
    }

    expiration {
      days = var.s3_backup_retention_weeks * 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Enforce TLS in transit. Public access is already blocked; this denies any
# plaintext S3 call as belt-and-braces.
resource "aws_s3_bucket_policy" "backups" {
  count = var.enable_s3_backups ? 1 : 0

  bucket = aws_s3_bucket.backups[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.backups[0].arn,
        "${aws_s3_bucket.backups[0].arn}/*",
      ]
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.backups]
}

# The instance role's write path: this one bucket, this one key, nothing else.
resource "aws_iam_role_policy" "pepper_backups" {
  count = var.enable_s3_backups ? 1 : 0

  name = "${local.name_prefix}-backups-access"
  role = aws_iam_role.pepper.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteAndReadOwnBackups"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.backups[0].arn,
          "${aws_s3_bucket.backups[0].arn}/*",
        ]
      },
      {
        Sid    = "UseBackupKey"
        Effect = "Allow"
        Action = [
          "kms:GenerateDataKey",
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.backups[0].arn
      }
    ]
  })
}

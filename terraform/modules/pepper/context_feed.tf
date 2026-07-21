# -----------------------------------------------------------------------------
# CONTEXT FEED (optional)
#
# The context-feeds pattern (docs/context-feeds.md): an external producer
# publishes JSON snapshots to an S3 prefix, and the box syncs them into
# workspace/context/<dest>/ on a timer so scheduled jobs read fresh data. This
# grants the instance role read-only access to that one prefix (and decrypt on
# its KMS key, if the feed bucket is SSE-KMS). The box-side sync timer is wired
# in user_data.
#
# All values are deployment-specific and come from tfvars — nothing here names
# a bucket or key. Leave context_feed_bucket unset to disable.
# -----------------------------------------------------------------------------

resource "aws_iam_role_policy" "pepper_context_feed" {
  count = var.context_feed_bucket != "" ? 1 : 0

  name = "${local.name_prefix}-context-feed-read"
  role = aws_iam_role.pepper.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "ReadFeedObjects"
          Effect   = "Allow"
          Action   = ["s3:GetObject"]
          Resource = "arn:aws:s3:::${var.context_feed_bucket}/${var.context_feed_prefix}*"
        },
        {
          Sid      = "ListFeedPrefix"
          Effect   = "Allow"
          Action   = ["s3:ListBucket"]
          Resource = "arn:aws:s3:::${var.context_feed_bucket}"
          Condition = {
            StringLike = { "s3:prefix" = ["${var.context_feed_prefix}*"] }
          }
        },
      ],
      var.context_feed_kms_key_arn != "" ? [
        {
          Sid      = "DecryptFeedObjects"
          Effect   = "Allow"
          Action   = ["kms:Decrypt", "kms:DescribeKey"]
          Resource = var.context_feed_kms_key_arn
        }
      ] : []
    )
  })
}

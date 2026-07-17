# -----------------------------------------------------------------------------
# EBS SNAPSHOTS via Data Lifecycle Manager
#
# This is the restore story for the assistant's memory: MEMORY.md, notes, and
# the SQLite DB all live on the root volume. DLM stores incremental deltas, so
# 7 dailies of a mostly-static 30 GB volume is typically ~$1-2/mo.
# -----------------------------------------------------------------------------

resource "aws_iam_role" "dlm" {
  count = var.enable_snapshots ? 1 : 0
  name  = "${local.name_prefix}-dlm-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "dlm" {
  count      = var.enable_snapshots ? 1 : 0
  role       = aws_iam_role.dlm[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "pepper" {
  count              = var.enable_snapshots ? 1 : 0
  description        = "Daily EBS snapshots of the Pepper root volume"
  execution_role_arn = aws_iam_role.dlm[0].arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    # Targets the volume via the Project tag applied in locals.common_tags.
    target_tags = {
      Project = var.project_name
    }

    schedule {
      name = "daily-${var.snapshot_retention_count}d"

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = [var.snapshot_time_utc]
      }

      retain_rule {
        count = var.snapshot_retention_count
      }

      tags_to_add = merge(local.common_tags, {
        Name       = "${local.name_prefix}-snapshot"
        SnapshotOf = "pepper-root"
      })

      copy_tags = true
    }
  }

  tags = local.common_tags
}

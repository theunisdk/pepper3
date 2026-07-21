# Latest Ubuntu 24.04 LTS (Noble) AMI from Canonical. 24.04 (glibc 2.39) is
# required: the Google Workspace CLI (gws) is a native binary linked against
# glibc 2.39 and will not run on 22.04's 2.35.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

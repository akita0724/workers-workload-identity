# AWS STS

[English](README.md) | [日本語](README.ja.md)

Read the [shared preparation](../README.md) first. AWS support is unverified; this example exists to validate it. See [Provider support](../../docs/reference/provider-support.mdx).

`terraform/main.tf` creates a new IAM OIDC provider for the issuer and a role whose trust policy allows `sts:AssumeRoleWithWebIdentity` only when `aud` equals `audience` and `sub` equals `subject`. `GetCallerIdentity` needs no additional IAM permission.

Copy `terraform/terraform.tfvars.example` to `terraform.tfvars` in the same directory and set `issuer_url`, `subject`, `audience`, `aws_region`, and the role name `name`. Configure AWS credentials the usual way for the AWS CLI or SDK; never put them in tfvars. Copy `terraform output -raw role_arn` to `AWS_ROLE_ARN` and the region to `AWS_REGION` in the Worker's `vars`. Set `AUDIENCE` and the issuer grant to the same value as `audience`.

The Worker exchanges the assertion with `AssumeRoleWithWebIdentity` (`DurationSeconds: 900`) and then calls `GetCallerIdentity` with the temporary credentials.

If an IAM OIDC provider for the same issuer URL already exists, this Terraform cannot create a second one. Import the existing provider or change the configuration. If the issuer URL has a path or a trailing `/`, confirm in a live account that the provider ARN and the IAM condition keys match what AWS registers.

[AWS STS API: AssumeRoleWithWebIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html)

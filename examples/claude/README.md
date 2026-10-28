# Claude API

[English](README.md) | [日本語](README.ja.md)

Read the [shared preparation](../README.md) first. Claude API support is unverified; this example exists to validate it. See [Provider support](../../docs/reference/provider-support.mdx).

Terraform uses the experimental community provider `frank-bee/anthropic` to create a federation issuer (JWKS from discovery) and a federation rule limited to the issuer, `aud`, and subject. Before you apply, create a service account and its workspace membership in the Claude Console, and pass an OAuth token with `org:admin` to the provider through the `ANTHROPIC_OAUTH_TOKEN` environment variable. An Admin API key does not work for this.

Copy `terraform/terraform.tfvars.example` to `terraform.tfvars` and set `issuer_url`, `subject`, `audience`, `organization_id`, `service_account_id`, and `workspace_id`. The rule matches the subject with `subject_prefix`, so use the caller's complete, fixed subject. Terraform rejects an empty subject or one that contains `*`. Copy the outputs `rule_id`, `organization_id`, `service_account_id`, and `workspace_id` to the Worker's `CLAUDE_RULE_ID`, `CLAUDE_ORGANIZATION_ID`, `CLAUDE_SERVICE_ACCOUNT_ID`, and `CLAUDE_WORKSPACE_ID`. Set `AUDIENCE` and the issuer grant to the same value as `audience`.

The Worker exchanges the assertion at the Claude OAuth token endpoint with the JWT bearer grant and then lists models. The rule issues access tokens with the `workspace:developer` scope and a 600-second lifetime. That scope reaches the workspace's non-admin APIs, including the Models API; check the provider documentation if you need narrower access.

The Terraform provider is not official, and its WIF resources are not covered by the provider's own live acceptance tests. [Claude workload identity federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation), [Terraform provider](https://registry.terraform.io/providers/frank-bee/anthropic/latest/docs)

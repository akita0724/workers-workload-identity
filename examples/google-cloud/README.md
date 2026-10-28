# Google Cloud

[English](README.md) | [日本語](README.ja.md)

Read the [shared preparation](../README.md) first. Google Cloud support is unverified; this example exists to validate it. See [Provider support](../../docs/reference/provider-support.mdx).

Terraform creates a Workload Identity Pool and an OIDC Provider that maps `google.subject` to `assertion.sub` and accepts only the configured subject and audience, a custom role containing only `resourcemanager.projects.get`, and a project binding for the fixed subject. Enable the IAM, Resource Manager, and STS APIs and obtain project admin permissions separately.

Copy `terraform/terraform.tfvars.example` to `terraform.tfvars` and set `project_id`, `issuer_url`, `audience`, `subject`, and unique `pool_id`, `provider_id`, and `role_id` values. Authenticate with Application Default Credentials or similar. Copy `terraform output -raw provider_audience` to `GOOGLE_PROVIDER` and `project_id` to `GOOGLE_PROJECT_ID` in the Worker's `vars`, and set `AUDIENCE` to the same value as `audience`. `GOOGLE_PROVIDER` is the provider resource name sent to Google STS; it is not the JWT `aud`.

The Worker exchanges the assertion at Google STS and reads the project through Cloud Resource Manager.

This example grants the role directly to the federated principal and does not use service account impersonation. Keep the subject within Google's 127-character limit for `google.subject`. [Google Cloud configuration](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers)

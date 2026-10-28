# OpenAI API

[English](README.md) | [日本語](README.ja.md)

Read the [shared preparation](../README.md) first. OpenAI API support is unverified; this example exists to validate it. See [Provider support](../../docs/reference/provider-support.mdx).

In the OpenAI Platform, create a Workload Identity Provider and a project service account mapping. Register the issuer, audience, subject, and public JWKS, and give the service account the permission needed to read the Models API.

Copy `terraform/terraform.tfvars.example` to `terraform.tfvars` and set `identity_provider_id`, `service_account_id`, `issuer_url`, `subject`, and `audience`. This Terraform only records these values and returns them in the `worker_config` output; it does not create the provider or the mapping. Set the same values in the Worker's `OPENAI_PROVIDER_ID`, `OPENAI_SERVICE_ACCOUNT_ID`, and `AUDIENCE`, and in the issuer grant. Never put API keys or tokens in tfvars.

The Worker exchanges the assertion for an OpenAI access token at the OpenAI token endpoint and then calls `GET /v1/models`.

OpenAI workload identity federation exchanges OIDC JWTs and is configured with providers and mappings. The official guide asks you to contact OpenAI support for OIDC providers that it does not list, and the token exchange reference describes restrictions on custom issuers. Confirm in your environment whether this issuer can be registered and exchanged. [OpenAI WIF guide](https://developers.openai.com/api/docs/guides/workload-identity-federation), [token exchange](https://developers.openai.com/api/reference/workload-identity-federation)

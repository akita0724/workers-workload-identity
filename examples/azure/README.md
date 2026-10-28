# Microsoft Entra / Azure

[English](README.md) | [日本語](README.ja.md)

Read the [shared preparation](../README.md) first. Microsoft Entra is a future candidate outside the initial validation gate, and its support is unverified. See [Provider support](../../docs/reference/provider-support.mdx).

Terraform creates an Entra application, a federated identity credential for the issuer and subject with the audience `api://AzureADTokenExchange`, a service principal, a test resource group, and a Reader role assignment scoped to that resource group. You need permission to register Entra applications and to create Azure role assignments.

Copy `terraform/terraform.tfvars.example` to `terraform.tfvars`, set `subscription_id`, `issuer_url`, `subject`, `name`, and `location`, and sign in to the test environment with the Azure CLI or similar. Copy the Terraform outputs `tenant_id`, `client_id`, `subscription_id`, and `resource_group` to the Worker's `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID`, and `AZURE_RESOURCE_GROUP`. `AUDIENCE` is already `api://AzureADTokenExchange`; grant that audience to the issuer client and set it to RS256.

The Worker sends the assertion as a client assertion to the Microsoft identity platform token endpoint and reads the resource group through Azure Resource Manager.

Role assignments can take time to take effect. [Microsoft Entra workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-spiffe-spire)

terraform { required_version = ">= 1.5.0" }

# The OpenAI Platform provider and service-account mapping are configured manually.
# This module records their non-secret identifiers; it does not create either resource.
variable "identity_provider_id" { type = string }
variable "service_account_id" { type = string }
variable "audience" { type = string }
variable "issuer_url" { type = string }
variable "subject" { type = string }

resource "terraform_data" "manual_configuration" {
  input = {
    identity_provider_id = var.identity_provider_id
    service_account_id   = var.service_account_id
    audience             = var.audience
    issuer_url           = var.issuer_url
    subject              = var.subject
  }
}

output "worker_config" { value = terraform_data.manual_configuration.output }

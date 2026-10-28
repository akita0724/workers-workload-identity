terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azuread = { source = "hashicorp/azuread", version = "~> 3.0" }
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

variable "subscription_id" { type = string }
variable "issuer_url" { type = string }
variable "subject" { type = string }
variable "name" { type = string }
variable "location" { type = string }

provider "azuread" {}
provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

data "azuread_client_config" "current" {}

resource "azuread_application" "probe" { display_name = var.name }
resource "azuread_service_principal" "probe" { client_id = azuread_application.probe.client_id }

resource "azuread_application_federated_identity_credential" "probe" {
  application_id = azuread_application.probe.id
  display_name   = "workload-probe"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = var.issuer_url
  subject        = var.subject
}

resource "azurerm_resource_group" "probe" {
  name     = var.name
  location = var.location
}

resource "azurerm_role_assignment" "probe" {
  scope                = azurerm_resource_group.probe.id
  role_definition_name = "Reader"
  principal_id         = azuread_service_principal.probe.object_id
}

output "tenant_id" { value = data.azuread_client_config.current.tenant_id }
output "client_id" { value = azuread_application.probe.client_id }
output "subscription_id" { value = var.subscription_id }
output "resource_group" { value = azurerm_resource_group.probe.name }

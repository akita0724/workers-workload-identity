terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
}

variable "project_id" { type = string }
variable "issuer_url" { type = string }
variable "audience" { type = string }
variable "subject" { type = string }
variable "pool_id" { type = string }
variable "provider_id" { type = string }
variable "role_id" { type = string }

provider "google" { project = var.project_id }
data "google_project" "target" { project_id = var.project_id }

resource "google_iam_workload_identity_pool" "probe" {
  workload_identity_pool_id = var.pool_id
  display_name              = "Workload identity probe"
}

resource "google_iam_workload_identity_pool_provider" "issuer" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.probe.workload_identity_pool_id
  workload_identity_pool_provider_id = var.provider_id
  attribute_mapping                  = { "google.subject" = "assertion.sub" }
  attribute_condition                = "assertion.sub == ${jsonencode(var.subject)}"
  oidc {
    issuer_uri        = var.issuer_url
    allowed_audiences = [var.audience]
  }
}

resource "google_project_iam_custom_role" "probe" {
  role_id     = var.role_id
  title       = "Workload identity probe"
  permissions = ["resourcemanager.projects.get"]
}

resource "google_project_iam_member" "probe" {
  project = var.project_id
  role    = google_project_iam_custom_role.probe.name
  member  = "principal://iam.googleapis.com/projects/${data.google_project.target.number}/locations/global/workloadIdentityPools/${var.pool_id}/subject/${var.subject}"
}

output "provider_audience" { value = "//iam.googleapis.com/${google_iam_workload_identity_pool_provider.issuer.name}" }
output "project_id" { value = var.project_id }

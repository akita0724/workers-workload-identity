# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbers will follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once the first release is tagged.

## [Unreleased]

### Added

- Workload and audience deletion in the admin API and console. Workloads must be disabled, and audiences must have no remaining grants. Deletion retains audit history and records the previous settings atomically with cleanup of related grants and rate-limit buckets.
- Issuer Worker with a named `IssuerRpc` Service Binding entrypoint, limited discovery metadata, and a public JWKS.
- Caller SDK (`packages/client`) with an ESM and TypeScript declaration build (`pnpm client:build`). It is not published to npm.
- Admin console: policy editing with change review, audience editing and relying-party confirmation records, read-only views, and a responsive layout.
- Operator management: role changes, disablement, and deletion; Cloudflare Access identity relinking; passkey registration and removal; recovery invitations. The database prevents removing or demoting the last enabled `security-admin`, and prevents deleting the last passkey of any enabled operator unless that operator has an unused, unexpired invitation.
- Audit search by action, target, operator, and period, with stable pagination for records that share a timestamp.
- Per-issuance audit records with an optional UUID request ID. A failed audit write blocks the assertion. Records expire after 30 days.
- Key rotation: direct start by a `security-admin`; proposals by an `operator` or `security-admin` that a `security-admin` other than the proposer must approve; Workflow pause, resume, and retry; and immediate rotation with explicit confirmation.
- Opt-in scheduled rotation per algorithm, re-checked by a five-minute cron trigger, gated on relying-party confirmations. The first key can be activated before any confirmation exists.
- Discovery and JWKS health checks, aggregate issuance metrics, an availability SLO view, structured log events, and retention cleanup.
- Operations commands for D1 backup, restore into an isolated database, and audited administrator recovery (`pnpm ops`).
- Local workerd and Cloudflare staging end-to-end tests, and staging scripts (`pnpm staging:*`).
- Terraform and Worker examples for live validation with AWS, Google Cloud, Microsoft Entra, Claude API, and OpenAI API.

### Changed

- Documentation is now authored in English, with a complete Japanese mirror under `docs/ja/`, and grouped into guides, reference, and design sections. A glossary defines the terms used throughout.
- Staging tests and `bootstrap.json` now use the admin console URL under the issuer (`/admin/`). `staging:configure` documents `--public-url` and rejects a public URL that differs from the saved target.

### Database migrations

Apply all migrations in `migrations/admin`, `migrations/keys`, and `migrations/policy` before deploying the matching Worker versions. See the [operations guide](docs/guides/operations.md).

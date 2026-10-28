# Security policy

[English](SECURITY.md) | [日本語](SECURITY.ja.md)

`workers-workload-identity` is identity infrastructure in alpha. It has no production-supported version yet. Until the first supported release, security fixes are made on the current `main` branch.

## Report a vulnerability privately

Use GitHub Private Vulnerability Reporting for this repository. Once it is enabled, submit a report at https://github.com/akita0724/workers-workload-identity/security/advisories/new. Do not open a public issue for a suspected vulnerability.

If private reporting is not enabled, ask a maintainer for a private contact channel without including the vulnerability details. Do not send JWTs, signing keys, Cloudflare API tokens, account identifiers, invitation tokens, or production configuration through a public issue, discussion, or pull request.

Include enough information to reproduce and assess the finding:

- affected commit or version;
- affected component and deployment shape;
- prerequisites and minimal reproduction steps;
- observed and expected behavior;
- security impact and likely attack path;
- whether credentials or real accounts were used; and
- a proposed fix or test, if available.

Use synthetic identifiers and test-only credentials. If an accidental disclosure has already occurred, state what was exposed and when, but do not repeat the secret in the report.

## Coordinated disclosure

Maintainers will confirm the report through the private channel, assess affected versions, and coordinate a fix and disclosure plan. Please allow time for analysis before publishing details. The project does not promise a response-time or remediation SLA before its first supported release.

Do not test against systems or accounts you do not own or have explicit permission to assess. Avoid availability attacks, destructive data changes, broad credential collection, and access to other users' data.

## In scope

Examples of security-relevant findings include:

- obtaining an assertion without an authorized Service Binding or grant;
- choosing another client's subject, audience, lifetime, algorithm, or key;
- exposing a signing key, assertion, admin session, passkey material, or Cloudflare API token;
- bypassing signature, issuer, audience, subject, time, or algorithm validation;
- unsafe key rotation that signs with an unpublished key or removes a key too early;
- bypassing admin authentication, RBAC, CSRF protection, or audit requirements; and
- leaking organization-specific deployment data through the public repository or documentation.

The trust boundaries and threats the project is designed for are described in the [security model](docs/reference/security.md).

Configuration questions, unsupported provider integrations, and ordinary bugs without a security boundary impact belong in a public issue after all sensitive values are removed.

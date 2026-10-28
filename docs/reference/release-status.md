---
title: Release status
description: What has been verified, what remains, known issues, and the gates for the beta release and production use
sidebar:
  order: 3
---

The project is in **alpha**. The current release is `v0.1.0-alpha.0`, published as a GitHub prerelease. The public contract may still change, and no version is supported for production use. It is licensed under the [MIT License](https://github.com/akita0724/workers-workload-identity/blob/main/LICENSE). Changes are recorded in the [changelog](https://github.com/akita0724/workers-workload-identity/blob/main/CHANGELOG.md).

Last updated: 2026-10-28

## Verified

These behaviors pass in local workerd, and the shared end-to-end cases also pass in a Cloudflare staging environment:

- issuance through the named `IssuerRpc` Service Binding entrypoint with a fixed `ctx.props.clientId`;
- client, audience, and grant evaluation in Policy D1;
- RS256 signing and verification against the public JWKS;
- rejection of a wrong issuer, audience, subject, expiry, or signature;
- client disablement and grant removal taking effect on the next issuance;
- unique `jti` values across four parallel issuances;
- ten shared end-to-end cases and a caller-disable test in Cloudflare staging;
- the admin console and first-administrator passkey bootstrap in staging; and
- server-side generation, prepublication, and activation of the first signing key.

## Implemented but not yet accepted in production

The following features exist and have automated tests, but have not completed acceptance in a production-like environment:

- policy editing, operator and passkey lifecycle management, and audit search in the admin console;
- per-issuance audit records, aggregate issuance metrics, and availability SLO display;
- relying-party confirmation records that gate scheduled rotation and normal key replacement;
- rotation proposals by an `operator` or `security-admin` that a different `security-admin` approves, direct start by a `security-admin`, Workflow pause, resume, and retry, and immediate rotation;
- opt-in scheduled rotation per algorithm, checked every five minutes;
- discovery and JWKS health checks, structured log events, and retention cleanup; and
- D1 backup, restore into an isolated database, and audited administrator recovery.

## Not yet verified

- Real token exchange with the four initial targets: AWS, Google Cloud, Claude API, and OpenAI API.
- Real token exchange with Microsoft Entra, a future candidate outside the initial gate.
- ES256 interoperability with any external provider.
- Service Binding configuration permissions tested with multiple account roles and API tokens.
- Normal and immediate rotation rehearsed against long-running production state.
- Routing alerts from the structured log events to an external notification service.

The project does not aim to conform as a complete OpenID Provider.

## Known issues

- The `wrangler.example.jsonc` files are templates. The staging scripts generate the configuration actually used for deployment; see the [staging deployment guide](../guides/deployment.md).

## Gates for the beta release

The repository and documentation site are public from the first alpha. The beta release follows once all of these are complete:

- [ ] Live validation of AWS, Google Cloud, Claude API, and OpenAI API, with dated results in [provider support](./provider-support.mdx). A provider may be published as unsupported if that result is stated.
- [x] GitHub Private Vulnerability Reporting enabled for the repository.
- [ ] Dependency licenses, third-party notices, known vulnerabilities, and secret scanning reviewed.
- [ ] English and Japanese documentation, internal links, canonical URLs, `hreflang`, and per-language search checked on a preview build.
- [ ] Git tag signing and the compatibility policy decided. Releases use Semantic Versioning pre-release tags such as `v0.1.0-alpha.0`.

`SECURITY.md`, `CONTRIBUTING.md`, `SUPPORT.md`, and the Code of Conduct are in place.

The detailed engineering criteria are in [acceptance criteria](../design/acceptance.md).

## Production use is a separate decision

Publishing the source does not make the project ready to operate as production identity infrastructure. Before production use, evaluate the target Cloudflare account permissions, each relying party, incident response, key management, monitoring, recovery, and your organization's security requirements.

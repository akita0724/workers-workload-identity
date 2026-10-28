---
title: Glossary
description: Terms used throughout the workers-workload-identity documentation
sidebar:
  order: 4
---

These definitions apply to every page in this documentation. Code identifiers keep their exact spelling.

## Participants

| Term                 | Meaning                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Issuer**           | The issuer Worker, deployed as `oidc` by default. It signs workload assertions and publishes discovery metadata and the JWKS. Its public URL is the `ISSUER_URL` setting and the `iss` claim. |
| **Caller**           | A Worker that holds a Service Binding to the issuer's `IssuerRpc` entrypoint and requests workload assertions.                                                                                |
| **Relying party**    | Any system that receives and verifies a workload assertion: an external provider's token exchange, or a private API that verifies the JWT directly.                                           |
| **Provider**         | An external cloud or API service, such as AWS, Google Cloud, Claude API, or OpenAI API, acting as a relying party.                                                                            |
| **Operator**         | A person who manages policy and keys through the admin console. Operators have one of three roles: `viewer`, `operator`, or `security-admin`.                                                 |
| **Deploy principal** | A person, CI job, or API token that can edit Workers, Service Bindings, or their `props`. Deploy principals are part of the trust boundary; see the [security model](./security.md).          |
| **Deployer**         | The person who runs the staging and operations scripts (`pnpm staging:*`, `pnpm ops`) to create resources, deploy the Workers, and perform recovery. A deployer is also a deploy principal.   |

## Policy

| Term         | Meaning                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Client**   | A registry entry that identifies a caller. The issuer selects it from the fixed `ctx.props.clientId` on the Service Binding. A client ID is not a secret. |
| **Subject**  | The fixed `sub` value stored for a client. Callers cannot choose it.                                                                                      |
| **Audience** | A registered `aud` value. Each audience fixes the signing algorithm and assertion lifetime, and records relying-party verification results.               |
| **Grant**    | Permission for one client to request assertions for one audience.                                                                                         |

## Assertions and keys

| Term                    | Meaning                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workload assertion**  | The short-lived, signed JWT that the issuer returns to a caller. After the first mention, pages call it an **assertion**. "JWT" refers to the format, and "token" to bearer tokens in general.    |
| **Discovery metadata**  | The limited JSON document at `/.well-known/openid-configuration`. It is not complete OIDC Discovery metadata.                                                                                     |
| **JWKS**                | The public key set at `/jwks.json` that relying parties use to verify signatures.                                                                                                                 |
| **Token exchange**      | A provider endpoint that accepts a workload assertion and returns temporary credentials or an access token.                                                                                       |
| **Key states**          | `prepared` (published, not signing), `active` (the only signing key for its algorithm), `verifying` (published to verify earlier assertions), and `removed` (retired; its `kid` is never reused). |
| **Rotation Controller** | The Worker deployed as `oidc-rotation` by default (source in `apps/rotation-worker`). It generates keys, stores private keys as issuer Worker secrets, and moves keys between states.             |
| **Prepublication**      | The period in which a new key is in the JWKS but not yet signing, so relying-party caches can fetch it.                                                                                           |

## Why some identifiers say "OIDC"

The default Worker name `oidc`, the binding name `OIDC_ISSUER`, and the SDK names `createOidcClient` and `OidcClientError` reflect the OIDC-style discovery metadata and JWKS that relying parties consume. The project is not an OpenID Provider: it has no browser login, authorization endpoint, or ID Token flow. See [What is workload identity federation?](../oidc.mdx).

## Release terms

**Alpha** is the current release stage, published as GitHub prereleases tagged like `v0.1.0-alpha.0`. The public contract may still change, live validation with external providers is not complete, and no version is supported for production use. **Beta** follows once the gates on the release status page are met. The [release status](./release-status.md) page lists what has and has not been verified.

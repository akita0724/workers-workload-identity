---
title: Security model
description: Trust boundaries, bearer-token handling, access reduction, and response to key compromise
sidebar:
  order: 6
---

The system replaces long-lived cloud credentials in caller Workers with workload assertions that expire within five minutes. A short-lived JWT does not, by itself, prove that a caller is genuine or authorize access to an API.

## Assets and trust boundaries

| Boundary                         | Trusted input                                                                                                                | Untrusted input                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Caller → issuer                  | A same-account Service Binding and reviewed, fixed `props.clientId`                                                          | RPC parameters that claim a subject, lifetime, or algorithm    |
| Issuer → relying party           | A preconfigured issuer URL, the public JWKS, and a per-audience algorithm                                                    | Authorization rules derived automatically from discovery       |
| Operator → policy                | An authenticated operator, server-side RBAC, and audited changes                                                             | Permission checks implemented only in browser UI               |
| Rotation Controller → issuer     | An account-level Workers Scripts Edit and Read token, used only against the issuer script fixed in code (`CF_ISSUER_SCRIPT`) | Key material or an arbitrary Worker name supplied by a browser |
| Organization → public repository | Source, schemas, fictitious examples, and public-key formats                                                                 | Real keys, registrations, account IDs, tokens, and invitations |

`ctx.props.clientId` is not a secret. A Cloudflare administrator, editor, CI job, or API token that can change a Service Binding and its `props` can select another client ID. Minimize deployment permissions and include Worker-level permissions and change review in the operating model.

A same-Worker `ctx.exports` loopback binding can set `props` dynamically. Do not add a public HTTP handler that calls `IssuerRpc` through a loopback binding, and do not hand an issuer RPC stub to untrusted code.

## Assertions are bearer credentials

Anyone who obtains a workload assertion may be able to use it until it expires. A `jti` identifies a token but does not automatically prevent replay. Keep assertions out of logs, HTTP responses, browser code, and persistent storage; pass them directly to the intended exchange or relying party.

The relying party must validate the signature, exact `iss`, purpose-specific `aud`, allowed `sub`, required time claims, maximum lifetime, and algorithm allowlist. See [Verify an assertion](../guides/verifying-assertions.md).

## Disabling access is not instantaneous revocation

Disabling a client or removing a grant affects the next issuance request. A JWT already issued remains valid until `exp`, and credentials already exchanged with a cloud provider may remain usable until the provider's expiry.

During an emergency, combine the controls appropriate to the incident:

1. Disable the client to stop new issuance.
2. Remove a grant to stop new issuance for one audience.
3. Disable the subject, role, federated credential, or service-account mapping at the relying party.
4. Start immediate key rotation if signing-key compromise is suspected.
5. Revoke exchanged sessions or temporary credentials when the provider supports it.

Before production use, identify who can choose containment over availability and how that person will be reached.

## Separate secret-bearing components

- At rest, the issuer signing key exists only in a `SIGNING_KEY_*` Worker secret. During rotation, the Controller generates and temporarily exports the key server-side to install that secret; it must not persist the private material elsewhere.
- Key Registry D1 contains only public JWKs, `kid` values, states, and rotation records.
- The Rotation Controller's Cloudflare API token belongs only in the Controller secret. It must not reach the issuer, Admin Worker, browser, or D1.
- The Admin Worker can change policy but cannot read or write signing private keys.
- A caller receives only the issuer RPC binding. It has no direct Policy D1, Key D1, or admin API access.

Never place a private key in D1, KV, the repository, the admin UI, or an audit log. The staging scripts also write tokens and invitation data under `.deploy/staging/`. Git ignores this directory, but it must not be shared or included in ordinary backups.

## Keep algorithm and token purpose explicit

The initial default is `RS256`. Enable `ES256` only for an audience with a recorded interoperability test. A verifier must compare the token's `alg` with its own allowlist rather than selecting a verification method from the token alone.

Use different audiences for cloud token exchange and for a private API that accepts the issuer JWT directly. Claiming compliance with the JWT access-token profile requires a separate RFC 9068 review.

## Do not disclose vulnerabilities in a public issue

Report sensitive findings through GitHub Private Vulnerability Reporting for the repository. If it is unavailable, do not post reproduction steps, tokens, or account details publicly; ask the maintainers for a private contact channel. The root [`SECURITY.md`](https://github.com/akita0724/workers-workload-identity/blob/main/SECURITY.md) defines the reporting policy and supported versions.

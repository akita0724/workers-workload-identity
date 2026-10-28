---
title: Troubleshooting
description: Diagnose common issuance, verification, discovery, JWKS, deployment, and rotation failures
sidebar:
  order: 9
---

Start by locating the failing boundary without printing a JWT or secret. Separate the caller's public error code, the issuer's HTTP status, the stopped rotation gate, and the Wrangler operation that failed.

## Issuance is denied

| Error                  | Check                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-request`      | The input is exactly `{ aud }` with an optional `requestId`; `aud` is a valid StringOrURI; `requestId`, if present, is a UUID; there is no extra field                    |
| `caller-denied`        | `props` is exactly `{ clientId }` with a valid ID, and the client is registered and enabled                                                                               |
| `audience-denied`      | The audience matches exactly and the client has a grant to it                                                                                                             |
| `rate-limited`         | The client has not exceeded the fixed one-minute window and is not retrying in a loop                                                                                     |
| `issuance-unavailable` | Exactly one active key exists for the algorithm, its `SIGNING_KEY_*` secret is bound, both D1 bindings work, the audience policy is valid, and audit persistence succeeds |
| `transport-error`      | The Service Binding exists, names the right service, targets the `IssuerRpc` entrypoint, and the issuer Worker is available                                               |
| `invalid-response`     | The caller SDK and issuer versions agree and the RPC returns a compact JWT string                                                                                         |

A binding that does not target `IssuerRpc` produces `transport-error` in the client SDK, not `caller-denied`, because the call never reaches the issuer's RPC method. `caller-denied` and `audience-denied` intentionally hide registration details from the caller. An operator checks the actual state in the admin console or Policy D1, including the issuance audit events.

## JWT verification fails

| Symptom               | Likely cause                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `iss` mismatch        | `ISSUER_URL` differs from the relying-party registration, including a trailing slash        |
| `aud` mismatch        | The registered value differs from the exchange endpoint's exact audience                    |
| `sub` mismatch        | The client subject differs from the relying-party allow condition                           |
| Unknown `kid`         | Stale JWKS cache, insufficient prepublication, or the wrong issuer                          |
| Algorithm rejected    | Audience policy and verifier allowlist differ, or ES256 lacks verification evidence         |
| `nbf` / `exp` failure | Clock difference, clock tolerance, or lifetime is wrong                                     |
| Token too large       | Unexpected claims or a token from another issuer; this issuer emits only seven fixed claims |

Do not log the token body. For non-secret diagnostics, use only the protected-header `kid` and `alg`, a result code, and the observed clock difference.

## Discovery or JWKS is wrong

- The issuer serves only `/.well-known/openid-configuration` and `/jwks.json`. There is no HTTP issuance endpoint. Other paths return a plain-text 404, with these rules:
  - A request whose origin differs from the origin of `ISSUER_URL` returns 404 on every path, including discovery and JWKS.
  - If `ISSUER_URL` has a path, such as `https://example.com/oidc`, the issuer serves only paths under that prefix and strips the prefix before routing.
  - `/admin` redirects with 308 to `/admin/`. Paths under `/admin/` are forwarded to the optional `ADMIN` service binding; without that binding they return 404.
- `jwks_uri` is built from `ISSUER_URL` with one trailing slash removed, so a trailing slash does not produce `//jwks.json`. The `issuer` value and the JWT `iss` still use `ISSUER_URL` verbatim.
- An empty JWKS means no initial key has been created. In staging, run `pnpm staging:test`.
- `id_token_signing_alg_values_supported` is the static list `["RS256", "ES256"]`. It describes what the issuer can sign, not the keys currently in the JWKS. Do not treat it as proof that an `active` key exists; check the JWKS and the key states in the admin console.
- A plain-text 503 indicates an internal failure in the public handler, such as an unreadable Key D1 or invalid configuration. Check Key D1 and the Worker settings without returning details to the client.

## Staging deployment stops

| Situation                                             | Action                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Expired Wrangler login                                | Run `pnpm exec wrangler login` and `pnpm exec wrangler whoami`                                                                              |
| Missing Rotation API token                            | Set `OIDC_ROTATION_API_TOKEN` in the current shell and check script Read/Edit permissions                                                   |
| Interrupted after D1 creation                         | Compare the remote databases with `.deploy/staging/settings.json`; do not adopt an unrelated DB automatically                               |
| `staging:test` first-key activation exceeds 3 minutes | Inspect the Workflow run, API token, JWKS, deployed versions, and the cache settings of registered audiences                                |
| Bootstrap is denied                                   | An operator already exists; ask an existing `security-admin` to invite you                                                                  |
| Bootstrap invitation expired                          | Issue a recovery invitation with `pnpm ops recover-admin`; see the [operations guide](./operations.md#recovery-after-all-passkeys-are-lost) |

Deleting `.deploy/staging/` does not remove remote resources. Losing it does remove the local record of database IDs and test tokens.

## Information to include in a report

A public issue may include the reproduction command, public error code, HTTP status, commit, Node/pnpm/Wrangler versions, and sanitized logs. Remove JWTs, secrets, account IDs, invitation tokens, and real external-provider identifiers.

Do not open a public issue for a security vulnerability. Follow the private reporting instructions in [`SECURITY.md`](https://github.com/akita0724/workers-workload-identity/blob/main/SECURITY.md).

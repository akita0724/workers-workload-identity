---
title: Configure the issuer and caller
description: Configure issuer variables, D1 bindings, audiences, clients, grants, and the caller Service Binding
sidebar:
  order: 3
---

To issue assertions, configure the issuer's public identity and storage, then connect an audience, client, grant, and caller Service Binding with the same identifiers. A caller never needs a signing key or direct access to Policy D1.

## Fix the issuer URL and bindings

The issuer Worker requires these settings:

| Name                    | Kind            | Constraint                                                                                                                      |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ISSUER_URL`            | Variable        | Externally reachable HTTPS URL without userinfo, query, or fragment                                                             |
| `RATE_LIMIT_PER_MINUTE` | Variable        | Per-client fixed one-minute window, from 1 to 100,000. The staging scripts set 120                                              |
| `POLICY_DB`             | D1 binding      | Stores clients, audiences, grants, policy audit events, and `issuance_audit_events`, `issuance_metrics`, `issuance_rate_limits` |
| `KEY_DB`                | D1 binding      | Stores public JWKs, key states, rotation records, and issuance reservations                                                     |
| `SIGNING_KEY_*`         | Secrets         | Private signing keys. The Rotation Controller creates and deletes them; do not set them by hand                                 |
| `ADMIN`                 | Service binding | Optional. Forwards `/admin/` requests on the issuer host to the admin Worker                                                    |
| `17 * * * *`            | Cron trigger    | Hourly cleanup of issuance audit events, metrics, rate-limit buckets, and issuance reservations. Required for retention         |

`ISSUER_URL` is used verbatim as the JWT `iss` and the discovery `issuer`. It must exactly match the issuer registered with the relying party, including any trailing slash. Query and fragment components are not allowed.

[`apps/issuer-worker/wrangler.example.jsonc`](https://github.com/akita0724/workers-workload-identity/blob/main/apps/issuer-worker/wrangler.example.jsonc) contains the minimal shape. Replace the example UUIDs and domain with real values. The staging scripts also add the `ADMIN` service binding.

```json
{
  "triggers": { "crons": ["17 * * * *"] },
  "vars": {
    "ISSUER_URL": "https://oidc.example.com",
    "RATE_LIMIT_PER_MINUTE": "120"
  },
  "d1_databases": [
    { "binding": "POLICY_DB", "database_name": "oidc-policy" },
    { "binding": "KEY_DB", "database_name": "oidc-keys" }
  ]
}
```

## Separate audiences by relying party and purpose

An audience is the exact string a relying party validates as `aud`. Its registration fixes:

- `audience`: an exact value from 1 to 2,048 characters;
- `algorithm`: `RS256`, or `ES256` only for a verified integration;
- `tokenLifetimeSeconds`: from 1 to 300 seconds;
- `description`: up to 1,024 characters of context that lets an operator identify its purpose;
- `verifiedForEs256`: whether ES256 was verified with the relying party. It must be `true` before an `ES256` audience can be issued;
- `exchangeVerified`: whether authentication or credential exchange succeeded with the current signing algorithm;
- `mixedJwksVerified`: whether the relying party accepted old and new public keys published together; and
- `jwksCacheSeconds`: the observed upper bound of the relying party's JWKS cache, from 0 to 2,592,000 seconds, or `null` when unknown.

The last four fields default to `false` and `null`. Only a `security-admin` can change them. Normal key rotation refuses to proceed while they are incomplete; see [Verify an assertion](./verifying-assertions.md#jwks-caching-and-rotation).

Do not reuse an audience across environments, permission sets, or unrelated relying parties. Production and staging should have different values. If several relying parties share one audience, the algorithm and key-cache policy must satisfy the strictest member.

## Give each client an immutable subject

A client registration contains:

- `clientId`: a deployment identifier matching `[a-z][a-z0-9-]{2,63}`;
- `subject`: a unique `sub` of 3 to 256 characters allowed by the relying party;
- `enabled`: whether the issuer accepts new requests; and
- the set of allowed audiences.

Both `audience` and `subject` must be RFC 7519 StringOrURI values. A value without `:` is accepted as an arbitrary string. A value that contains `:` must parse as an RFC 3986 URI, such as `urn:example:receiver` or `https://api.example.com`; otherwise registration and issuance reject it.

Treat the subject as immutable after issuance begins. To change an identity, register a new client, migrate the relying party's trust policy, and disable the old client.

A grant links one client to one audience. Even if a caller requests `{ aud }`, the issuer returns `audience-denied` unless an exact grant exists.

## Fix the client ID in the caller Service Binding

The caller's Wrangler configuration selects the named issuer entrypoint and fixes `props.clientId`.

```json
{
  "services": [
    {
      "binding": "OIDC_ISSUER",
      "service": "oidc",
      "entrypoint": "IssuerRpc",
      "props": { "clientId": "example-caller-prod" }
    }
  ]
}
```

TypeScript deployment tooling can use the configuration-only export:

```ts
import { defineIssuerBinding } from "@workers-workload-identity/client/config";

const binding = defineIssuerBinding({
  binding: "OIDC_ISSUER",
  service: "oidc",
  props: { clientId: "example-caller-prod" },
});
```

`defineIssuerBinding` validates the shape and fixes `entrypoint: "IssuerRpc"`. The binding name must match `[A-Za-z_][A-Za-z0-9_]*`, the service name must match `[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}`, and `props` must be exactly `{ clientId }`; otherwise it throws a `ZodError`. It does not change a file, configure Cloudflare permissions, or register the client with the issuer.

The `clientId` is not a secret or a cryptographic proof created at runtime. Restrict the principals that can change Service Bindings and `props`, and use a deployment workflow in which those changes are reviewable.

## Verify the configuration

At minimum, confirm that:

1. discovery returns an `issuer` and `jwks_uri` matching the public URL;
2. the JWKS contains the active key's `kid` and no private key material;
3. an allowed audience succeeds and an audience without a grant is denied;
4. disabling a client denies its next issuance; and
5. no public HTTP route issues assertions and unknown paths return 404.

Continue with [Issue an assertion](./issuing-assertions.md) for caller code and [Verify an assertion](./verifying-assertions.md) for relying-party requirements.

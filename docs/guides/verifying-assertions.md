---
title: Verify an assertion
description: Verify the JWKS signature and strictly constrain the issuer, audience, subject, time, and algorithm
sidebar:
  order: 5
---

A relying party must verify more than the signature. It needs to decide who the token represents, what it is for, and when it expires. Do not accept trust settings from discovery without review: configure the trusted issuer, audience, subject, and algorithms on the receiving side.

## Required checks

| Field                 | Requirement                                                          |
| --------------------- | -------------------------------------------------------------------- |
| `alg`                 | Matches the `RS256` or `ES256` allowlist for this audience           |
| `kid`                 | Exists in the trusted issuer's JWKS; reject an unknown key           |
| `iss`                 | Exactly matches the configured `ISSUER_URL`                          |
| `aud`                 | Contains exactly the audience dedicated to this API                  |
| `sub`                 | Matches a client subject allowed to perform the operation            |
| `iat` / `nbf` / `exp` | All are present and valid relative to the current time               |
| Token lifetime        | `exp - iat` is from 1 to 300 seconds and within the receiver's limit |
| `jti`                 | Is non-empty; record consumed IDs when replay prevention is required |

Following JWT BCP, never trust the algorithm named by the token without an independent allowlist. Reject `none` and any unexpected RSA or EC algorithm. The JWK `use` must be `sig`, and its `alg` must agree with the protected header.

The issuer currently sets `nbf = iat`. The fixture receiver uses zero clock tolerance. Choose a production tolerance explicitly from your relying party's requirements and time-synchronization guarantees; a wide tolerance can defeat the purpose of a short lifetime.

## Minimal `jose` example

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://oidc.example.com";
const audience = "urn:example:receiver";
const subject = "workload:example-caller:prod";
const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks.json`));

export async function verifyAssertion(assertion: string) {
  const { payload, protectedHeader } = await jwtVerify(assertion, jwks, {
    issuer,
    audience,
    algorithms: ["RS256"],
    requiredClaims: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
    clockTolerance: 0,
  });

  if (payload.sub !== subject) throw new Error("unexpected subject");
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("missing token lifetime");
  }
  if (payload.exp - payload.iat < 1 || payload.exp - payload.iat > 300) {
    throw new Error("invalid token lifetime");
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new Error("missing token id");
  }

  return { subject: payload.sub, keyId: protectedHeader.kid };
}
```

This example shows only the verification core. A production API also needs input-size limits, sanitized errors, timeouts, JWKS-fetch failure handling, observability, and—where required—a consumed-`jti` store. The executable repository fixture is [`apps/smoke-receiver/src/index.ts`](https://github.com/akita0724/workers-workload-identity/blob/main/apps/smoke-receiver/src/index.ts).

## JWKS caching and rotation

The JWKS response carries `Cache-Control: public, max-age=60`. Record the upper bound you observed for the relying party's JWKS cache as the audience's `jwksCacheSeconds`, even when the relying party follows that header.

Before a normal activation, the Rotation Controller checks every audience that uses the new key's algorithm. It refuses to activate the key, and keeps the current active key, if any of these audiences:

- has `jwksCacheSeconds` set to `null`;
- has a `jwksCacheSeconds` value for which the prepublication interval is not at least 60 seconds longer;
- lacks `exchangeVerified` or `mixedJwksVerified`; or
- uses `ES256` and lacks `verifiedForEs256`.

The cache check applies to every normal activation. The confirmation checks apply only when a new key replaces an existing active key; they also fail if no audience uses that algorithm. As a result, the first key for an algorithm can be activated before any relying party has been tested. The Controller repeats these checks after confirming the deployment, immediately before switching keys. Immediate rotation skips them; see the [operations guide](./operations.md#issuance-audit-and-relying-party-confirmations).

When a token names an unknown `kid`, a verifier may refresh the JWKS once and retry verification. Avoid unbounded fetches or retry loops. An old key remains in the JWKS as `verifying` until the last token it could have signed has expired with a safety margin.

## Keep token exchange distinct from API authentication

When an external cloud offers token exchange, send the issuer JWT only to that exchange endpoint. Use the returned short-lived access token or temporary credentials with the cloud API. Do not send an issuer assertion directly as a normal Claude API or OpenAI API Bearer token.

If a private API accepts the issuer JWT directly, that API is the relying party. Give it a dedicated audience and subject allowlist instead of sharing an audience used for cloud token exchange.

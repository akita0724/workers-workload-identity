---
title: Issue an assertion
description: Obtain a short-lived JWT through the caller SDK and Service Binding RPC, then handle it safely
sidebar:
  order: 4
---

A caller creates the SDK client inside its request handler and asks for one allowed audience. Keep the returned JWT in memory only as long as necessary, then pass it directly to the token exchange or relying party.

## Issue through the SDK

```ts
import {
  createOidcClient,
  OidcClientError,
  type IssuerBinding,
} from "@workers-workload-identity/client";

interface Env {
  OIDC_ISSUER: IssuerBinding;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const client = createOidcClient(env.OIDC_ISSUER);

    try {
      const assertion = await client.issue({ aud: "urn:example:receiver" });
      return await callRelyingParty(assertion);
    } catch (error) {
      if (error instanceof OidcClientError) {
        return new Response("Upstream identity unavailable", { status: 503 });
      }
      throw error;
    }
  },
};
```

Call `createOidcClient` inside each request. Do not retain a binding or JWT across requests. The SDK does not cache assertions, retry automatically, fall back to HTTP, or exchange the assertion for provider credentials.

The client SDK is not published to npm, and npm publication is not planned. Inside this workspace, `@workers-workload-identity/client` resolves to TypeScript source. For another project, build it from source with `pnpm client:build`, which writes an ESM bundle and type declarations to `packages/client/dist`.

## Issue requests and correlation IDs

A caller that does not use the SDK can invoke the same Service Binding contract.

```ts
interface IssuerBinding {
  issue(request: { aud: string; requestId?: string }): Promise<string>;
}

const assertion = await env.OIDC_ISSUER.issue({
  aud: "urn:example:receiver",
});
```

The input is validated strictly. Supplying a `clientId`, `sub`, lifetime, `alg`, `kid`, or any additional claim is rejected. `aud` must be an RFC 7519 StringOrURI of 1 to 2,048 characters, and `requestId`, if present, must be a UUID; otherwise the result is `invalid-request`. The issuer does not trim, lowercase, or URL-normalize `aud`; it compares the requested value exactly with the registered grant.

The issuer has no HTTP issuance route. Its public HTTP surface serves only discovery and the JWKS, with `Cache-Control: public, max-age=60`. Unknown paths return a plain-text 404, and an internal failure on those endpoints returns a plain-text 503.

The SDK checks that a successful response is a compact JWT no larger than 32 KiB. This is only a shape check, not signature or claim verification. The receiving relying party must apply the rules in [Verify an assertion](./verifying-assertions.md).

`requestId` is an optional UUID used to search issuance audit events. The issuer generates an ID when it is omitted. Reusing an ID does not deduplicate requests or promise retries: each call evaluates policy again. The ID is not a JWT claim.

For every success, denial, or failure, the issuer persists the event ID, request ID, validated client and audience, selected public key ID, outcome, issuance latency (excluding audit persistence), and start time in Policy D1. It does not store raw invalid requests, JWTs, private keys, or exception details. On signing failure, the key ID identifies the attempted key. The issuer also counts each outcome per minute in `issuance_metrics`.

If the audit event cannot be persisted, no JWT is returned and every outcome, including a denial, becomes `issuance-unavailable`. The issuer then writes a JSON log line with the event `issuance-audit-unavailable` and the event ID only. A metrics write failure does not block issuance and logs `issuance-metrics-unavailable`. Input that the client SDK rejects locally never reaches the issuer, so it is not audited.

## Handle only public error codes

| Code                   | Meaning                                                                                                                                         | Basic caller action                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `invalid-request`      | The input shape, `aud`, or `requestId` is invalid                                                                                               | Fix code or configuration; do not retry                                |
| `caller-denied`        | Invalid props, unknown client, or disabled client                                                                                               | Check the registration and Service Binding                             |
| `audience-denied`      | Unknown audience or missing grant                                                                                                               | Check the audience and grant                                           |
| `rate-limited`         | The client exceeded its one-minute limit                                                                                                        | Do not retry in a tight loop                                           |
| `issuance-unavailable` | Issuer configuration, key, storage, signing, or audit failure, including multiple active keys or a signing reservation that exceeded 30 seconds | Ask the issuer operator to investigate                                 |
| `transport-error`      | RPC transport failure, a binding that does not target `IssuerRpc`, or an unknown remote error                                                   | Treat as an outage; retry only after considering operation idempotency |
| `invalid-response`     | The response is not a compact JWT                                                                                                               | Treat as corruption or an incompatible deployment                      |

`caller-denied` deliberately does not distinguish an unknown client from a disabled one. `audience-denied` does not reveal whether an audience is unknown or merely lacks a grant. The SDK also discards the remote exception's message, stack, and cause.

Rate limiting is an RPC `rate-limited` error, not an HTTP 429 response. The current fixed one-minute window is per client, and the same `RATE_LIMIT_PER_MINUTE` applies to all clients. The limit is applied before the client lookup, so attempts by an unknown, disabled, or audience-denied client also consume quota. Requests with invalid props or invalid input are rejected first and do not count.

## Never expose the JWT in logs or browsers

A workload assertion is a bearer credential: anyone who presents it before it expires may be able to use it. Do not put it in:

- `console.log`, exceptions, or trace attributes;
- public HTTP responses or browser code;
- D1, KV, Cache API, or analytics storage;
- URLs, query strings, or cookies; or
- bug reports and public issues.

Observability should use non-secret client and audience identifiers, result codes, latency, and `kid`, never the JWT or private key. The issuance audit events and per-minute metrics follow this rule; see the [operations guide](./operations.md) for retention and monitoring.

## SDK reference

| Export                                         | Entry point                                | Description                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `createOidcClient(binding)`                    | `@workers-workload-identity/client`        | Returns an `OidcClient`. Validates input locally, calls `binding.issue`, and checks the response shape                              |
| `OidcClient`                                   | `@workers-workload-identity/client`        | Interface with one method, `issue({ aud, requestId? }): Promise<string>`                                                            |
| `OidcClientError`                              | `@workers-workload-identity/client`        | Error thrown by `OidcClient.issue`. Its `code` is an `OidcClientErrorCode`; it carries no remote message, stack, or cause           |
| `OidcClientErrorCode`                          | `@workers-workload-identity/client`        | `IssuanceErrorCode` plus `transport-error` and `invalid-response`                                                                   |
| `IssuanceErrorCode`                            | `@workers-workload-identity/client`        | The five codes the issuer can return: `invalid-request`, `caller-denied`, `audience-denied`, `rate-limited`, `issuance-unavailable` |
| `IssuerBinding`, `IssueRequest`, `CallerProps` | `@workers-workload-identity/client`        | Types for the Service Binding RPC contract, its input, and the binding `props`                                                      |
| `defineIssuerBinding(options)`                 | `@workers-workload-identity/client/config` | Returns an `IssuerServiceBinding` for deployment configuration; throws a `ZodError` on invalid names or `props`                     |
| `IssuerServiceBinding`                         | `@workers-workload-identity/client/config` | `{ binding, service, entrypoint: "IssuerRpc", props }`                                                                              |

See [Configure the issuer and caller](./configuration.md#fix-the-client-id-in-the-caller-service-binding) for the naming rules that `defineIssuerBinding` enforces.

# Caller client

[English](README.md) | [日本語](README.ja.md)

`@workers-workload-identity/client` is the caller SDK. A caller Worker uses it to request a workload assertion from the issuer over a Service Binding RPC and to validate the input and response shapes. The package is in alpha.

## Request an assertion

```ts
import { createOidcClient, type IssuerBinding } from "@workers-workload-identity/client";

interface Env {
  OIDC_ISSUER: IssuerBinding;
}

async function obtainAssertion(env: Env) {
  const client = createOidcClient(env.OIDC_ISSUER);
  return client.issue({ aud: "urn:example:receiver" });
}
```

`createOidcClient(binding).issue({ aud, requestId? })` returns the assertion as a string. Create the client inside a request handler and do not keep it across requests. The client ID is never part of the RPC argument; the issuer reads it from the Service Binding's `ctx.props`.

On failure, `issue` throws an `OidcClientError` whose `code` is an `OidcClientErrorCode`: one of the issuer's public `IssuanceErrorCode` values (`invalid-request`, `caller-denied`, `audience-denied`, `rate-limited`, `issuance-unavailable`) or one of the SDK's own codes, `transport-error` and `invalid-response`. The original remote error message is discarded.

## Configure the Service Binding

`defineIssuerBinding` from `@workers-workload-identity/client/config` returns an `IssuerServiceBinding`: a Wrangler `services` entry with `entrypoint: "IssuerRpc"` and the fixed `props.clientId`. Use it in deployment tooling only; it does not change the running Worker's context or register a client.

```ts
import { defineIssuerBinding } from "@workers-workload-identity/client/config";

const binding = defineIssuerBinding({
  binding: "OIDC_ISSUER",
  service: "oidc",
  props: { clientId: "example-caller-prod" },
});
```

## Boundaries

- Pass the assertion to your internal token exchange. Never return it to a browser or write it to logs.
- The SDK does not retry, cache assertions, or exchange cloud credentials.
- The response check validates the JWT shape only. It does not verify the signature; the relying party does that.

## Build

The package is not published to npm. Build it from source at the repository root:

```sh
pnpm client:build
```

This writes ESM bundles (`index.js`, `config.js`), TypeScript declarations, a `package.json` that depends only on Zod, `LICENSE`, and a short generated `README.md` to `packages/client/dist/`.

For the API, error codes, non-goals, and acceptance criteria, see the [caller library requirements](../../docs/design/client-library.md). Interoperability with external providers in production has not been verified.

# Caller library requirements

**Status:** Implemented. The library and its local tests exist. Production deployment and live provider interoperability remain unverified. npm publication is not planned; build the library from source.

`@workers-workload-identity/client` provides type-safe Service Binding configuration and issuance RPC calls for a caller Worker. It preserves the authentication and authorization boundaries in the [requirements](./requirements.md), especially FR-02 and FR-03. The issuer applies the same validation and denial rules to callers that do not use the SDK.

## Context configuration is fixed at deployment

Here, context means the issuer-side **`this.ctx.props`**, not the caller's `ExecutionContext`, a Hono Context, or JWT claims.

Deployment sets `services[].props.clientId`, and Cloudflare passes it to the named issuer entrypoint. The SDK neither creates nor mutates runtime context and never sends client ID in the RPC argument. `defineIssuerBinding` constructs deployment configuration; it does not configure Cloudflare permissions or register a client. See [Cloudflare Context](https://developers.cloudflare.com/workers/runtime-apis/context/).

Types prevent missing configuration and incorrect calls. They do not stop a principal with binding-edit permission from selecting another client ID. That risk belongs to the deployment-permission trust boundary in the requirements and to live acceptance test A-04. Do not claim that the SDK proves caller identity.

## Initial functional requirements

| ID    | Requirement                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CL-01 | Export `defineIssuerBinding` from `@workers-workload-identity/client/config`. It accepts binding name, service name, and `props: { clientId }`, returns a Wrangler Service Binding fragment with `entrypoint: "IssuerRpc"`, and rejects unknown fields or invalid values at runtime. |
| CL-02 | Export `CallerProps`, `IssueRequest`, and `IssuerBinding` from a shared contract independent of Worker implementation, D1 schema, admin console, and private-key types. The issuer entrypoint implements the same contract, so type checking detects drift between them.             |
| CL-03 | Provide `createOidcClient(binding).issue({ aud })` while preserving the current `Promise<string>` RPC. Invoke the binding method with its original receiver.                                                                                                                         |
| CL-04 | Pass `aud` verbatim without trimming, lowercasing, or URL normalization. Accept no client ID, `sub`, lifetime, `alg`, `kid`, or arbitrary claim. Strictly reject JavaScript input that bypasses TypeScript.                                                                          |
| CL-05 | Validate that the response is a compact signed-JWT string no larger than 32 KiB. Shape validation does not verify signature, claims, or provider interoperability; verification remains the relying party's responsibility under the requirements.                                   |
| CL-06 | Classify invalid input, caller denial, audience denial, rate limit, issuance failure, transport failure, and invalid response through `OidcClientError.code`. Do not depend on custom Error properties surviving RPC.                                                                |
| CL-07 | Perform no automatic retry, JWT cache, or request sharing. Send every call to the issuer so client disablement and grant removal affect the next request.                                                                                                                            |
| CL-08 | Never log the JWT, raw RPC response, or the original remote exception message, stack, or cause. SDK-created errors retain only allowed public codes. Callers are not asked to log tokens either.                                                                                     |
| CL-09 | Provide Worker ESM without Node-only APIs or network fetch. The workspace exports TypeScript source, and `pnpm client:build` produces ESM bundles. npm publication is not planned.                                                                                                   |
| CL-10 | Communicate only through the existing Service Binding RPC. Provide no HTTP issuance URL, public fallback, or loopback API with dynamic props.                                                                                                                                        |

A local string type for `aud` is not an issuer allowlist. Per-request authorization remains authoritative after registration or grant changes. The client ID format is shared with `clientIdSchema`.

## API

Deployment-only code lives in a separate export. The returned object matches one item in `examples/caller.wrangler.jsonc`.

```ts
import { defineIssuerBinding } from "@workers-workload-identity/client/config";

const binding = defineIssuerBinding({
  binding: "OIDC_ISSUER",
  service: "oidc",
  props: { clientId: "example-caller-prod" },
});
// Add it to services: [binding] in deployment tooling.
```

The helper does not write files, inherit settings between environments, or register a client. Include its result explicitly in each environment's deployment configuration.

```ts
import { createOidcClient, type IssuerBinding } from "@workers-workload-identity/client";

interface Env {
  OIDC_ISSUER: IssuerBinding;
}

async function obtainAssertion(env: Env) {
  const oidc = createOidcClient(env.OIDC_ISSUER);
  return oidc.issue({ aud: "urn:example:receiver" });
}
```

Wrangler-generated types should describe the complete caller environment; the example shows only the SDK minimum. Pass the assertion to an internal exchange operation, never a browser or public HTTP response. Create the binding client in a request and do not retain it across requests.

## Public error codes

| Code                   | Meaning                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `invalid-request`      | SDK or issuer rejected the input                                               |
| `caller-denied`        | Invalid props, unknown caller, or disabled caller; details are hidden          |
| `audience-denied`      | Unknown or unauthorized audience; details are hidden                           |
| `rate-limited`         | Issuance-attempt limit exceeded                                                |
| `issuance-unavailable` | Configuration, storage, active-key, or signing failure; details are hidden     |
| `transport-error`      | Unclassified RPC exception or transport failure; original message is discarded |
| `invalid-response`     | Return value does not satisfy the shared assertion shape                       |

The issuer uses only public codes in RPC Error messages. The SDK maps allowed messages and converts everything else to `transport-error`. It never relies on remote `instanceof` or custom properties.

## Compatibility and non-goals

The RPC input is `{ aud, requestId? }`. Shared contracts, SDK, and issuer validate the optional UUID correlation ID, which is stored in the issuance audit. The issuer generates an ID when omitted. Reusing an ID still evaluates issuance on each call; the ID is neither a JWT claim nor caller authentication.

Cloud credential exchange, provider SDK adapters, relying-party JWT verification, admin APIs, generated audience types, timeouts, and cancellation are outside the initial SDK. Stopping a local wait does not prove remote issuance stopped, so the library cannot declare every failure safe to retry.

The success return stays compatible with the existing RPC, while old ad hoc exception text is normalized to the public codes. The early development version does not preserve internal error-string compatibility. A future breaking input or output change must test matched caller and issuer versions and document migration.

## Acceptance criteria

| ID     | Check                                                                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CL-T01 | Invalid props, missing client ID, forbidden RPC arguments, and a string URL transport fail TypeScript checks; expected failures are fixed in code.                                       |
| CL-T02 | A valid `{ aud }` is sent once and calls the original binding receiver once. An extra input field is rejected before RPC.                                                                |
| CL-T03 | All public errors and an unknown remote exception are tested. JWTs and sensitive remote messages do not survive in SDK errors, and no denial or failure is retried automatically.        |
| CL-T04 | Invalid and oversized responses are rejected. No assertion is cached; every call reaches RPC.                                                                                            |
| CL-T05 | In workerd, test SDK → named entrypoint → Policy D1 → signing → public JWKS verification. Verify immediate disable/grant removal, missing props, forged arguments, and no HTTP issuance. |
| CL-T06 | The deployment fragment matches the Wrangler sample. A real separate Worker with fixed props and A-04 remain beta gates; a local loopback does not pass them.                            |

Complete the [acceptance criteria](./acceptance.md) and live provider validation before the beta release; [Release status](../reference/release-status.md) lists the beta gate. SDK unit tests and local issuance do not establish AWS, Google Cloud, Claude API, or OpenAI API support.

## Distribution build

`pnpm client:build` generates ESM bundles and TypeScript declarations in `packages/client/dist/`, including a separate `/config` export. Distribution artifacts contain no unpublished workspace dependency and depend only on Zod. The root `pnpm build` also builds this package. Generated package metadata remains `private: true`. npm publication is not planned; callers build the library from source. Semantic versioning and an upgrade policy are not yet defined.

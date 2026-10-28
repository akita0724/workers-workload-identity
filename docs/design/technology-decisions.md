# Technology decisions

**Status:** Implemented. The choices below are based on primary sources checked on 2026-10-24, and the Workers and admin console follow them. Live provider acceptance and production deployment permissions remain unverified.

## Principles

Keep the issuer responsible only for caller identification, authorization, JWT signing, and public-key delivery. A separate Admin Worker serves the admin console and manages policy and audit data. Provider-specific credential exchange stays with the caller. The OSS core contains no organization-specific account IDs, role ARNs, or secrets. Signing algorithms and key storage are replaceable, but callers may never select an arbitrary algorithm at runtime. See [admin console](./admin-console.md) and [admin console frontend selection](./frontend-selection.md).

## Selected components

| Area                         | Initial choice                                                                                   | Rationale and boundary                                                                                            | Revisit when                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Runtime                      | Cloudflare Workers and TypeScript                                                                | Provides both Service Bindings and public HTTPS on one platform.                                                  | Porting the core to another runtime.                                                                      |
| Public HTTP                  | Hono                                                                                             | Explicitly defines discovery, JWKS, and `/admin/` forwarding to the Admin Worker and officially supports Workers. | The framework and forwarding layer must preserve the issuance boundary and create no HTTP issuance route. |
| Internal issuance            | Named `WorkerEntrypoint` RPC plus Service Binding `props`                                        | Reads `this.ctx.props.clientId` as privileged Cloudflare configuration; central CI is not required.               | Redesign if an untrusted principal can configure another caller's `props`.                                |
| JWT/JWK                      | `jose` plus Workers Web Crypto                                                                   | `jose` supports Workers and standard JOSE processing; Web Crypto supplies primitives.                             | workerd integration fails, or maintenance or licensing becomes unsuitable.                                |
| Admin console                | React and Vite SPA; TanStack Router and Query; Kumo, Tailwind CSS v4, i18next, and ECharts       | Supports policy lists, change diffs, key-job progress, English and Japanese text, and issuance charts.            | Re-evaluate TanStack Start if SSR or server functions become necessary.                                   |
| Admin API                    | Separate Admin Worker plus Hono                                                                  | Unifies authentication, RBAC, CSRF, and JSON contracts away from issuer endpoints.                                | Re-test every auth path when the server boundary changes.                                                 |
| Admin authentication         | Mutually exclusive passkey or Cloudflare Access adapter                                          | Shares one operator/RBAC model across either deployment choice.                                                   | Add another mechanism only behind the same interface and threat review.                                   |
| Passkeys                     | `@simplewebauthn/server` and `@simplewebauthn/browser`                                           | Avoids hand-written WebAuthn challenge and signature verification.                                                | Revisit if Workers-runtime compatibility or licensing becomes a problem.                                  |
| Input validation             | **Zod as a required runtime dependency**                                                         | Validates UI/API input, `ctx.props`, database rows, and environment configuration with shared schemas.            | Replacing it requires a schema, type, and error-handling migration plan.                                  |
| Caller and audience registry | Environment-specific Policy D1 as source of truth                                                | The admin console can update it and the issuer can check current authorization for every issuance.                | Compare stores only if availability and revocation-latency requirements remain intact.                    |
| Operators and passkeys       | Separate Admin D1                                                                                | The issuer cannot read operator credentials or sessions.                                                          | Preserve local RBAC even if authentication moves to an external IdP.                                      |
| Signing keys                 | One issuer Worker secret per key plus Key Registry D1                                            | The Admin Worker cannot alter JWKS; issuance and JWKS share public state.                                         | Use an external KMS when non-exportability or separate key administrators are required.                   |
| Rotation                     | Separate Rotation Controller Worker plus Cloudflare Workflows                                    | Supports admin console starts, long cache waits, retries, schedules, and isolation of the API token.              | Use a dedicated CI runner if Workers key generation or the Cloudflare API fails in live testing.          |
| Tests                        | `@cloudflare/vitest-plugin`, Vitest, and workerd integration tests                               | Exercises Service Bindings, Web Crypto, D1, and auth adapters in the Workers runtime.                             | Migrate when Cloudflare's recommended test stack changes.                                                 |
| Workspace                    | pnpm workspace plus Turborepo                                                                    | Makes package dependencies, task boundaries, caching, and order explicit.                                         | Revisit if the package count no longer justifies the overhead.                                            |
| Static analysis              | Oxlint, Oxfmt, and TypeScript                                                                    | Fast lint and format checks, with `tsc` responsible for types.                                                    | Rules are insufficient or tools conflict with the target runtime.                                         |
| Deployment                   | Controller uploads and deletes secrets and only reads deployments; Wrangler handles code updates | Separates secret staging from activation and checks each rotation gate.                                           | Finalize after API behavior and permission separation are proven.                                         |

[Hono Workers guide](https://hono.dev/docs/getting-started/cloudflare-workers), [TanStack Router](https://tanstack.com/router/latest/docs/overview), [TanStack Start](https://tanstack.com/start/latest/docs/framework/react/overview), [`jose` runtime support](https://github.com/panva/jose), [Zod](https://zod.dev/basics), [D1](https://developers.cloudflare.com/d1/worker-api/), [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)

## Module boundaries

`packages/domain-identity` owns pure caller, audience, and grant rules; `packages/domain-keys` owns key state and signing-key selection; and `packages/domain-operators` owns operators and RBAC. `packages/contracts` contains only publishable Zod input and output contracts. Each Worker contains its own use cases and Cloudflare, Hono, JOSE, or D1 code; only the issuer separates them into `src/application` and `src/adapters`. The React app depends only on `contracts`. See [Repository structure](./repository-structure.md).

The repository includes dependency boundaries, domain rules, issuer issuance and public metadata/JWKS paths, `/admin/` forwarding, admin functions, rotation code, and sample deployment configuration. Production acceptance and live provider validation remain incomplete. `IssueRequest` accepts the requested `aud` and an optional UUID `requestId` for audit correlation. `clientId` is not a method argument; the Cloudflare adapter extracts it from `this.ctx.props`. The domain use case accepts a caller ID, but the adapter fixes its origin. The issuer's public Hono handler cannot reference the signing use case and exposes no HTTP issuance route. The Admin Worker has neither signing secrets nor issuance RPC. Privileged key operations belong to the Rotation Controller. See [Public host and root path](./domain-routing.md) and [Rotation Controller](./rotation-controller.md).

## Policy model

The initial Policy D1 client, audience, and grant rows map to this conceptual model at the read boundary. The JSON is fictional and operational records must not be committed.

```json
{
  "clients": {
    "example-caller-prod": {
      "subject": "service:example-caller:prod",
      "enabled": true,
      "audiences": ["urn:example:external-service"]
    }
  },
  "audiences": {
    "urn:example:external-service": {
      "algorithm": "RS256",
      "tokenLifetimeSeconds": 300
    }
  }
}
```

Zod is required at runtime. Use `z.strictObject(...)`, enums, bounds, and cross-field refinements to reject unknown fields, duplicate IDs, an empty `aud`, unknown algorithms, out-of-range lifetimes, and reused `sub` values. Validate current database values on every issuance and fail closed. Only schemas and fictional examples belong in the public repository; real client and audience policy stays in Policy D1.

The audience selects the algorithm to pin relying-party compatibility. This does not let the caller choose `alg`. See [signing algorithms and key lifecycle](./key-management.md) for each relying party.

## Key-storage comparison

| Option                        | Benefits                                                   | Constraints                                                                                                            | Decision                                                                           |
| ----------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Worker secret binding         | No extra service and easy to scope to the issuer.          | Updates create a Worker version and deployment; the running Worker can read the value; each variable has a size limit. | **Initial choice.** One secret per key, with multiple deployments during rotation. |
| Cloudflare Secrets Store      | Central account management and Worker `get()` access.      | Open beta as of 2026-10-24; introduces separate permission and binding management.                                     | Possible later adapter after stability and production evaluation.                  |
| External KMS `Sign`           | Non-exportable keys and separate administration and audit. | Network latency and availability, cloud dependence, and a bootstrap credential problem.                                | Adapter for higher key-protection requirements.                                    |
| Private keys in KV, D1, or R2 | Easy dynamic updates.                                      | Treats cryptographic keys as ordinary stored data.                                                                     | Rejected.                                                                          |

[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) create a new Worker version when updated, and an ordinary secret update deploys that version immediately. Rotation does not use Wrangler or a separate version upload: the Rotation Controller calls the Secrets API (`PUT …/secrets`), which creates and deploys a new issuer version, and then only reads deployments and versions to verify that the new secret is bound in the version serving 100% of traffic. See [Rotation Controller](./rotation-controller.md) and [key management](./key-management.md). Worker variables have a 5 KB per-value limit, so do not pack several private keys into one JSON secret. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Secrets Store](https://developers.cloudflare.com/secrets-store/).

## Rejected for the initial release

- Hono JWT middleware: useful for relying-party verification, but not a substitute for issuer policy or key state.
- Node-specific issuers such as `jsonwebtoken`: prefer `jose` and Workers Web Crypto.
- A public token endpoint or provider exchange inside the issuer: out of scope. Automatic rotation is enabled only for relying parties whose cache and acceptance behavior has been tested.

`@oidfed` will be re-evaluated as a separate extension only if a relying party requires OpenID Federation 1.1; it is not adopted as a replacement for JWT issuance.

## Versions and OSS readiness

Most direct dependencies are pinned to exact versions checked against the npm registry `latest` on 2026-10-24; `apps/admin-ui` uses caret ranges for its UI libraries and test tools, and the shared lockfile fixes installed versions. Confirm the peer ranges of Vitest 5 and `@cloudflare/vitest-plugin`, and of Vite 8 and the React plugin. Confirm library licenses, update policy, and vulnerability handling before the beta release. Runtime and provider compatibility is established by integration and live tests, not dependency selection alone. Never hard-code Cloudflare or cloud-provider account IDs in SDKs or examples. Claim support only for providers and algorithms with recorded live-test evidence.

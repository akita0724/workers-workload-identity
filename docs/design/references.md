---
sidebar:
  label: Primary references
---

# Specifications and primary sources

**Status:** Reference material; checked on 2026-10-24. Recheck the linked specifications for changes during implementation and before the beta release.

## Standards

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) — The general ID Token and Provider model. This project is not a complete implementation; it uses only the metadata and JWKS shape.
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html) — OP metadata and discovery.
- [OpenID Federation 1.1](https://openid.net/specs/openid-federation-1_1-final.html) — Trust chains. Outside the scope of the initial release.
- [RFC 7515: JSON Web Signature](https://www.rfc-editor.org/rfc/rfc7515.html) — JWS compact serialization and signatures.
- [RFC 7518: JSON Web Algorithms](https://www.rfc-editor.org/rfc/rfc7518.html) — `RS256`, `ES256`, and cryptographic JWK parameters.
- [RFC 7519: JSON Web Token](https://www.rfc-editor.org/rfc/rfc7519.html) — JWT claims and NumericDate.
- [RFC 7517: JSON Web Key](https://www.rfc-editor.org/rfc/rfc7517.html) — JWK/JWKS.
- [RFC 7521: Assertion Framework for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc7521.html) — General use of assertions as authorization grants or client authentication; applicable when a relying party adopts it.
- [RFC 7523: JWT Profile for OAuth 2.0 Client Authentication and Authorization Grants](https://www.rfc-editor.org/rfc/rfc7523.html) — The JWT bearer assertion profile; follow it when the relying party's exchange contract explicitly applies it.
- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.html) — General token-exchange semantics. Providers add their own constraints, so compatibility requires live testing.
- [RFC 8725: JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html) — Audience, algorithms, and separation by purpose.
- [RFC 9068: JWT Profile for OAuth 2.0 Access Tokens](https://www.rfc-editor.org/rfc/rfc9068.html) — A candidate when using access tokens for custom APIs.

## Cloudflare

- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) — Calls between Workers.
- [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/) — Account-wide and per-Worker editing and deployment permissions.
- [Context (`ctx.props`)](https://developers.cloudflare.com/workers/runtime-apis/context/) — Binding configuration `props`, their authenticity, and loopback exceptions.
- [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) — Cryptographic APIs in Workers.
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) — Secret bindings.
- [Worker Secrets API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/) — Adding or updating a script secret, which the Rotation Controller uses to upload keys.
- [Worker Deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/) — Deployment of a specified version. The Rotation Controller does not call it.
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) — Long-running key rotation jobs.
- [Workflow schedules](https://developers.cloudflare.com/workflows/build/trigger-workflows/) — Scheduled execution.
- [Workflow sleep/retry](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) — Waiting for caches and retrying.
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — Size limits for environment variables, including secrets.
- [Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/) — Versions and gradual deployments.
- [Gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/) — Differences between versions serving traffic.
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/) — Current infrastructure for testing within the runtime.
- [Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/) — Account-level secret storage. Open beta.
- [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/) — Management data and transactions.
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) — Primary reads and replica consistency.
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) — Signature, issuer, and audience checks.
- [Cloudflare Access application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) — Differences between a human user's `sub` and a service token.

## Relying parties

- [AWS: IAM OIDC provider requirements](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html) — Discovery/JWKS and individual claims.
- [AWS: STS AssumeRoleWithWebIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html) — Exchange for temporary credentials.
- [AWS: IAM OIDC condition keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html) — `aud`/`sub` restrictions.
- [AWS: API Gateway JWT authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html) — JWKS caching and related behavior.
- [Google Cloud: Workload Identity Federation with external OIDC](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers) — Audience, signature formats, and JWKS.
- [Claude API: Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) — Issuers, rules, service accounts, and token exchange.
- [Claude API: WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference) — JWTs, algorithms, JWKS caching, and the exchange API.
- [OpenAI API: Workload identity federation](https://developers.openai.com/api/docs/guides/workload-identity-federation) — Providers, service account mapping, JWKS, and current constraints.
- [OpenAI API: Token exchange](https://developers.openai.com/api/reference/workload-identity-federation) — JWT exchange, required claims, and restrictions on unsupported issuers.
- [Microsoft Entra: Workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation) — Issuer/subject/audience trust.
- [Microsoft Entra: Federation considerations](https://learn.microsoft.com/en-us/azure/active-directory/develop/workload-identity-federation-considerations) — Operational constraints.

## Libraries

- [Hono Cloudflare Workers guide](https://hono.dev/docs/getting-started/cloudflare-workers) — Framework for public HTTP routes.
- [Hono JSX](https://hono.dev/docs/guides/jsx) — Server rendering option evaluated for comparison.
- [TanStack Router](https://tanstack.com/router/latest/docs/overview) — Typed navigation for the admin interface.
- [TanStack Query](https://tanstack.com/query/latest) — API state and refetching after mutations.
- [TanStack Start](https://tanstack.com/start/latest/docs/framework/react/overview) — An option to evaluate if SSR becomes necessary.
- [Workers SPA serving](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/) — Routing control for static assets and APIs.
- [Hono CSRF middleware](https://hono.dev/docs/middleware/builtin/csrf) — Check applicability and supplement as needed.
- [`jose`](https://github.com/panva/jose) — JOSE/JWT implementation with Workers support.
- [Zod](https://zod.dev/basics) — Schema validation for admin input, runtime configuration, and DB boundaries.
- [Turborepo configuration](https://turborepo.dev/docs/reference/configuration) — Workspace tasks and caching.
- [Turborepo boundaries](https://turborepo.dev/docs/reference/boundaries) — Dependency boundaries between packages (experimental).
- [Vitest projects](https://vitest.dev/guide/projects) — Multiple test configurations in a monorepo.
- [Oxlint](https://oxc.rs/docs/guide/usage/linter) — Oxc static analysis.
- [Oxfmt](https://oxc.rs/docs/guide/usage/formatter) — Oxc formatting.
- [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server) — Passkey registration and authentication verification.
- [SimpleWebAuthn browser](https://simplewebauthn.dev/docs/packages/browser) — Browser-side WebAuthn calls.
- [`@oidfed`](https://github.com/Dahkenangnon/oidfed) — For OpenID Federation. Re-evaluated as a separate extension only if a relying party requires OpenID Federation 1.1; not a replacement for JWT issuance.

## Documentation publishing

- [Blume: Markdown docs on GitHub Pages](https://useblume.dev/guides/markdown-docs-github-pages) — Static builds and the base path for project Pages.
- [Blume: Static and server documentation](https://useblume.dev/guides/static-vs-server-documentation) — Feature availability on GitHub Pages.
- [GitHub Pages: Custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) — Actions source and artifact deployment.

Select additional libraries only after verifying their behavior on Cloudflare Workers, maintenance status, licenses, and dependencies.

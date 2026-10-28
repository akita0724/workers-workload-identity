---
sidebar:
  label: Repository structure
---

# Repository structure and dependency boundaries

**Status:** Implemented. Worker code, D1 schemas, sample deployment configuration, the admin console, and the caller SDK are present. Production acceptance and live provider interoperability remain incomplete.

## Workspace

| Workspace                   | Clean Architecture layer | Responsibility                                                                                     |
| --------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `packages/domain-identity`  | Domain                   | Caller, subject, audience, grant, and issuance decision; no external dependency                    |
| `packages/domain-keys`      | Domain                   | Signing algorithms, key states, JWKS visibility, and active-key uniqueness; no external dependency |
| `packages/domain-operators` | Domain                   | Operators, roles, and authentication modes; no external dependency                                 |
| `packages/contracts`        | Interface contract       | Browser-safe Zod DTOs; exports no secret, DB row, or Cloudflare binding type                       |
| `apps/issuer-worker`        | Application + adapters   | Issuance use case and ports, Service Binding RPC, public Hono routes, D1, JOSE, Worker secrets     |
| `packages/client`           | Caller SDK               | RPC client from shared contracts and a deployment-time Service Binding helper                      |
| `apps/admin-worker`         | Application + adapters   | Admin API (Hono), passkey/Access authentication, RBAC, D1, SPA delivery                            |
| `apps/rotation-worker`      | Application + adapters   | Key generation and activation, Cloudflare API, Workflows, Key Registry D1                          |
| `apps/admin-ui`             | Presentation             | React admin console; depends only on `contracts` within the workspace                              |
| `apps/smoke-worker`         | Test application         | Issuance caller and staging-check API                                                              |
| `apps/smoke-receiver`       | Test application         | Independent relying-party Worker that verifies issued JWTs                                         |
| `apps/docs`                 | Documentation            | Blume configuration and dependencies; content is in root `docs/`                                   |

Only `apps/issuer-worker` separates its code into `src/application` (use cases and ports) and `src/adapters` (D1 and signing implementations). The issuer use case depends on policy, key, signer, clock, and ID-generation ports. `apps/admin-worker` and `apps/rotation-worker` keep their source files flat in `src/`. Domain packages import none of the Worker code. Workers communicate through declared Service Binding RPC contracts rather than TypeScript imports. `contracts` contains only shapes safe to bundle into the admin console.

```text
client ──→ contracts
admin-ui ──→ contracts
issuer-worker ──→ domain-identity, domain-keys, contracts
issuer-worker (dev) ──→ client
admin-worker ──→ domain-identity, domain-keys, domain-operators, contracts
rotation-worker ──→ domain-identity, domain-keys, contracts
smoke-worker ──→ client
domain-* ──→ no external package
```

Turborepo `boundaries` checks undeclared workspace imports and cross-package relative imports, using `domain`, `contract`, `adapter`, `client`, `ui`, and `docs` tags to constrain dependency direction. Because the feature is experimental, TypeScript checks and review remain necessary. pnpm `workspace:*` links only declared dependencies.

## Development tools

- Turborepo orders package tasks and manages a local cache. Remote caching is disabled.
- Vitest covers pure domain unit tests. Issuer runtime integration uses `@cloudflare/vitest-plugin` and workerd. The SDK has unit and type-level rejection tests. If several configurations are required, use current Vitest `test.projects`, not `vitest.workspace`.
- Oxc provides Oxlint and Oxfmt. Oxc transformation is not used in authentication or signing at runtime. TypeScript checks types; workerd tests Worker behavior.
- Most direct dependencies are pinned to exact versions, checked against the registry `latest` on 2026-10-24. `apps/admin-ui` uses caret (`^`) ranges for its UI libraries (Kumo, Tailwind CSS, i18next, ECharts, and others) and its test tools; `pnpm-lock.yaml` fixes the installed versions. Reassess licenses, vulnerabilities, and runtime compatibility before the beta release.

Run `pnpm boundaries`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm docs:validate`, and `pnpm docs:build`.

# Issuer Worker

The issuer signs workload assertions (short-lived JWTs) for callers. It is deployed as `oidc` by default.

## Public HTTP

The public HTTP handler serves only:

- `/.well-known/openid-configuration` (discovery metadata) and
- `/jwks.json` (the public JWKS).

It also relays `/admin` (308 redirect to `/admin/`) and `/admin/*` to the optional `ADMIN` Service Binding, so the admin console can share the issuer's host. Requests whose origin differs from the origin of `ISSUER_URL` get 404. If `ISSUER_URL` has a path, routes are served under that path. There is no HTTP endpoint for issuing assertions.

## Issuance

Assertions are issued only through the named RPC entrypoint `IssuerRpc`, reached over a Service Binding. The caller's client ID comes from the binding's `ctx.props`, never from the request. `IssuerRpc` implements the `IssuerBinding` contract from `packages/contracts`, so it shares its input, return value, and public error codes with the caller SDK (`packages/client`).

`src/application/issue-token.ts` holds the issuance use case and its ports for persistence, signing, and time. It requires a registered, enabled client with a grant for the requested audience, and rejects an audience lifetime outside 1–300 seconds or an algorithm without an active signing key. Issuance policy comes from `packages/domain-identity` and key selection from `packages/domain-keys`. `src/index.ts` contains the RPC entrypoint and public HTTP handler, and `src/adapters` contains the D1, Worker secret, and JOSE implementations.

Each RPC call is rate limited per client (`RATE_LIMIT_PER_MINUTE`) and recorded in the issuance audit log before a signed assertion is returned. If the audit record cannot be written, the assertion is withheld. An hourly cron trigger deletes expired rate-limit rows, issuance audit events older than 30 days, old metrics, and expired reservations.

## Test

```sh
pnpm --filter @workers-workload-identity/issuer-worker test
```

The tests run in workerd and cover issuance, the JWKS, disabled clients and removed grants taking effect, rejection cases, and audit failures. The auxiliary caller binding in the test configuration exists only for tests; the public handler never calls issuance.

Production deployment, account-level permissions for Service Binding configuration, and validation with external relying parties are not finished.

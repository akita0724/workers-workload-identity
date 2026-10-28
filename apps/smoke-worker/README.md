# smoke-worker

A test caller Worker used only in staging and the Worker-to-Worker E2E tests. Never deploy it alongside a production application.

It holds a Service Binding to the issuer's `IssuerRpc` entrypoint (`OIDC_ISSUER`), requests assertions with the caller SDK (`packages/client`), and sends them to the test relying party (`apps/smoke-receiver`). Every route requires `POST` with `Authorization: Bearer <SMOKE_TOKEN>`, where the `SMOKE_TOKEN` secret is at least 32 characters. Responses contain only verification results, never an assertion.

| Route       | What it checks                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/check`    | Issues an assertion, verifies it against the public JWKS, and confirms that an ungranted audience is denied. With `{"mode":"disabled"}`, confirms that a disabled caller gets `caller-denied`.                               |
| `/e2e`      | Runs one named scenario against the relying party: `valid`, `missing-token`, `malformed-token`, `tampered-token`, `wrong-audience`, `wrong-subject`, `wrong-issuer`, `expired-token`, `unique-tokens`, or `audience-denied`. |
| `/keys`     | Lists signing key IDs and states and rotation runs through the Rotation Controller (`ROTATION`).                                                                                                                             |
| `/rotation` | Starts an RS256 rotation through the Rotation Controller (used to create the first staging key).                                                                                                                             |

## Run the E2E tests locally

From the repository root:

```sh
pnpm test:e2e
```

This runs the issuer, this caller, and the relying party as separate Workers in workerd with local D1 databases and generated test keys. No Cloudflare account is needed. The tests cover disabling and re-enabling a caller, removing a grant, unknown callers and bindings without identity props, missing or inactive signing keys, the shared rate limit, algorithm allowlists, request attempts to override identity or audience, the probe secret, and the absence of issuance over public HTTP.

Against a deployed staging environment, `pnpm staging:test` calls the same routes. See the [deployment guide](../../docs/guides/deployment.md).

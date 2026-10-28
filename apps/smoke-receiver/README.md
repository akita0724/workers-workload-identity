# smoke-receiver

A test relying-party Worker used only in staging and the Worker-to-Worker E2E tests. Never deploy it alongside a production application.

It accepts `GET` requests with `Authorization: Bearer <JWT>` on three routes:

| Route           | Expected `aud`                    | Expected `iss`              |
| --------------- | --------------------------------- | --------------------------- |
| `/resource`     | `SMOKE_AUDIENCE`                  | `ISSUER_URL`                |
| `/short-lived`  | `SMOKE_AUDIENCE` + `:short-lived` | `ISSUER_URL`                |
| `/wrong-issuer` | `SMOKE_AUDIENCE`                  | `ISSUER_URL` + `/untrusted` |

For each request it fetches `${ISSUER_URL}/jwks.json` through the `ISSUER_METADATA` Service Binding (the issuer's public HTTP handler, without access to issuance, private keys, or D1). It then verifies the signature, `iss`, `sub` (`SMOKE_SUBJECT`), `aud`, and lifetime. It accepts only RS256, requires `iss`, `sub`, `aud`, `iat`, `nbf`, `exp`, and `jti`, allows no clock skew, and rejects a lifetime over 300 seconds.

Responses are `{"ok":true}` on success, 401 `{"error":"invalid-token"}` on any verification failure, and 503 `{"error":"verification-unavailable"}` when the JWKS cannot be fetched. Other paths and methods get 404.

Configuration (set by the staging and E2E setup):

- `ISSUER_METADATA`: Service Binding to the issuer Worker
- `ISSUER_URL`: the issuer URL
- `SMOKE_AUDIENCE`: the audience granted to the smoke caller
- `SMOKE_SUBJECT`: the smoke caller's subject

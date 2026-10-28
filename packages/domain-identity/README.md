# @workers-workload-identity/domain-identity

Dependency-free issuance policy rules. `authorizeIssuance(client, audience)` allows issuance only when the client is enabled and has a grant for the requested audience, and returns the client's fixed subject; otherwise it returns the reason `client-disabled` or `audience-not-granted`. The issuer Worker calls it before selecting a signing key. This package has no Cloudflare, Hono, D1, JOSE, or browser dependencies.

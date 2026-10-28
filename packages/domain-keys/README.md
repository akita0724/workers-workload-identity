# @workers-workload-identity/domain-keys

Dependency-free signing key rules. A key has an algorithm (`RS256` or `ES256`) and a state: `prepared`, `active`, `verifying`, or `removed`. `isJwksVisible(key)` is true for every state except `removed`. `selectActiveKey(keys, algorithm)` returns the single `active` key for the algorithm, returns nothing if there is none, and throws if more than one is active. The issuer Worker uses these rules to choose a signing key. This package has no Cloudflare, Hono, D1, JOSE, or browser dependencies.

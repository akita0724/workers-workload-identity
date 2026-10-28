# @workers-workload-identity/contracts

Browser-safe Zod schemas and TypeScript types shared by the Workers, the admin console, and the caller SDK. It defines the issuance RPC contract (`IssuerBinding`, `issueRequestSchema`, public `IssuanceErrorCode` values, and `callerPropsSchema` for the Service Binding's `ctx.props`), the assertion shape check, issuer configuration, and the admin API input schemas. It never contains database rows, secrets, or private bindings. A change to a schema used by the RPC, discovery, or JWKS is a protocol change.

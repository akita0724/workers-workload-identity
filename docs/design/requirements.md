---
sidebar:
  label: Requirements
---

# Workload identity assertion issuer requirements

**Status:** Partially implemented. The initial implementation passes local and staging validation. Production acceptance and live provider validation remain pending.

## 1. Purpose and assumptions

Enable internal services running on Cloudflare Workers to obtain short-lived, signed JWTs with unique service identities when accessing external services, including AWS, without distributing permanent cloud access keys. Usage is not limited to AWS. Custom APIs validate the JWT directly; services with cloud identity federation exchange the JWT for temporary credentials.

The OSS project name is `workers-workload-identity`. The default issuer Worker name is `oidc`, and the issuer URL is `https://oidc.<WORKERS_SUBDOMAIN>.workers.dev`. An example custom domain is `https://oidc.example.com`. Staging has a separate issuer, keys, client registrations, and relying-party trust configuration. Operators choose the staging domain. The public OSS implementation must make the issuer URL configurable.

Below, “Required” defines acceptance criteria for the initial release, “Recommended” defines targets for the initial release, and “Future” identifies candidates explicitly outside its scope.

## 2. Terminology and boundaries

| Term               | Meaning                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| caller             | A Cloudflare Worker that requests issuance from the issuer                                                                |
| issuer             | A dedicated Worker that signs JWTs and serves public metadata and public keys                                             |
| client ID          | An immutable identifier assigned by the issuer to each caller                                                             |
| subject (`sub`)    | A service ID that is unique within an environment, never reused, and identified by relying-party policies                 |
| audience (`aud`)   | The intended relying party or exchange service for a token                                                                |
| workload assertion | A service identity JWT issued by the issuer. It must not be treated as an end-user ID token or a general API access token |
| relying party      | A custom API that validates JWTs, or a cloud token exchange service                                                       |

A Cloudflare Service Binding provides an internal route from caller to issuer. When Binding `props` are configured for a specified named RPC entrypoint, the issuer reads them through `this.ctx.props`. Cloudflare states that it controls permission to configure these values; the initial release uses this as the basis for caller authentication. The presence of a Binding alone must not be assumed to pass the Worker name automatically. [Cloudflare Context: `ctx.props`](https://developers.cloudflare.com/workers/runtime-apis/context/)

Type-safe Binding configuration and the RPC library for callers are defined in the [caller library requirements](./client-library.md). If they conflict, the authentication, authorization, and issuance policies in this document take precedence.

## 3. Scope

### Required

- A dedicated issuer Worker and public HTTPS domain.
- An internal issuance API using Service Bindings. Issuance methods must not be callable from the internet.
- Per-caller Service Binding `props` and issuer-side registration data: client ID, fixed `sub`, allowed `aud` set, and enabled/disabled status.
- Caller identification through `ctx.props`, issuance policy evaluation, and JWT signing.
- Publication of the public key set and metadata required for compatibility.
- A validation profile for custom APIs and live interoperability testing with AWS, Google Cloud, Claude API, and OpenAI API. Record success, unsupported, and unverifiable outcomes separately for each target, and mark only successful targets as supported.
- Operational procedures for key rotation, shutdown, and auditing.
- Server-side key generation and rotation initiation from the admin console. Automatic rotation limited to validated relying parties.
- An independent admin console and API. Mutually exclusive operator authentication through passkeys or Cloudflare Access, with shared RBAC.
- Runtime validation of administrative input, configuration, and D1 query results using Zod.

### Out of scope

- Human login, consent screens, authorization codes, user information, user sessions, and password management.
- OpenID Federation 1.1 entity statements, trust anchors, and trust chains in the initial release.
- AWS/GCP/Azure SDKs within the issuer or credential exchange logic for individual provider APIs.
- A public general-purpose token issuance API, caller self-registration, or arbitrary `sub`/`aud`/TTL selection.
- Enforcing JWT revocation lists across all relying parties. The design assumes short-lived JWTs and relying-party trust configuration; operational requirements address the limits of emergency shutdown.

## 4. Functional requirements

### FR-01 Caller registration and permissions

Authorized operators must be able to register, update, and disable a unique client ID, fixed `sub`, and allowed `aud` set for each caller through a dedicated admin console. The environment-specific Policy D1 is the source of truth for registrations. Once assigned, a `sub` must never be reused for another service. A caller with multiple relying parties may have multiple allowed `aud` values, but issued JWTs should generally contain a single `aud` value. The admin API must require operator authentication and RBAC on all Admin Worker routes except the limited routes needed before authentication. It must not provide an external self-registration API.

Registration data and relying-party IAM/federation configuration are separate. **The issuer needs allowed audiences for each caller, not connector configuration for each provider API.** The relying party must configure the trusted issuer, `aud`, `sub`, and permissions. Configuration follows the relying party’s trust domains, roles, and providers; it is not created for each HTTP request.

### FR-02 Caller authentication through `ctx.props`

The caller’s Wrangler Service Binding configuration must define a dedicated named issuance entrypoint and fixed `props: { "clientId": "..." }`. The issuer obtains the client ID exclusively from `this.ctx.props.clientId` in the RPC entrypoint. It must not accept caller IDs from RPC arguments, HTTP headers, or JWT claims. Requests with a missing, malformed, unregistered, or disabled `clientId` must be rejected. The issuer retrieves the fixed `sub` and allowed `aud` values from registration data.

`props` is authorization context configured on the Binding, not a secret or automatic proof of Worker identity. Service Bindings target Workers in the same Cloudflare account, but **account membership and permission to edit or deploy Workers are different**. Excluding principals outside the account does not prevent caller impersonation if an untrusted principal can configure an issuance Binding with an arbitrary `clientId`. Centralized CI is not required. Inventory the effective permissions of organization-approved administrators, CI tokens, and Worker editors, and include every principal that can change a `clientId` within that client’s trust boundary. If a principal must not issue tokens as another client, do not enable issuance until separation of deployment permissions and Binding configuration paths has been demonstrated. Cloudflare documentation describes both permission to configure `props` and caller-side Binding configuration, so verify actual rejection behavior in a live test using the intended permission setup. Because `ctx.exports` loopback bindings allow callers to specify `props` dynamically, public HTTP handlers must not invoke the issuance entrypoint through loopback, and RPC stubs must not be passed to untrusted code. [Cloudflare Context: props and Loopback](https://developers.cloudflare.com/workers/runtime-apis/context/), [Workers Permissions](https://developers.cloudflare.com/workers/authorization/workers/), [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)

### FR-03 Issuance policy

Issuance API input is limited to the requested `aud` and an optional tracking request ID. The issuer determines `sub` from the registration associated with `ctx.props.clientId`, checks that `aud` exactly matches an allowed value, and selects the TTL and signing key. It must not accept arbitrary claims, `sub`, signing algorithms, `kid`, or expiration times as input. It must not issue tokens for disabled clients, unauthorized `aud` values, or inconsistent registrations.

### FR-04 Issued JWTs

**RS256 is the required default** signing algorithm. **ES256 may be enabled per audience after live validation with the relying party.** RS256 keys must use RSA with at least 2048 bits; the implementation fixes RSA keys at 3072 bits. ES256 keys must use P-256. The JOSE header must contain the selected `alg` and a unique `kid`. Reject `none`, symmetric-key algorithms, unregistered `kid` values, and mismatches between `kid`, key type, and algorithm. Callers cannot select `alg`; the issuer’s audience policy selects it. The following payload claims are required. See [signing algorithms and key lifecycle](./key-management.md).

| claim | Value                                                                    |
| ----- | ------------------------------------------------------------------------ |
| `iss` | The fixed HTTPS issuer URL for the environment, compared by exact match  |
| `sub` | The immutable service ID determined by the issuer from registration data |
| `aud` | A single relying party authorized by the issuer                          |
| `iat` | Issuance time as a NumericDate                                           |
| `nbf` | Start of validity as a NumericDate                                       |
| `exp` | Expiration time as a NumericDate                                         |
| `jti` | A random ID unique to each issuance                                      |

The initial validity limit is **5 minutes**, with shorter durations available to meet relying-party requirements. Callers must not be allowed to request longer validity. The initial release does not issue `azp`, because it affects AWS `aud` evaluation. Do not include personal information, confidential data, or unmanaged claims that imply permissions. JWTs are bearer credentials and must remain confidential in subsequent transport and logs. [AWS handling of `azp`/`aud`](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)

### FR-05 Public metadata and keys

Serve `GET /.well-known/openid-configuration` and `GET /jwks.json` over public HTTPS. `issuer` must exactly match the JWT `iss`, and `jwks_uri` must be an HTTPS URL controlled by the same operator. JWKS must contain only public keys; it must not expose private keys, symmetric keys, or internal registration data. Algorithms and claims listed in metadata must match the implementation. When listing multiple algorithms, verify that the target relying parties can process a mixed JWKS.

**Standards conformance caveat:** The metadata field `response_types_supported: ["id_token"]` is present for AWS IAM compatibility; it does not mean the issuer provides authorization flows or ID Tokens. The metadata does not meet OIDC Discovery's required fields and cannot support relying parties that require complete OP metadata. Compatibility with each provider, including AWS, remains unverified until its required fields and token exchange are tested. [AWS required fields](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html), [OIDC Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html)

### FR-06 Use by relying parties

The issuer does not know the relying-party type. The caller or a separate small adapter passes the JWT to services such as AWS STS `AssumeRoleWithWebIdentity`, Google Cloud Workload Identity Federation, Claude API Workload Identity Federation, or OpenAI API Workload Identity Federation. Exchange procedures and required relying-party IDs vary by provider. The issuer-signed JWT must not be used directly as a bearer credential for each API. Custom APIs validate the JWT signature, `iss`, single `aud`, allowed `sub`, timestamps, and allowed algorithm. Apply least privilege on the relying party; token issuance alone does not grant access. See the [provider validation plan](./provider-validation.md).

Presenting a JWT directly to a custom API as a bearer credential requires different acceptance and validation rules from cloud token exchange assertions. Define a separate profile for direct API use and do not share audiences. Adopt the JWT access token profile in [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html) if needed. To prevent confusion between token types, require at least strict `aud` validation and purpose-specific validation rules. [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)

### FR-07 Errors and observability

Issuance failures return error codes that callers can classify, without exposing details such as unknown clients. Logs and traces record timestamps, internal request IDs, client IDs, `aud` identifiers, outcomes, latency, and key IDs. They must not record JWT contents, issuer private keys, or exchanged cloud credentials. Monitor token issuance counts, rejection counts, metadata/JWKS error rates, and key rotation status. Operators define observability data retention periods.

### FR-08 Admin console, authentication, and auditing

The admin console provides listing, search, creation, updates, and disabling for callers, audiences, and grants; Service Binding configuration guidance; key status and rotation records; operators and their credentials; and audit logs. A separate relying-party setup checklist for AWS, Google Cloud, Claude API, and OpenAI API was removed and is not implemented; relying-party confirmations are recorded per audience instead. The Admin Worker is separate from the public issuer Worker and holds no signing private keys. See [admin console, authentication, and operational requirements](./admin-console.md).

Production operator authentication must use exactly one configured mode: **passkey** or **Cloudflare Access**. Authentication adapters return a common operator principal, and authorization is enforced consistently outside the adapters. Do not automatically make someone an administrator merely because they passed Access or were the first visitor. Register the initial administrator through a bootstrap procedure tied to deployment permissions. Audit administrative operations with the actor and non-confidential before/after differences. Record policy change audits in Policy D1 and operator action audits in Admin D1.

At issuance, the issuer reads policies from the Policy D1 primary so that client disabling and grant removal take effect on the next issuance. Keep operators, passkeys, and sessions in Admin D1, and do not give the issuer an Admin D1 Binding. Record policy updates and their audit events in the same Policy D1 transaction, and reject conflicting updates. Use Zod to validate admin API input, `ctx.props`, environment configuration, and database rows at boundaries, rejecting unknown fields and invalid combinations.

### FR-09 Key generation from the admin console and automatic rotation

`security-admin` must be able to generate new keys using allowed algorithms; plan, approve, start, and stop rotations; and inspect progress and failures through the admin console. Do not expose private keys or Cloudflare Worker update tokens to the admin console or Admin Worker. An independent Rotation Controller generates keys server-side, registers them as issuer Worker secrets, and records public JWKs and key states in Key Registry D1, which the Admin Worker cannot write to. The issuer reads the Key Registry D1 primary to serve JWKS and select issuance keys. Private keys must not be stored in any D1 database. See [Rotation Controller](./rotation-controller.md).

Scheduled rotation is disabled by default and may be enabled only after live verification of the target relying party’s JWKS caching, acceptance of mixed keys, and successful exchanges. Automatic execution must retain every gate: publish the new key in advance, deploy secrets to all Worker versions, wait, switch, and retire the old key. If observations are insufficient, continue issuing with the old key, stop the job, and send a notification.

Operators define a transition period for each algorithm. From publication of the new key until retirement of the old key, JWKS contains both public keys. New tokens use the old key before the switch and only the new key afterward. Retain the old public key until the last JWT issued with it expires. Follow the [key lifecycle](./key-management.md#public-key-transition-period) for the minimum transition period and handling of postponements.

## 5. Security requirements

- **SR-01 Trust boundary:** Public HTTP handlers must not be able to invoke issuance. The dedicated issuance RPC entrypoint uses `this.ctx.props.clientId` as the sole caller identifier and rejects impersonation through arguments. Public handlers must not make loopback calls to issuance.
- **SR-02 Separation of permissions:** Restrict permission to configure or change `props` and issuance Bindings to principals approved by issuer administrators. Centralized CI is only one implementation option. Verify effective permissions for account administrators, per-Worker editors, and API tokens. Do not enable issuance in environments where untrusted principals can deploy another client’s `props.clientId`. After the Controller submits a generated private key to the Cloudflare API, configure it so that only the issuer can use the key at runtime. Do not share keys across development, staging, and production.
- **SR-03 Key protection:** Load issuer signing private keys at runtime from Cloudflare Worker secrets or equivalent secret bindings. Do not place real keys in source code, `wrangler` configuration, persistent Workflow state, D1, logs, or test fixtures. Validate key formats and Web Crypto compatibility during implementation.
- **SR-04 Exact policy matching:** `sub` is fixed, and `aud` requires an exact match. Do not allow wildcards or URL prefix matching by default. The relying party must also validate `iss`, `aud`, `sub`, signatures, and expiration.
- **SR-05 Excessive issuance:** Apply per-client rate limits. Design public key retrieval rate limits so they do not block legitimate relying parties. Do not maintain a client assertion replay store for RPC calls using `ctx.props`. An issued JWT’s `jti` identifies the token; it does not by itself prevent bearer JWT reuse.
- **SR-06 Key rotation:** Publish the new public key in JWKS first, switch signing keys after relying parties can retrieve it, and remove the old key only after the last JWT issued with it expires and the allowed clock skew has elapsed. Determine the wait before switching by verifying each relying party’s JWKS caching and refresh behavior. For emergency compromise, provide an expedited procedure that can also disable relying-party roles and trust. See [signing algorithms and key lifecycle](./key-management.md).
- **SR-07 Revocation limits:** Signed bearer JWTs cannot be recalled immediately after issuance. Even after a client is disabled, issued JWTs and exchanged temporary cloud credentials may remain usable until their respective expirations. Emergency shutdown must also address relying-party trust, permissions, and sessions.
- **SR-08 Supply chain:** Require pinned dependencies, license review, vulnerability updates, and CI secret scanning before the beta release.
- **SR-09 Administration:** Authenticate Admin Worker APIs except the limited routes required before authentication, and apply local RBAC to passkey/Access authentication results. In passkey mode, do not include administrative data in the SPA shell/assets. In Access mode, protect the entire host with Access. Do not bind signing private keys or issuance RPC to the Admin Worker. Address CSRF, session fixation, and XSS on state-changing routes that use cookies.
- **SR-10 Administrator recovery:** Initial administrator registration must use a procedure tied to deployment permissions. Reject deletion of the last enabled `security-admin` and self-escalation. Provide an audited CLI procedure for recovery after passkey loss.
- **SR-11 Rotation permissions:** The Admin Worker must not hold key material, Cloudflare API tokens, or a Key Registry D1 Binding. The Controller fixes the target issuer Worker and allowed operations, and rejects switching during duplicate execution, unvalidated relying-party configurations, deployment conflicts, or inconsistent states. Provide shutdown and revocation procedures for token compromise.

## 6. Nonfunctional and operational requirements

- **NFR-01 Availability:** Monitor failures of the issuance path, client registration data, public metadata, and JWKS separately. Fail closed when the issuance path fails. Operators determine specific SLOs and capacity based on measurements.
- **NFR-02 Performance:** Measure signing, registration lookups, Service Binding round trips, and cloud exchanges separately. Set numerical targets after measuring them.
- **NFR-03 Time:** Account for clock skew between issuer and relying parties, with explicit tolerances for `iat`/`nbf`/`exp`. Do not hide clock skew by extending token validity.
- **NFR-04 Caching:** Incorporate JWKS/metadata Cache-Control and the actual refresh frequency of relying parties into rotation plans. In particular, AWS API Gateway JWT authorizers may cache public keys for up to 2 hours. [AWS documentation](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
- **NFR-05 Change management:** Changes to Service Binding `props`, client registrations, allowed `aud` values, signing keys, and public metadata must follow reviewable procedures and leave audit records. After retiring a signing key, recover by rolling forward to a new Worker version rather than rolling back to a version that holds only the old key. Reverting an audience’s algorithm is allowed only while a valid key for the previous algorithm is retained.
- **NFR-06 Portability:** The OSS core must not depend on specific Cloudflare account IDs, AWS account IDs, or internal organizational configuration. Explicitly identify the Cloudflare Worker/Service Binding implementation as an adapter.
- **NFR-07 Administrative data:** Define D1 backups, schema migrations, audit log retention, and administrator recovery procedures before operations begin. Reject new issuance if authorization policies cannot be read.

## 7. Configuration responsibilities by relying party

| Location        | Required configuration                                                                                                                       | Scope                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| issuer          | client ID, fixed `sub`, allowed `aud`                                                                                                        | Per caller. Add allowed `aud` values when adding relying parties                                              |
| caller          | Dedicated issuance Service Binding, its `props.clientId`, and requested `aud`                                                                | Per Worker. Control changes to `props` through deployment permissions                                         |
| Custom API      | issuer/JWKS, allowed `aud` and `sub`, authorization rules                                                                                    | Per API trust boundary                                                                                        |
| AWS             | IAM OIDC provider, audience, IAM role trust policy restricted by `sub`/`aud`, least-privilege policy                                         | Per AWS account/role                                                                                          |
| Google Cloud    | Workload Identity Pool/Provider, audience, attribute mappings and conditions, permission grants                                              | Per pool/provider and target resource                                                                         |
| Claude API      | Federation issuer, federation rule restricted by `aud`/`sub` and other attributes, service account, workspace, and scope                     | Per Anthropic organization/workspace and principal                                                            |
| OpenAI API      | Workload Identity Provider, expected `aud`, service account mapping matching `sub` and other attributes, project/service account permissions | Per OpenAI organization/project and principal. Verify support for arbitrary OIDC issuers through live testing |
| Microsoft Entra | Federated identity credential issuer/subject/audience and target identity permissions                                                        | Per app or managed identity                                                                                   |

This configuration does not mean “listing every relying-party URL in the issuer.” Relying-party trust configuration is necessary; operators create it for each relying party and update it as permissions change.

## 8. OSS publication requirements

Samples must use only `example.com` and fictional IDs. Production domains may appear as design examples, but do not commit real account numbers, role ARNs, project numbers, private keys, tokens, or internal network information. Clearly separate sample deployment configuration from actual configuration. **Release the beta only after the live validation of AWS, Google Cloud, Claude API, and OpenAI API.** Record failures and provider limitations as outcomes, and include only successful targets in the support matrix. Clearly distinguish supported and unsupported providers in the README. [Release status](../reference/release-status.md) is the single source of truth for the full beta gate.

## 9. Open issues and decision gates

1. **OIDC compatibility:** Can the discovery fields required by AWS and others be provided in a way that accurately reflects actual capabilities? If not, reduce the support scope or implement the necessary OIDC functionality.
2. **Issuance API format:** Prefer a Cloudflare named RPC entrypoint. Validate separation from the public fetch handler in a live environment.
3. **`ctx.props` permission boundary:** Verify in a live environment which Bindings and `props` account administrators, Worker editors, and CI/API tokens can change. Centralized CI is not required if all principals that can make changes are within a single trusted administrative boundary. If permission separation cannot demonstrably prevent an untrusted principal from deploying another caller’s client ID, do not grant that principal issuance permissions.
4. **Administrative data:** Separate Policy D1 from Admin D1, with Policy D1 as the source of truth for callers/audiences/grants. Validate schema migrations, backups, disaster recovery, change auditing, and minimal shutdown propagation delay during implementation. Do not move authorization data into caller RPC arguments.
5. **Key storage:** Use a separate Worker secret binding per key as the initial-release baseline. Select Secrets Store or an external KMS based on operational requirements and measurements. Account for Cloudflare Worker secret changes requiring deployment of a new version in rotation procedures.
6. **Validation targets:** Evaluate AWS, Google Cloud, Claude API, and OpenAI API through live testing. Configure an OpenAI Workload Identity Provider and service account mapping, then verify this issuer's availability. After testing each target, add only successful targets to the support matrix.
7. **Naming and operational values:** Operators define the staging issuer, client ID rules, `sub` naming conventions, rate limits, log retention, and SLOs. Make these configurable in the public implementation.
8. **Beta readiness:** Finalize the vulnerability contact, maintainers, and release procedures before the beta release.
9. **Authentication deployment choice:** Operators configure passkey or Cloudflare Access authentication for each environment, along with the admin base path on the public host, Access team domain/application AUD, and passkey RP ID. Configure a separate origin only when Access step-up is used. Do not provide an implicit production fallback.
10. **Automatic key switching:** Measure Cloudflare API secret version and deployment operations, Web Crypto key generation time, Key Registry propagation, and relying-party key caching. Limit relying parties that fail live validation to switches requiring manual approval through the admin console.

Implementation acceptance follows the [acceptance criteria](./acceptance.md).

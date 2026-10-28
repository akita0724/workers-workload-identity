---
sidebar:
  label: Key lifecycle
---

# Signing algorithms and key lifecycle

**Status:** Implemented. The Rotation Controller (`apps/rotation-worker`) implements the key lifecycle, and the issuer implements issuance reservations. Waiting periods and algorithm support for each provider still require live validation.

## 1. Algorithm selection

| Relying party                                | RS256                       | ES256                       | Rationale and handling                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | --------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS STS `AssumeRoleWithWebIdentity`          | Documented support          | Documented support          | Included in the permitted RSA/EC algorithms. Claim support after successful live testing. [AWS STS](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html)                                                                                                                                                                                              |
| Google Cloud Workload Identity Federation    | Documented support          | Documented support          | Allows RS256/ES256 signatures for external OIDC assertions. [Google Cloud](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers)                                                                                                                                                                                                                     |
| Claude API Workload Identity Federation      | Documented support          | Documented support          | Claude's WIF reference allows RSA/ECDSA algorithms. Verify with live testing in the target account. [Claude WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference)                                                                                                                                                                                              |
| OpenAI API Workload Identity Federation      | Pending live testing        | Pending live testing        | The official documentation validates the JWT `alg` but identifies arbitrary OIDC issuers as a current limitation. Verify both the signature algorithm and issuer registration through live testing. [OpenAI WIF](https://developers.openai.com/api/docs/guides/workload-identity-federation), [token exchange](https://developers.openai.com/api/reference/workload-identity-federation) |
| Microsoft Entra workload identity federation | Documented support          | Unsupported                 | Microsoft supports only RS256. [Microsoft](https://learn.microsoft.com/en-us/azure/active-directory/workload-identities/workload-identity-federation-considerations)                                                                                                                                                                                                                     |
| AWS API Gateway JWT authorizer               | Documented support          | Unsupported                 | RSA algorithms only. Treat as a separate product from STS. [API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)                                                                                                                                                                                                                      |
| Custom API                                   | Depends on validation rules | Depends on validation rules | Determine through an explicit relying-party allowlist and interoperability testing                                                                                                                                                                                                                                                                                                       |

Cloudflare Workers Web Crypto supports signatures using RSA PKCS#1 v1.5, ECDSA, Ed25519, and other algorithms. However, **the runtime's ability to sign is separate from the relying party's acceptance**. The initial version requires `RS256` as the default and makes `ES256` an audience-specific opt-in. `EdDSA`, `PS256`, `RS384`, `RS512`, and others remain implementation extension points but will not be used for cloud token exchanges in the initial version. [Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

Opting into ES256 requires live tests confirming that the target relying party can process ES256 JWTs and mixed RSA/EC JWKS, procedures for changing relying-party configuration, and procedures for reverting to RS256. Do not assign ES256 to audiences that include Entra or API Gateway. The issuer's audience policy fixes the algorithm; it is not accepted as an RPC argument.

If multiple relying parties share one `aud`, select only algorithms accepted by all of them. Assign separate `aud` values to relying parties with different compatibility or permissions. The signing algorithms in metadata describe implementation capabilities, not the currently available keys. Before using a new algorithm, verify the JWKS across all serving versions and each relying party's compatibility.

## 2. Key and JWKS invariants

- Assign each key an opaque `kid` unique within the environment and issuer. Never reuse it for a different public key or `alg`. The Controller generates the `kid` as a random UUID.
- `RS256` keys are RSA keys. The Controller always generates 3072-bit RSA keys; there is no setting to change the size. `ES256` keys use P-256. RSA and EC keys never share a `kid`.
- JWKs contain only public components and explicitly specify `kid`, `kty`, `use: "sig"`, and `alg`. RSA keys include `n`/`e`, and EC keys include `crv`/`x`/`y`. Private components, symmetric keys, and unused keys are never included.
- During issuance, the issuer checks the key record's `alg` and the JWK type before passing them to `jose`. Configure permitted `alg` values explicitly on the relying party; do not expand the validation algorithms based solely on the JWT header. [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)
- An issuer's public JWKS may contain both RS256 and ES256 keys. If a relying party has difficulty with mixed JWKS, do not enable the new algorithm for that relying party. If necessary, create a compatibility profile with a separate issuer URL and register the trusted issuer again.
- The operational target is one current key per algorithm in normal JWKS, with at most two keys, old and new, during rotation. Stay well below limits such as AWS's JWKS key count limit. [AWS IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)

Each private key is stored in a separate issuer Worker secret binding. The authoritative public key manifest resides in **Key Registry D1**, which only the issuer and the Rotation Controller can access. It contains `kid`, `alg`, the public JWK, the corresponding secret binding name, and the key state. JWKS keys are kept separate from Policy D1, which the Admin Worker can write to; otherwise, a compromise of the management plane could cause an attacker's public key to be trusted. **Private key material is never stored** in any D1 database. Importing a Worker secret into Web Crypto still exposes the original secret value to the Worker execution environment, so do not describe this as equivalent to the protection of a non-exportable key in an external KMS. See [Rotation Controller](./rotation-controller.md).

## 3. Key states and selection rules

| State       | Published in JWKS | Used for issuance | Meaning                                                             |
| ----------- | ----------------- | ----------------- | ------------------------------------------------------------------- |
| `prepared`  | Yes               | No                | The new key is published in advance so relying parties can fetch it |
| `active`    | Yes               | Yes               | The only key that signs new JWTs for that algorithm                 |
| `verifying` | Yes               | No                | The old key is retained to verify existing JWTs                     |
| `removed`   | No                | No                | The key is retired. Its `kid` is never reused                       |

### Public key transition period

Scheduled rotation requires **a period when both old key A and new key B are published in JWKS**. Exactly one key per target `alg` is used for signing at any time. Having multiple public keys does not mean selecting multiple keys to sign new tokens concurrently.

| Period                      | JWKS  | New issuance | Transition condition                                                                                    |
| --------------------------- | ----- | ------------ | ------------------------------------------------------------------------------------------------------- |
| Before `T_publish`          | A     | A            | Prepare B's secret and public key                                                                       |
| `T_publish` to `T_activate` | A + B | A            | Publish B in advance and confirm the required wait across all serving versions and relying-party caches |
| `T_activate` to `T_remove`  | A + B | B            | Keep JWTs already issued with A verifiable                                                              |
| From `T_remove` onward      | B     | B            | Confirm that the last JWT issued with A has expired and the allowed clock skew has elapsed              |

Set the minimum `T_activate - T_publish` to the longest verified JWKS cache duration across all target relying parties, plus a propagation margin. `T_remove` is not derived from the planned schedule. It is no earlier than **a conservative upper bound on A's final issuance time + maximum JWT lifetime + allowed clock skew + operational margin**. If the switch is delayed, the overlap is extended and the old key is not removed early. Do not enable automatic switching if the relying-party cache limit is unknown. Emergency retirement after a compromise follows a separate incident procedure.

Issuance reservations bound A's final issuance time. Before signing, the issuer inserts a reservation for the selected key into Key Registry D1. The insert succeeds only while that key is `active`, and the reservation expires 30 seconds later. If the reservation has expired by the time the JWT is signed, the issuer discards the JWT and fails. After the switch, A can no longer obtain reservations, and retirement refuses to proceed while any uncompleted, unexpired reservation for A remains. Cloudflare execution duration is not used as an implicit upper bound.

At activation, the Controller records the activation time as `lastOldIssuedAt` and sets `removeNotBefore` to **activation time + 330 seconds + `retirementGraceSeconds`**. The 330 seconds are the 300-second maximum assertion lifetime plus the 30-second reservation window. The grace period, at least 300 seconds, covers clock skew and operational margin.

The rotation plan schema validates `prepublishSeconds` (60 to 2,592,000) and `retirementGraceSeconds` (300 to 2,592,000) with Zod. Normal activation additionally requires every audience that uses the algorithm to have a JWKS cache limit, and `prepublishSeconds` to be at least that limit plus 60 seconds. The Registry stores the actual `publishedAt`, `activatedAt`, `lastOldIssuedAt`, and `removeNotBefore` values. The scheduler does not start a new rotation for an `alg` while another run for it is neither `removed` nor `failed`. When both RS256 and ES256 are in use, JWKS may contain two keys per algorithm during transition, for a maximum of four keys. Verify relying-party JWKS limits in advance.

Both issuance and JWKS read the manifest in Key Registry D1. Issuance selects at most one `active` key per `alg` and fails closed if the corresponding issuer Worker secret binding is missing or the key pair does not match. Because old and new versions can coexist during gradual deployments, the Controller does not switch the `active` key until it has confirmed that the new key's binding exists in the serving version. JWKS returns both old and new public keys before the switch. Monitor public JWKS failures separately.

## 4. Normal rotation

Rotations start from the admin console. A `security-admin` can start one directly. An `operator` or `security-admin` can propose one, which a `security-admin` other than the proposer must approve. An automated schedule that passes through the same gates is also implemented. Enable automation only after measuring relying-party key cache behavior and transition gates.

The admin console provides new key generation and rotation initiation, approval, pause, resume, retry, and status checks. The browser never generates, uploads, or displays key material. The Rotation Controller generates keys on the server and registers them with Cloudflare. It does not accept JWKs or `kid` values from the admin console; it generates them itself and validates state transitions against evidence from the actual environment. See [Rotation Controller](./rotation-controller.md) for permission boundaries and failure recovery, and [admin console](./admin-console.md) for the operator side.

The Controller never calls the Cloudflare deployment API to create or change deployments. It reads deployments and versions only to verify them, and it changes the issuer only by uploading and deleting secrets through the [Worker Secrets API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/).

1. **Preparation:** The Controller generates new key B with Web Crypto and separates the public JWK from the private key. It uploads private key B as a dedicated issuer Worker secret; Cloudflare creates a new issuer version with that binding. It then registers B as `prepared` in Key Registry D1, while A remains `active`. The private key exists only in the Controller's memory and in transit to the Cloudflare API. If the upload outcome is unknown, the run stays in `secret-staging` and cannot be retried; it requires manual recovery.
2. **Prepublication:** B appears in the public JWKS while issuance continues to use A. The Controller waits `prepublishSeconds`. Verify the target relying parties' JWKS caching, refetch behavior for unknown `kid` values, and metadata refresh intervals through documentation or live testing, and record the cache limit on each audience. AWS API Gateway JWT authorizers document public key caching for up to two hours; do not confuse this with AWS STS behavior. [API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
3. **Switch:** Before activation, the Controller checks the audience cache limits and relying-party confirmations, confirms that the public JWKS contains B, and confirms that the latest deployment serves a single version at 100% whose bindings include B's secret. If any check fails, activation fails and A keeps signing. Otherwise, a conditional update in Key Registry D1 sets B to `active` and A to `verifying`, and records the deployment evidence. Subsequent issuance uses B, and JWKS returns both A and B. Monitor issuance counts by `kid`, external exchange failures, and JWKS errors. Avoid deploying the issuer while a switch is in progress. [Cloudflare versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
4. **Retirement:** After `removeNotBefore`, and only when no pending reservation for A remains, the Controller deletes A's secret and marks A `removed`, which removes A from JWKS. From this point onward, do not roll back to versions that contain only A; perform any required recovery by rolling forward to B or later keys.

Immediate rotation skips the prepublication wait, the audience cache checks, and the relying-party confirmation checks, but still verifies the JWKS and deployment, and the retirement timing is unchanged.

Use the same procedure when moving to a new algorithm. First publish the new algorithm's public key in advance, confirm that relying parties can read the mixed JWKS, and switch only the target audiences. During the planned rollback window for RS256, retain a valid RS256 private key, public key, and binding in all serving versions. If problems occur, revert that audience's policy to RS256. Once the RS256 key has been retired, returning to RS256 requires preparing, publishing in advance, and deploying a new key; a policy change alone is insufficient.

## 5. Emergencies and revocation limits

If a private key is compromised, immediately stop new issuance with that key, publish and activate a new key, and remove the old key from JWKS. Also consider disabling relying-party trust configurations, roles, permissions, and temporary credentials already obtained through exchanges. If a relying party caches the old JWKS, removing the key from JWKS may not immediately cause old signatures to be rejected. Prepare an incident procedure that allows a temporary authentication outage, since the normal prepublication period cannot be observed.

Disabling a caller's Binding may leave already issued short-lived JWTs and exchanged cloud credentials valid until expiration. The issuer's `jti` identifies an issuance record; it does not communicate forced revocation to relying parties. [AWS IAM key compromise response](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)

## 6. Operational records

For each key, record `kid`, `alg`, creation time, publication start, signing start, signing end, final JWT expiration time, JWKS removal time, and deployment versions. For each audience, record the target relying parties, supported algorithms, and the JWKS cache limit. Set key generation intervals through operational policy, and do not publish a fixed safety period as a guarantee before measuring actual behavior.

An operator enters the relying-party JWKS cache limit for each audience. Normal key rotation stops if the limit is missing or the prepublication wait is less than that limit plus 60 seconds. Verification dates are not stored; operators review the setting as needed.

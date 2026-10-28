---
sidebar:
  label: Provider validation plan
---

# Live provider validation plan

**Status:** Target design. No provider has been validated yet. The four initial targets (AWS, Google Cloud, Claude API, and OpenAI API) and the Microsoft Entra and OCI notes below are evaluation targets, not support claims. “Claude” means direct Claude API access and “OpenAI” means direct OpenAI API access; do not confuse them with Amazon Bedrock, Vertex AI, ChatGPT, or Codex authentication.

## Shared rules

- The issuer does not know the provider. It issues a short-lived JWT for one allowed `aud`; a caller adapter or provider SDK performs token exchange and then calls the API with the exchanged credential.
- Allocate a different `aud` to each relying party. Verify exact `iss`, `sub`, and `aud` plus a least-privilege relying-party policy. Never publish organization-specific relying-party IDs in examples.
- For each provider, test a valid exchange and least-privilege API call, incorrect `aud`/`sub`/`iss`, expiry, invalid signature, and exchange during rotation. Record signing-algorithm and JWKS-cache behavior in the target environment.
- A validation record includes the date, product and plan, setup procedure, sanitized metadata/JWKS/claims, successful and failed cases, reproducible test IDs, and known limits. It contains no real token, private key, or account ID.
- Results are `unverified`, `successful`, `unsupported`, or `unverifiable`. The beta is released only after the live validation of all four targets; [Release status](../reference/release-status.md) is the single source of truth for the beta gate. If a provider constraint stops an evaluation, record the constraint and classify the result as `unsupported` or `unverifiable`. List only successful integrations as supported.

## Exchange paths and provider-specific gates

| Target       | Relying-party configuration and exchange                                                                                                              | Provider-specific checks                                                                                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS STS      | Create an IAM OIDC provider and role trust policy restricted by `sub` and `aud`; call `AssumeRoleWithWebIdentity`                                     | Alignment between required discovery fields and implemented capability, IAM provider creation, excessive role permissions, and acceptance of old/new JWKS keys                                                                                                          |
| Google Cloud | Configure issuer, audience, attribute mapping, and conditions in a Workload Identity Pool/Provider; exchange through Google STS                       | Expected provider `aud`, subject restriction through attribute conditions, target-resource permissions, and rotation                                                                                                                                                    |
| Claude API   | Register a federation issuer, service account, workspace, and rule constrained by `aud` and `sub`; use the JWT bearer grant at `POST /v1/oauth/token` | Discovery versus direct JWKS, rule and organization/service-account identifiers, scope, assertion and exchanged-token lifetimes, key caching; never send the issuer JWT directly to the API                                                                             |
| OpenAI API   | Register a Workload Identity Provider and project service-account mapping; use the token-exchange grant at `https://auth.openai.com/oauth/token`      | Official documentation currently limits arbitrary issuers, so confirm whether `https://oidc.example.com` can be registered and exchanged. Check mapping uniqueness and permissions, discovery/JWKS mode, and key caching; never send the issuer JWT directly to the API |

Claude can use discovery, a direct public JWKS URL, or inline JWKS. Prefer a public JWKS for automatic rotation. Do not automate an inline-key transition unless pre-update is automated and verified. Claude documentation recommends publishing a new key at least 15 minutes before signing with it; do not reuse that interval for another relying party without evidence. See [Claude WIF](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) and the [WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference).

OpenAI can use public discovery/JWKS or an uploaded JWKS. Its documentation states that public JWKS may be cached for 600 seconds and refreshed on an unknown `kid`; uploaded mode requires a JWKS update on the relying party before activation. The existence of these settings does not prove that an arbitrary issuer is accepted. See [OpenAI WIF](https://developers.openai.com/api/docs/guides/workload-identity-federation) and the [token exchange reference](https://developers.openai.com/api/reference/workload-identity-federation).

## Cloud configuration examples

These are fictional staging examples, not verified integrations. Replace `https://oidc.example.com` with the actual public HTTPS issuer. Match the issuer exactly, including a trailing slash, across configuration, metadata, JWT `iss`, and the relying party. Every example uses `clientId: example-caller`, `subject: service:example-caller`, `algorithm: RS256`, and a 300-second lifetime. Register each audience on the issuer and grant it to the client, publish the signing key in the JWKS, and set the Service Binding `props.clientId` to `example-caller`.

### AWS IAM / STS

| Where             | Setting                 | Example                                                                                                 |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Issuer            | Audience / grant        | Register `urn:example:aws:staging` and grant it to the client                                           |
| IAM OIDC provider | Provider URL / audience | `https://oidc.example.com` / `urn:example:aws:staging`                                                  |
| IAM role          | Trusted provider        | `arn:aws:iam::123456789012:oidc-provider/oidc.example.com`                                              |
| IAM role          | Trust policy conditions | `oidc.example.com:aud` is `urn:example:aws:staging`; `oidc.example.com:sub` is `service:example-caller` |
| Caller            | Exchange                | Call STS `AssumeRoleWithWebIdentity` with the role ARN                                                  |

Grant the role only the permissions it needs. For an issuer with a path, include the path in the IAM provider ARN and the condition keys. AWS requires at least one key in the public JWKS. See [AWS IAM configuration](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html) and [OIDC condition keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html).

### Google Cloud

| Where                             | Setting                   | Example                                                                               |
| --------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| Issuer                            | Audience / grant          | Register `urn:example:gcp:staging` and grant it to the client                         |
| Workload Identity Pool / Provider | Issuer / allowed audience | `https://oidc.example.com` / `urn:example:gcp:staging` (custom audience)              |
| Provider                          | Attribute mapping         | `google.subject=assertion.sub`                                                        |
| Provider                          | Attribute condition       | `assertion.sub == 'service:example-caller'`                                           |
| Google Cloud                      | Permissions               | Grant the mapped subject least-privilege access to a test resource or service account |
| Caller                            | Exchange                  | Pass the provider resource name and the assertion to Google STS                       |

Without a custom audience, use the provider resource name that Google Cloud expects as the issuer `aud`. `google.subject` is limited to 127 characters. If you upload the JWKS directly instead, key updates also require an update on the relying party. See [Google Cloud configuration](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers).

### Microsoft Entra ID / Azure

| Where                                         | Setting                     | Example                                                                                                         |
| --------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Issuer                                        | Audience / grant            | Register `api://AzureADTokenExchange` and grant it to the client                                                |
| Federated identity credential                 | Issuer / subject / audience | `https://oidc.example.com` / `service:example-caller` / `api://AzureADTokenExchange`                            |
| Application or user-assigned managed identity | Permissions                 | A role limited to the Azure resources under test                                                                |
| Caller                                        | Exchange                    | Pass the external JWT as a client assertion to the token endpoint, with the tenant ID and application client ID |

Use RS256 and publish the JWK with `use: sig`. The audience above is Microsoft's example; confirm the value for the actual cloud environment. See [Microsoft Entra configuration](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-spiffe-spire).

### Oracle Cloud Infrastructure (OCI)

| Where                      | Setting                                | Example                                                                                                          |
| -------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Issuer                     | Audience / grant                       | Register `urn:example:oci:staging` and grant it to the client; verify how OCI checks the audience in a live test |
| Identity Propagation Trust | Name / type / issuer                   | `example-workload-trust` / `JWT` / `https://oidc.example.com`                                                    |
| Identity Propagation Trust | State / subject type / claim condition | Active / `Resource` / verify a setting that restricts `sub` to `service:example-caller`                          |
| OCI                        | Authorization                          | An OAuth client allowed to exchange, the target resource, and a least-privilege policy                           |
| Caller                     | Exchange                               | Request an OCI resource principal session token (RPST) through token exchange                                    |

The `public_key` that the OCI exchange request carries is for API requests that use the RPST; it is not the issuer's signing key. Verify in the target tenancy how OCI fetches and trusts the issuer key, the claim-condition syntax, and the audience handling. See [OCI configuration and exchange](https://docs.oracle.com/en-us/iaas/Content/Identity/api-getstarted/token_exchange_grant_type_workload_id-federation.htm).

## Live-test checklist

### Shared preparation

- [ ] A test Cloudflare account, publicly reachable HTTPS issuer, trusted certificate, discovery endpoint, and JWKS.
- [ ] Policy and key registry D1 databases, current and replacement RS256 keys, and corresponding Worker secret bindings.
- [ ] A client with unique subject, per-provider audiences and grants, a fixed Service Binding, and invalid issuer and subject cases for negative tests.
- [ ] Verify who can change Workers and Service Bindings and demonstrate that untrusted principals cannot impersonate another client; do not enable issuance until demonstrated.
- [ ] Isolated provider environments, permission to create and remove trust configuration, a least-privilege test resource, and a caller with a suitable SDK or command.
- [ ] A place to record sanitized configuration, metadata, JWT claims, JWKS, results, errors, cache timing, dates, and cleanup without exposing tokens or private keys.

### Provider-specific preparation

- [ ] **AWS:** Test account, OIDC provider and role administration permissions, provider URL, audience, role ARN, restricted trust policy, and limited resource access.
- [ ] **Google Cloud:** Test project and permissions for pool, provider, and IAM bindings; project number, pool and provider IDs, attribute mapping and condition, and service account and impersonation permission if used.
- [ ] **Microsoft Entra:** Test tenant, permission to configure an application or user-assigned managed identity and federated credential, tenant and client IDs, issuer, subject, audience, and limited Azure role.
- [ ] **OCI:** Test tenancy and identity domain, permissions to configure trust, OAuth client, resource and policy, an exchange request signing key, and settings for the exchange and API call.
- [ ] **Claude / OpenAI:** Test organization/project, permissions to configure issuer, service account, and trust rules, and workspace/scope or project permissions. Confirm OpenAI arbitrary-issuer availability first.

### Execution and acceptance

- [ ] Verify a valid assertion with public JWKS, exchange it, and successfully call an authorized API.
- [ ] Reject mismatched `iss`, `sub`, and `aud`, expiry, invalid signatures, and unknown `kid`; record whether unknown `kid` causes JWKS refresh.
- [ ] Reject unauthorized API calls and confirm that disabling the client or removing its grant stops the next issuance.
- [ ] Prepublish the replacement key, wait for propagation and caches, switch signing, remove the old key after its last JWT expires, and record exchange results at each stage.
- [ ] Record assertion and exchanged-credential lifetimes and each relying party's JWKS cache and refresh behavior; remove test trust, permissions, and resources.

External account testing is not complete. Do not mark these checks complete until results are recorded.

## Publication

The README must state each successful target and validation date. Show unsupported and unverifiable targets with the reason and a condition for retesting. Never turn “we evaluated four targets” into “we support four targets.” If OpenAI API continues to reject arbitrary issuers, omit an OpenAI support claim and wait for provider support or a specification change.

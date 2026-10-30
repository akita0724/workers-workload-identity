---
title: Operations guide
description: Operate key rotation, access reduction, monitoring, D1 protection, upgrades, and decommissioning
sidebar:
  order: 7
---

Production readiness requires more than successful issuance. Operators need to rotate keys safely, apply a permission reduction to the next request, and contain an incident at the relying party. The project is still in alpha, so this page separates implemented behavior from work required before a production release.

## Publish a new key before use and remove it after every JWT expires

Keys move through `prepared`, `active`, `verifying`, and `removed` states.

1. The Rotation Controller generates an RSA 3072-bit or P-256 key on the server.
2. It stores the private key as an issuer Worker secret and the public JWK in Key Registry D1.
3. The public key enters the JWKS in `prepared` state before it signs anything.
4. The Controller confirms that the prepublication interval has elapsed, that the public JWKS contains the new key, and that the latest deployment has exactly one version at 100% of traffic and that version binds the new secret.
5. The new key becomes `active`; the previous key becomes `verifying`.
6. The Controller waits for the last possible old JWT lifetime, a safety margin, and the configured grace period.
7. After confirming there are no unfinished issuance reservations, it removes the old secret and public JWK.

A D1 unique constraint allows only one `active` key per algorithm. If a gate fails, rotation stops instead of skipping ahead. The Workflow handles retryable failures. A Cloudflare API authentication or authorization rejection requires a new rotation run; an upload whose outcome is unknown requires manual reconciliation rather than automatic resumption. The [key lifecycle](../design/key-management.md) and [Rotation Controller](../design/rotation-controller.md) specifications describe the implemented states and the target design separately.

## Test client disablement and grant removal regularly

The issuer reads primary Policy D1 for every request and does not cache authorization across requests. Disabling a client or removing a grant therefore affects the next issuance.

At least once per release, automate checks for:

- successful issuance and verification for an enabled caller and audience;
- rejection of an audience without a grant;
- rejection immediately after disabling a client and recovery after re-enabling it;
- public discovery and JWKS with no HTTP issuance route;
- rejection of altered issuer, audience, subject, expiry, and signature; and
- unique `jti` values under parallel issuance.

`pnpm test:e2e` exercises the local path. `pnpm staging:test` checks the core cases in a deployed staging environment.

## Delete retired workloads and unused audiences

Operators and security administrators can delete policy resources from the console. Viewers cannot delete them. Deletion uses the same session or Access authentication and Origin/CSRF checks as policy editing; it does not require an additional step-up challenge.

1. On **Workloads**, disable the workload and then choose its delete action. Review the target before confirming. Enabled workloads cannot be deleted.
2. Deleting a workload removes its client registration, all of its audience grants, and its issuance rate-limit buckets. Other workloads and the audience registrations remain.
3. On **Audiences**, choose the audience's delete action. If any workload still has a grant, the dialog lists those workloads and blocks deletion. Disabled workloads also count: remove their grants or delete them first.
4. Once no grants remain, confirm audience deletion. Its policy and compatibility confirmations are removed from the active configuration.

Both operations retain existing policy audits and issuance history (issuance events remain subject to their normal retention period). The deletion event records the actor, target, time, and previous settings in `before_json`, with `after_json` set to JSON `null`. Workload snapshots include their audience grants; audience snapshots include their compatibility confirmations. Eligibility checks, the audit write, and deletion commit in a single Policy D1 transaction. A failure rolls back the entire operation. No new database migration is required.

Deleting a registration does not revoke an issued JWT, exchanged credentials, or an issuance already in progress. It does not remove Service Bindings from deployed callers. Remove obsolete bindings before deliberately registering the same client ID again, because those bindings can identify themselves using that ID.

### Admin API

These routes are for the authenticated admin console. Send JSON and the normal Origin/CSRF headers; `version` is the current version returned by the resource list.

| Method and path | JSON body | Success (`200`) |
| --- | --- | --- |
| `DELETE /api/clients/:clientId` | `{"version": 3}` | `{"clientId":"retired-worker","deleted":true}` |
| `DELETE /api/audiences` | `{"audience":"https://api.example.com/path?scope=read","version":2}` | `{"audience":"https://api.example.com/path?scope=read","deleted":true}` |

Audience identifiers stay in the JSON body so URI slashes, query strings, fragments, and percent escapes are preserved exactly.

| Status / error | Action |
| --- | --- |
| `400 invalid-input` | Supply a valid identifier and a nonnegative integer version, without extra fields. |
| `401 unauthorized` / `403 forbidden` or `invalid-request` | Sign in with an operator or security administrator account and use valid Origin/CSRF headers. |
| `404 not-found` | Refresh the list; the resource does not exist or has already been deleted. |
| `409 version-conflict` | Refresh and review the latest settings before trying again. |
| `409 client-must-be-disabled` | Disable the workload first, then use its updated version. |
| `409 audience-in-use` | Remove all grants for the audience. The response includes `clientIds`, including disabled workloads. |
| `503 unavailable` | No changes were committed. Resolve the database failure and retry after refreshing. |

## Build observability without recording tokens

The sample Wrangler configuration enables logs and traces. The Workers also record these non-secret signals:

| Signal                         | Source                        | Contents                                                                                                               |
| ------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Issuance audit events          | Issuer, Policy D1             | Event ID, request ID, client, audience, `kid`, outcome, latency, and start time for every success, denial, and failure |
| Issuance metrics               | Issuer, Policy D1             | Per-minute counts by outcome, without JWTs or client IDs                                                               |
| Issuer health checks           | Admin Worker, Admin D1        | Result, latency, and time of the latest discovery and JWKS checks                                                      |
| `issuance-audit-unavailable`   | Issuer, JSON log              | An audit event could not be persisted; only the event ID is logged                                                     |
| `issuance-metrics-unavailable` | Issuer, JSON log              | A metrics write failed; issuance was not blocked                                                                       |
| `issuer-health-changed`        | Admin Worker, JSON log        | A discovery or JWKS check changed state                                                                                |
| `rotation-schedule-blocked`    | Rotation Controller, JSON log | A due rotation schedule was disabled because relying-party confirmations were missing                                  |

The admin console shows availability as `success / (success + issuance-unavailable)` over the last 24 hours. Policy, input, and rate-limit denials are expected decisions and are excluded. With no traffic, availability is shown as unmeasured. Set the target with `ISSUANCE_SLO_PERCENT` on the admin Worker; the default is 99.9.

The admin Worker checks discovery and JWKS every five minutes when `ISSUER_URL` is set on it. The console never shows a result older than 15 minutes as current. **Check connectivity** in the console re-runs the checks; it does not perform a provider token exchange.

Before production use, configure notification routing, on-call ownership, external alert delivery, and D1 size monitoring for the deployment. Also make rotation-run state, the failed gate, and elapsed time visible.

Never record JWT bodies, private keys, Cloudflare API tokens, passkey material, invitation tokens, or exchanged cloud credentials in logs or traces.

## Data retention

Cron triggers delete short-lived data. Policy change audits and operator action audits are never deleted automatically.

| Data                                                                 | Retention          | Deleted by                        |
| -------------------------------------------------------------------- | ------------------ | --------------------------------- |
| Issuance audit events (`issuance_audit_events`)                      | 30 days            | Issuer hourly Cron (`17 * * * *`) |
| Issuance metrics (`issuance_metrics`)                                | 30 days            | Issuer hourly Cron                |
| Issuance rate-limit buckets (`issuance_rate_limits`)                 | 60 minutes         | Issuer hourly Cron                |
| Issuance reservations (`issuance_reservations`)                      | 1 day after expiry | Issuer hourly Cron                |
| Admin sessions, WebAuthn challenges, step-up challenges, invitations | Until expiry       | Admin five-minute Cron            |
| Admin authentication rate-limit rows (`auth_rate_limits`)            | 60 minutes         | Admin five-minute Cron            |

After cleanup, the admin five-minute Cron runs the issuer health check if `ISSUER_URL` is set. If the issuer Cron trigger is missing, these tables grow without bound.

## Apply migrations before deploying code

Apply all pending migrations to each database before deploying updated Workers. Code deployed first fails on missing tables or columns. Before rolling back code, verify that the older code works with the retained schema and constraints.

| Database        | Migrations                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy D1       | `0001_initial`, `0002_operations`, `0003_audience_notes`, `0004_remove_verification_notes`, `0005_remove_verification_date`, `0006_issuance_audit_and_rotation_checks` |
| Key Registry D1 | `0001_initial`, `0002_automation`, `0003_rename_immediate_rotation`                                                                                                    |
| Admin D1        | `0001_initial`, `0002_access_step_up`, `0003_management`, `0004_step_up_actions`, `0005_rename_immediate_rotation`                                                     |

Policy `0005_remove_verification_date` drops the old confirmation date column. Before dropping it, it sets `jwks_cache_seconds` to `NULL` for any audience whose confirmation date was missing, in the future, or older than 180 days, so stale confirmations do not become valid settings. Review those audiences after the migration. Policy `0006_issuance_audit_and_rotation_checks` adds the issuance audit table and the `exchange_verified` and `mixed_jwks_verified` columns, which start unset. Without the audit table, the issuer does not release any assertion.

`pnpm staging:deploy` applies the migrations in the required order. The migration files are in [`migrations/`](https://github.com/akita0724/workers-workload-identity/tree/main/migrations).

## Make D1 and configuration recoverable

Policy, Key Registry, and Admin D1 have different recovery requirements. Write and rehearse environment-specific procedures that cover:

- restoring clients, audiences, grants, and audit history;
- reconciling public JWKs and key states with their Worker secrets;
- restoring operators and passkeys while invalidating unnecessary sessions; and
- confirming that migration state matches the application version.

A D1 backup does not restore a signing private key. If private keys are backed up, separately design encryption, access control, audit, and the mapping between each public JWK and `kid`. If private keys are intentionally nonrecoverable, disaster recovery must move relying-party trust to a new key or issuer.

## Back up and restore into an isolated database

`pnpm ops` requires explicit `--config`, `--binding`, and `--target` options. `--target remote` operates on the D1 database in Cloudflare; `--target local` operates only on local Wrangler state for development. Use `--target remote` for a deployed staging environment, and verify the account and resources before running a command. Backups contain authentication-related data; keep them in protected storage. Output files must be new and are restricted to mode 0600.

```sh
pnpm ops backup --config .deploy/staging/admin.json --binding ADMIN_DB --target remote --out /tmp/admin-backup.sql
```

Export Policy and Key Registry separately with `.deploy/staging/issuer.json` and the `POLICY_DB` and `KEY_DB` bindings. These exports are not a distributed transaction. If you need a consistent recovery point, freeze administrative changes, issuance, and rotation, and consider Cloudflare's own recovery facilities. A D1 export does not back up issuer secrets.

`restore` only runs `wrangler d1 execute --file <file> --yes` against the selected database. It does not check that the target is isolated or empty, and it does not invalidate anything. Import into an **isolated empty database** first, never into a live production database.

```sh
pnpm ops restore --config /path/to/isolated-admin.json --binding ADMIN_DB --target remote --file /tmp/admin-backup.sql --confirm-restore
```

Then complete these steps manually:

1. Before running `restore`, confirm that the configuration points to the isolated, empty database.
2. After import, delete admin sessions, WebAuthn and step-up challenges, and unused invitations.
3. Check operator state and audit history.
4. Reconcile Policy and Key Registry with the deployed issuer, public keys, and secrets, without reviving retired keys or disabled clients.

Complete a real recovery exercise before production acceptance. See [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

## Recovery after all passkeys are lost

If another security administrator can sign in, issue a recovery invitation from the console with **Start passkey recovery**. Otherwise a deployer targets an existing enabled `security-admin`, verifies that person's identity, and records a reason. The command revokes the target's passkeys and sessions and issues a one-use invitation that expires after 15 minutes. It does not promote anyone to administrator.

```sh
pnpm ops recover-admin --config .deploy/staging/admin.json --binding ADMIN_DB --target remote --operator 11111111-1111-4111-8111-111111111111 --reason "Identity verified; all admin devices lost" --confirm-revoke-credentials --out /tmp/admin-recovery.json
```

`--operator` must be the operator's ID as a lowercase UUID. `--reason` must be 8 to 1,024 characters and is stored in the admin audit log. The command also works when a bootstrap invitation expired before the first passkey was registered.

The invitation token is written only to the new file named by `--out`, never to stdout or audit logs. On the login screen, choose **Register with an invitation or recovery code**, enter the token in **Invitation or recovery code**, and register a new passkey. Then delete the recovery file. In Cloudflare Access mode, use the Access application and identity-management recovery process instead of this passkey command.

## Issuance audit and relying-party confirmations

Issuance events appear in the existing audit view and API. You can search them by client, audience, outcome, request ID, or key ID.

A security administrator records three confirmations in the audience editor: authentication succeeds with the current signing algorithm (credential exchange, for exchange-based relying parties); the relying party accepts old and new public keys published together; and the JWKS cache upper bound. The API fields are `exchangeVerified`, `mixedJwksVerified`, and `jwksCacheSeconds`; `ES256` also requires `verifiedForEs256`. Operators with the `operator` role cannot change confirmations. Changing the signing algorithm in the console clears the confirmations for review.

Audiences that existed before Policy `0006` start with the new confirmations unset. A cache value alone cannot enable automation. Every audience for the algorithm is checked when a schedule is enabled, on each due tick, and immediately before a normal activation. Missing confirmations disable a due schedule or block activation while the old key stays active. Keep both keys, correct the confirmations, and use a safe retry.

Explicit immediate rotation still skips the relying-party waiting and confirmation gates. The deployment and JWKS integrity gates and the old-key retirement gates still apply.

The first key for an algorithm is exempt from the authentication and old/new-key confirmations, so it can be activated before any relying party is tested. Automation still requires an active key.

## Do not skip upgrade gates

```sh
pnpm staging:check
pnpm staging:deploy
pnpm staging:test
```

Before deployment, check compatibility among migrations, shared contracts, caller SDK, issuer, and the relying-party fixture. Changes to JWT claims, RPC input or output, public error codes, discovery, or JWKS are protocol changes rather than ordinary internal refactoring.

Signing secrets and JWKS must remain consistent, so avoid unplanned gradual deployments for signing changes. If several versions receive traffic, the rotation gates must prove that every version has the same public-key set and required secrets.

## Decommission from the relying party backward

Do not remove the JWKS immediately after stopping new issuance.

1. Freeze new clients and grants.
2. Move relying-party trust policies and credential mappings to the replacement issuer.
3. Disable old clients and wait for the maximum exchanged-credential lifetime.
4. Wait for the last JWT `exp` and the JWKS cache duration.
5. Remove the issuer, admin, rotation resources, D1 databases, and secrets.
6. Retain or delete audit records according to organizational policy.

The staging scripts do not automate deletion. Removing `.deploy/staging/` does not delete any Cloudflare resource.

## Known limitations

- The admin Worker maps errors from the Rotation Controller RPC and from passkey operations that it does not recognize to a generic HTTP 503 with `{ "error": "unavailable" }`. Examples are a schedule version conflict, a schedule or rotation blocked because relying-party confirmations are not recorded, and a passkey challenge consumed by a concurrent request. (Reusing a challenge that is already gone normally returns 400 `invalid-input`.) The console therefore cannot always show why a rotation action or passkey operation failed. Check the Rotation Controller logs and the rotation run state.

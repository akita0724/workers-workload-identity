---
title: Deploy to staging
description: Create an isolated Cloudflare staging environment, generate the first key, test issuance, and register the first administrator
sidebar:
  order: 6
---

This procedure helps deployers create a Cloudflare test environment and test JWT issuance. Run the commands from the repository root. For the initial deployment, follow steps 1–6 in order. For redeployment or failures, see the later sections.

This procedure covers staging on `workers.dev` or on an optional custom domain. The admin console uses passkey authentication only. These deployment commands do not configure Cloudflare Access or credential exchange with external providers.

Verification status (2026-10-27): 21 local E2E cases, dry runs for five Workers, 10 shared E2E cases on Cloudflare staging, and a caller suspension test have passed. See [release status](../reference/release-status.md) for what remains unverified.

## 1. Prepare the runtime and Cloudflare permissions

Use Node.js 24 or later and pnpm 12.15.0 as specified in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
```

Confirm the target account ID and its `workers.dev` subdomain. The deployer needs permissions to deploy Workers, create and migrate D1 databases, update D1 data, and deploy Workflows. See the [Cloudflare permissions guide](https://developers.cloudflare.com/workers/authorization/workers/) for Wrangler login and API token permissions.

Separately, prepare an API token that allows the Rotation Controller to register signing keys as issuer Worker secrets. Grant Workers Scripts edit and read permissions for the target account, and set the token in the local environment variable `OIDC_ROTATION_API_TOKEN`. The Controller uses this token to register and delete secrets and check deployment versions.

The following example prompts for the value in zsh without displaying it.

```zsh
read -rs 'OIDC_ROTATION_API_TOKEN?Rotation API token: '
printf '\n'
export OIDC_ROTATION_API_TOKEN
```

This variable is required when running `staging:deploy`. `staging:check`, `staging:bootstrap`, and `staging:test` do not read it directly. Prepare Wrangler authentication and the Controller token separately for their respective purposes.

## 2. Configure the deployment target

```sh
pnpm staging:configure \
  --account-id <CLOUDFLARE_ACCOUNT_ID> \
  --workers-subdomain <WORKERS_SUBDOMAIN>
```

Replace `<...>` with actual values. Do not include `https://` or `.workers.dev` in the subdomain. For example, if the account subdomain is `example-account.workers.dev`, specify `example-account`.

The default resource name prefix is `oidc`. To change it, add `--prefix <worker-name>` during initial configuration. The name must start with a lowercase letter and contain 3–41 lowercase letters, digits, or hyphens. The issuer Worker uses the specified name directly; other resources append suffixes such as `-admin`. To create another test environment, specify a prefix such as `--prefix oidc-staging`.

To serve the issuer from a custom domain, add `--public-url https://oidc.example.com`. The value must be an HTTPS URL without credentials, query, fragment, or trailing slash. The generated issuer configuration then uses it as `ISSUER_URL`, adds a custom-domain route for its hostname, and disables the issuer's `workers.dev` URL. The admin console moves to `<public URL>/admin/`.

Settings are saved to `.deploy/staging/settings.json`. The command rejects an account, subdomain, prefix, or public URL that differs from the existing settings. Manage separate environments in separate checkouts.

## 3. Check the build before deployment

```sh
pnpm staging:check
```

This builds the admin console, checks all five Workers (issuer, rotation, admin, receiver, and smoke) with `wrangler deploy --dry-run`, and generates binding types. It does not create or update remote resources. If D1 has not been created yet, this check uses placeholder database IDs.

To check only the build without configuring a deployment target or authentication, run:

```sh
pnpm staging:check --sample
```

Sample configuration is written to `.deploy/sample/`. `--sample` is available only for check and cannot be used with deploy. A successful dry run still requires verification of permissions and connectivity in the actual environment.

## 4. Deploy D1 and the Workers

Run this in a terminal with Wrangler authentication and `OIDC_ROTATION_API_TOKEN` configured.

```sh
pnpm staging:deploy
```

The command performs these steps in order:

1. Checks Wrangler authentication and creates, with `--location apac`, each D1 database that has no saved database ID.
2. Applies pending migrations remotely to the Policy, Key Registry, and Admin D1 databases.
3. Generates the CSRF secret and smoke test token on the first run, then builds the admin console.
4. Deploys issuer → rotation → admin → receiver → smoke. The rotation deployment also includes the key generation Workflow.

With the default prefix, it creates the following resources.

| Type     | Name                     | Endpoint / purpose                                                                                                                                                                                              |
| -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker   | `oidc`                   | `https://oidc.<WORKERS_SUBDOMAIN>.workers.dev`. Public HTTP serves discovery and JWKS and forwards `/admin/` to `oidc-admin` through the `ADMIN` binding; issuance uses internal RPC. Hourly cleanup Cron       |
| Worker   | `oidc-rotation`          | No public URL. RPC for key generation and rotation; five-minute Cron                                                                                                                                            |
| Worker   | `oidc-admin`             | No public URL of its own. The admin console with passkey authentication, reached at `https://oidc.<WORKERS_SUBDOMAIN>.workers.dev/admin/`; five-minute Cron                                                     |
| Worker   | `oidc-smoke`             | `https://oidc-smoke.<WORKERS_SUBDOMAIN>.workers.dev`. Test caller protected by a test token                                                                                                                     |
| Worker   | `oidc-receiver`          | No public URL. E2E relying party that validates JWTs and allows only authenticated API calls                                                                                                                    |
| D1       | `oidc-policy`            | `clients`, `audiences`, `client_audience_grants`, `policy_audit_events`, `issuance_audit_events`, `issuance_metrics`, `issuance_rate_limits`                                                                    |
| D1       | `oidc-keys`              | `signing_keys`, `issuance_reservations`, `rotation_runs`, `rotation_evidence`, `rotation_schedules`, `rotation_proposals`, `rotation_actions`                                                                   |
| D1       | `oidc-admin`             | `operators`, `operator_identities`, `passkey_credentials`, `webauthn_challenges`, `access_step_up_challenges`, `admin_sessions`, `bootstrap_invites`, `auth_rate_limits`, `admin_audit_events`, `health_checks` |
| Workflow | `oidc-rotation-workflow` | Server-side key generation and switching                                                                                                                                                                        |

Only two hosts are public: the issuer and the smoke Worker. The admin console is served through the issuer host under `/admin/`, and its management API requires authentication. The smoke Worker requires a test token. It can initiate key generation for testing, so do not reuse it in production.

The command handles deployment configuration and secret uploads. See the [official guide](https://developers.cloudflare.com/workers/configuration/secrets/) for how Cloudflare handles secrets. After deployment, you can remove the value from the current shell with `unset OIDC_ROTATION_API_TOKEN`, but it is also saved in a local file described below.

When it finishes, the command prints `Run pnpm staging:bootstrap and pnpm staging:test.` The two commands do not depend on each other. This guide runs `staging:test` first, for the reasons in step 5.

## 5. Generate the initial signing key and test issuance

Run this before adding audiences through the admin console, and before `staging:bootstrap`.

```sh
pnpm staging:test
```

If there is no active key, the smoke Worker initiates key generation through the Rotation Controller. The prepublication wait is 60 seconds, and the command waits up to 3 minutes for the first key to become active. **Signing keys are not generated during deployment. They are generated by the first test run.**

Run it first for two reasons:

- The first activation checks the JWKS cache setting of every audience already registered for the algorithm. With no audiences yet, nothing can block it.
- The bootstrap invitation expires 15 minutes after it is created. Creating it after the test leaves the whole window for registering the passkey.

After the key becomes active, the command registers a test audience, caller, and grant in Policy D1 and verifies the following:

- Tokens can be issued using fixed Service Binding props, and RS256 signatures can be verified using the public JWKS.
- Issuance for an audience without a grant is rejected.
- Suspending the test caller takes effect on the next issuance. The caller is re-enabled after the test.
- Unauthenticated admin API requests to `/admin/api/me`, `/admin/api/clients`, and `/admin/api/keys` return 401, and the issuer's HTTP issuance routes return 404.

On success, the command prints `PASS:` lines followed by a final line beginning with `Staging smoke test passed.`. The smoke Worker does not return JWT contents or private keys in HTTP responses. This test does not exchange credentials with AWS or other providers.

If audiences for the algorithm are already registered, the Controller checks their JWKS cache settings before activating the first key. An audience with no cache limit blocks the switch. Later rotations also require relying-party confirmations; see [Verify an assertion](./verifying-assertions.md#jwks-caching-and-rotation).

### E2E tests between Workers

Running these tests locally requires no Cloudflare login or deployment.

```sh
pnpm test:e2e
```

This starts the actual issuer Worker, caller, and relying party as separate workerd Workers. It exercises Service Binding `ctx.props`, D1, RSA signatures, JWKS, and HTTP Bearer tokens without mocking RPC or signature verification. Signing keys are test keys generated at runtime, and the tests do not access remote environments. These tests are also included in the regular `pnpm test` command.

In a deployed environment, `pnpm staging:test` runs the same 10 cases after the smoke tests.

| Case                                | Verification                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `valid`                             | Sending an SDK-issued token to the receiver in the Bearer header returns 200                                              |
| `missing-token` / `malformed-token` | Missing or malformed tokens return 401                                                                                    |
| `tampered-token`                    | A token with a modified signature returns 401                                                                             |
| `wrong-audience`                    | A legitimately issued token for another granted audience returns 401                                                      |
| `wrong-subject`                     | A legitimately issued token using another caller's fixed props returns 401                                                |
| `wrong-issuer`                      | A receiver configuration that does not match the trusted issuer returns 401                                               |
| `expired-token`                     | A token valid for 2 seconds for a dedicated audience returns 200 before expiration and 401 afterward using the same token |
| `unique-tokens`                     | Four concurrent issuances produce distinct `jti` values, and the receiver can validate all tokens                         |
| `audience-denied`                   | Issuance for an audience without a grant is rejected before sending to the receiver                                       |

The receiver validates RS256, issuer, subject, audience, required claims, expiration, and a maximum lifetime of 300 seconds. It retrieves JWKS from the issuer's public HTTP handler through a Service Binding and has no key or database bindings. The `/check` probe separately verifies JWKS retrieval over the internet. `/wrong-issuer` is a test-only path for verifying rejection of an issuer mismatch.

In addition to the cases above, the 21 local cases cover caller suspension and re-enablement, grant deletion, unregistered callers, missing props, no active key, missing key secrets, issuance limits, signature algorithms disallowed by the relying party, configuration overrides through request values, missing test authentication, and the absence of a public HTTP issuance route. The deployed tests also verify suspension of a dedicated caller and re-enable it afterward. Rejection tests that change keys or issuance limits run only locally.

The tests use the reserved callers `<prefix>-smoke` and `<prefix>-smoke-other`, and the audience `urn:<prefix>:smoke` with its `:other` / `:short-lived` variants. Do not assign these to regular applications. HTTP responses contain only results; JWT contents and private keys are not output. AWS STS and other provider compatibility are outside the scope of these tests.

## 6. Register the initial administrator

```sh
pnpm staging:bootstrap
```

This creates the initial `security-admin` and an invitation valid for 15 minutes. Open `.deploy/staging/bootstrap.json`, whose path the command displays, in a local editor and complete these steps:

1. Open the URL in `adminUrl` in a browser. It is the issuer URL followed by `/admin/`, for example `https://oidc.<WORKERS_SUBDOMAIN>.workers.dev/admin/`.
2. Choose **Register with an invitation or recovery code** and enter `invitationToken` in **Invitation or recovery code**.
3. Register a passkey and confirm that you can access the admin console.

This command runs only when Admin D1 contains no operators. An existing `security-admin` must invite additional operators through the admin console. You can delete the invitation file after registration.

If the invitation expires before you register a passkey, do not run `staging:bootstrap` again. Issue a recovery invitation for the bootstrap administrator with `pnpm ops recover-admin`, as described in the [operations guide](./operations.md#recovery-after-all-passkeys-are-lost).

## Use saved settings for redeployment

After updating the code, set the Controller API token in the environment variable and run:

```sh
pnpm staging:check
pnpm staging:deploy
pnpm staging:test
```

`staging:deploy` reuses the saved D1 databases and applies pending migrations. Do not rerun `staging:bootstrap`; it is for initial setup only. `staging:test` uses the active key if one exists and does not rotate keys on every run.

The following files remain in `.deploy/staging/`. This directory is excluded from Git tracking.

| File                                                                        | Contents                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `settings.json`                                                             | Deployment target and IDs of created D1 databases. Used for redeployment |
| `issuer.json`, `rotation.json`, `admin.json`, `receiver.json`, `smoke.json` | Generated Wrangler configuration                                         |
| `secrets.json`, `admin.secrets.json`, `smoke.secrets.json`                  | CSRF secret and test token                                               |
| `rotation.secrets.json`                                                     | Cloudflare API token for the Controller                                  |
| `bootstrap.json`                                                            | Initial administrator invitation details                                 |
| `wrangler.log`, `operation.sql`                                             | Execution log and the most recently executed initialization or test SQL  |

Do not commit or share files containing secrets or invitations. When handing over an environment, use the channel designated for transferring secrets between deployers. Deleting `.deploy/staging/` does not delete Cloudflare resources, but it removes local records such as database IDs and test tokens.

## Identify the failed stage

| Situation                                                | Checks and actions                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication expired or not logged in                  | Check authentication with `pnpm exec wrangler login` and `pnpm exec wrangler whoami`                                                                                                 |
| Controller token missing or insufficient permissions     | Check the environment variable `OIDC_ROTATION_API_TOKEN` and permissions for the target account. For key generation failures after deployment, also check the Workflow logs          |
| ID parsing failed after D1 creation                      | Compare the database created in Cloudflare with `settings.json`. The command does not automatically adopt existing databases by name                                                 |
| First-key activation does not complete within 3 minutes  | Check the rotation Workflow status and failure point in the Cloudflare dashboard. Inspect the API token, issuer JWKS, deployment version, and cache settings of registered audiences |
| bootstrap is rejected because an operator already exists | Have an existing `security-admin` send an invitation                                                                                                                                 |
| The bootstrap invitation expired                         | Run `pnpm ops recover-admin` for the bootstrap administrator. See the [operations guide](./operations.md#recovery-after-all-passkeys-are-lost)                                       |

You can also view the command list with `pnpm staging:configure --help`. If deployment does not resolve the issue, send the failed command, HTTP status, and logs with secrets removed to the deployer. See also [Troubleshooting](./troubleshooting.md).

In this document, issuer means the token-issuing Worker, caller means the Worker requesting issuance, and grant means the authorization relationship between a client and an audience. See [`scripts/staging.mjs`](https://github.com/akita0724/workers-workload-identity/blob/main/scripts/staging.mjs) and [`scripts/deployment-config.mjs`](https://github.com/akita0724/workers-workload-identity/blob/main/scripts/deployment-config.mjs) for the implementation.

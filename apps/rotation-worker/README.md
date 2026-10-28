# Rotation Controller Worker

The Rotation Controller generates signing keys and moves them through their states (`prepared`, `active`, `verifying`, `removed`). It is deployed as `oidc-rotation` by default.

## What it does

- **Generates keys** (RS256 with a 3072-bit modulus, or ES256) and stores each private key as a secret on the issuer Worker through the Cloudflare Secrets API (`PUT .../secrets`). Retired keys are deleted with `DELETE .../secrets/<name>`.
- **Verifies before activation.** It reads the issuer's deployments and versions through the Cloudflare API only to confirm that the version serving 100% of traffic binds the new secret, and fetches the issuer's public JWKS to confirm the new key is published. It never deploys the issuer Worker.
- **Records state** in the Key Registry D1 database (`KEY_DB`) and reads audience settings from the Policy D1 database (`POLICY_DB`).
- **Runs each rotation as a Workflow** (`RotationWorkflow`): stage the secret and publish the public key, wait for the prepublication period, check the relying-party gates and activate, wait for the retirement deadline, then retire the old key. Steps retry, and a failure that is not safe to retry stops for manual recovery.
- **Serves the admin console** through the `RotationRpc` entrypoint, which accepts calls only through a Service Binding with the fixed props `{ "caller": "admin" }`. The props identify the binding, not the calling Worker: the generated staging configuration also gives this binding to the smoke Worker for tests, so grant it only to the Admin Worker in production. An `operator` or `security-admin` can propose a rotation; approval requires a `security-admin` other than the proposer. A `security-admin` can also start a rotation directly. A cron trigger every five minutes starts scheduled rotations and resumes runs that were not started.

The Rotation Controller does not accept key material or arbitrary Worker names from the admin console. The target issuer is fixed by `ISSUER_URL`, `CF_ACCOUNT_ID`, and `CF_ISSUER_SCRIPT`, and the `CF_API_TOKEN` secret authorizes the Cloudflare API calls. The public HTTP handler returns 404 for every request.

## Status

This package contains an initial implementation of the controller and Workflow, tests, and `wrangler.example.jsonc`. Least-privilege Cloudflare API permissions, key generation, deployment conflicts, and recovery procedures have not been validated in a real account. Do not deploy it to production as is.

```sh
pnpm --filter @workers-workload-identity/rotation-worker typecheck
pnpm --filter @workers-workload-identity/rotation-worker test
```

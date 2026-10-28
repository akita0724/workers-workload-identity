# Provider validation examples

[English](README.md) | [日本語](README.ja.md)

These examples are for live provider validation during the alpha. Each one pairs Terraform for the provider side with a probe Worker that requests an assertion from the issuer over the `IssuerRpc` Service Binding, exchanges it at the provider, and calls one read-only API. Support for every provider is **unverified**; see [Provider support](../docs/reference/provider-support.mdx) and the [live provider validation plan](../docs/design/provider-validation.md). Use them only in test accounts.

The probe Worker never returns the assertion or the exchanged credential in its response.

| Directory                              | What Terraform creates                                                                  | API the Worker calls                       |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ |
| [aws](aws/README.md)                   | IAM OIDC provider and a role whose trust policy is limited to one `aud` and `sub`       | STS `GetCallerIdentity`                    |
| [google-cloud](google-cloud/README.md) | Workload Identity Pool and Provider, a custom role with one permission, and its binding | Cloud Resource Manager `projects.get`      |
| [claude](claude/README.md)             | Federation issuer and rule (community Terraform provider)                               | Claude Models API                          |
| [openai](openai/README.md)             | Nothing; records the IDs of a provider and mapping created in the OpenAI Platform       | OpenAI Models API                          |
| [azure](azure/README.md)               | Entra application, federated credential, a test resource group, and Reader on it        | Azure Resource Manager resource group read |

The Azure example targets Microsoft Entra, which is a future candidate outside the initial validation gate (AWS, Google Cloud, Claude API, and OpenAI API).

`caller.wrangler.jsonc` shows the minimal Service Binding for any caller Worker.

## Shared preparation

1. Deploy the issuer from this repository to the same Cloudflare account. Confirm the real issuer URL, the public discovery metadata and JWKS, and an active RS256 key. Limit who can edit Workers, Service Bindings, and their `props` to trusted principals.
2. In the example's `worker/wrangler.jsonc`, set `services[0].service` to the issuer Worker name. Register `props.clientId` as a client on the issuer with a fixed subject, and grant it the `AUDIENCE` value. These must match the issuer, subject, and audience in Terraform. RS256 and a 300-second lifetime are recommended for each audience.
3. Follow the example's README to prepare Terraform and the provider settings. Review `terraform init` and `terraform plan` before you apply. If a resource such as an IAM OIDC provider already exists, adapt the example to your environment instead of creating a duplicate.
4. Copy the Terraform outputs and other IDs into `vars` in `worker/wrangler.jsonc`. Restrict access to the Worker (for example, with Cloudflare Access), then run this from the repository root. Requests fail authentication until `PROBE_SECRET` is set.

```sh
pnpm exec wrangler deploy --config examples/aws/worker/wrangler.jsonc
```

5. In `examples/aws/worker`, create a long random secret and a header file, and set the secret on the Worker. Replace `aws` in the path with the example's directory.

```sh
cd examples/aws/worker
umask 077
openssl rand -hex 32 > .probe-secret
pnpm exec wrangler secret put PROBE_SECRET --config wrangler.jsonc < .probe-secret
printf 'Authorization: Bearer %s\n' "$(cat .probe-secret)" > .probe-headers
curl --fail-with-body -X POST -H @.probe-headers https://YOUR_WORKER_URL/
```

On success, the Worker returns `{"ok":true,"exchange":"ok","api":"..."}`. On any failure after authentication, it returns HTTP 502 with `{"ok":false,"error":"probe_failed"}` so that no credential leaks. A missing or wrong secret gets 401, and any request other than `POST /` gets 404. Find the failing step in the issuer's audit log and the provider's authentication logs. Each run requests a new assertion; the Claude API, for example, rejects an exchange that reuses a `jti`.

## Clean up

Review what `terraform destroy` will remove, then delete the probe Worker, its secret, the trust configuration, the other resources, and the local `.probe-secret` and `.probe-headers` files. Store Terraform state and IDs securely. AWS STS credentials last at least 15 minutes and remain valid after the issuer's assertion expires.

## Local test

From the repository root, run `node --test examples/shared/probe.test.mjs`. It tests the probe against simulated providers and does not show that a real token exchange succeeds.

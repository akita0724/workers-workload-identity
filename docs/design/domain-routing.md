---
title: Public host and root path
description: Configure host and path boundaries for the issuer, admin console, and documentation
sidebar:
  order: 12
---

**Status:** Implemented for passkey mode. Single-host Cloudflare Access step-up is not implemented.

The issuer and the passkey admin console share one hostname. Set the issuer URL with `ISSUER_URL`; the admin console lives at that URL followed by `/admin/`. Issuance RPC and Rotation Controller responsibilities remain separate.

Set the public URL when configuring staging, for example `pnpm staging:configure --account-id <id> --workers-subdomain <subdomain> --public-url https://identity.example.com/team`. Do not include a trailing slash. Custom hostnames require an active Cloudflare zone. Without this option, the issuer's workers.dev hostname is used.

In this example, discovery is served at `/team/.well-known/openid-configuration`, JWKS at `/team/jwks.json`, and the admin console at `/team/admin/`. Register the complete issuer URL, including its path, with relying parties. Changing an existing issuer URL requires migrating their trust configuration.

The issuer returns 404 for a request whose origin differs from the origin of `ISSUER_URL`, and for a path outside the issuer URL's path.

Documentation is published only through GitHub Pages. Do not attach documentation assets or a `/docs` route to the runtime deployment.

Cloudflare Access step-up still requires a separate origin. Single-host Access step-up is not implemented; the automated staging deployment uses passkeys.

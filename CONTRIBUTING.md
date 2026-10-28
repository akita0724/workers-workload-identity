# Contributing

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

Thank you for helping improve `workers-workload-identity`. The project is in alpha, and its protocol and package boundaries may still change. Start with a small, reviewable change and describe the security or compatibility assumptions it affects.

This project is licensed under the [MIT License](LICENSE). Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up the workspace

Use Node.js 24 or later and the pnpm version declared in the root `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm test:e2e
```

Do not add real account IDs, client registrations, provider identifiers, JWTs, private keys, API tokens, passkey data, or invitations to fixtures or documentation. Use clearly fictitious values such as `example.com`.

## Make focused changes

- Keep domain packages independent from Cloudflare, Hono, D1, JOSE, and browser code.
- Share public RPC and DTO shapes through `packages/contracts`; do not expose database rows, secrets, or private bindings there.
- Keep issuance reachable only through the named Service Binding RPC. Do not add a public HTTP token endpoint or a loopback path that accepts dynamic caller props.
- Treat changes to claims, RPC shapes, public errors, discovery, JWKS, or key states as protocol changes.
- Add negative tests for authentication and authorization changes, not only success cases.
- Never log an assertion, private key, remote exception payload, or exchanged credential.

## Update documentation in both languages

English is the source language. English pages live in `docs/` (`docs/index.mdx`, `docs/oidc.mdx`, `docs/getting-started.mdx`, `docs/guides/`, `docs/reference/`, `docs/design/`), and the Japanese mirror uses the same relative paths under `docs/ja/`. A change is incomplete until both pages say the same thing with the same sections, tables, and code blocks, so update both languages in the same pull request.

`pnpm docs:translations:check` compares each Japanese page with the English source hash recorded in `apps/docs/blume.translations.json` and fails when the English page has changed since. After updating the Japanese page, update its recorded hash so the check passes.

Use the terms defined in the [glossary](docs/reference/glossary.md) ([Japanese](docs/ja/reference/glossary.md)).

Build the docs before opening a pull request:

```sh
pnpm docs:translations:check
pnpm docs:validate
pnpm docs:build
pnpm docs:audit:i18n
```

## Documentation style

- **Terms (English):** say "workload assertion" on first mention, then "assertion". Use "JWT" for the format, "relying party" for any system that receives and verifies an assertion, and "provider" only for external services such as AWS. Use "caller", "issuer", "client", "audience", "grant", and "subject" as defined in the glossary, plus "alpha" (the current release stage), "Rotation Controller", and "admin console". Use "pre-release" only as the generic SemVer or GitHub term.
- **Terms (Japanese):** use ワークロードアサーション on first mention, then アサーション. Keep relying party in English (do not use 接続先, 受信先, 信頼先, or 受信側). Use プロバイダー for external services only. Keep caller, issuer, client, audience, grant, and subject in English, and use アルファ版 (the current release stage), 管理画面, and 鍵ローテーション. Use プレリリース only as the generic SemVer or GitHub term.
- **English style:** sentence-case headings, US spelling, ISO 8601 dates (2026-10-28), and short declarative sentences. Avoid internal jargon.
- **Japanese style:** user guides (`index`, `getting-started`, `oidc`, `guides/`, `reference/`) use です・ます; design pages (`design/`) use である. Translate ordinary English words (プロトコル, パッケージ, ログ, 所有者, テスト, 行) and keep code identifiers, product names, and glossary terms in English. Keep spacing between Japanese text and Latin words consistent within a page.
- **Links and anchors:** link between docs with relative file links (`./x.md`, `../guides/x.md`). Link to repository files outside `docs/` with absolute GitHub URLs, because the published site cannot reach them. Do not pin anchors on English headings; English links use the automatic English slugs, and Japanese links use the Japanese headings.
- **Status lines:** start each design page with a bold paragraph, for example `**Status:** Implemented. …` (Japanese: `**状態:** 実装済み。…`). Use Implemented, Partially implemented, or Target design (実装済み, 一部実装, 目標設計); a page of sources uses Reference material (参照資料). Do not use GitHub alerts (`> [!NOTE]`); the documentation site does not render them in `.md` files. Do not use `:::` directives in `.md` files; they work only in MDX.

## Run the checks

Continuous integration (`.github/workflows/checks.yml`) runs these commands. Run them before requesting review:

```sh
pnpm boundaries
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm --filter @workers-workload-identity/admin-ui exec playwright install --with-deps chromium
pnpm --filter @workers-workload-identity/admin-ui test:ui
pnpm staging:check --sample
pnpm docs:translations:check
pnpm docs:validate
pnpm docs:build
pnpm docs:audit:i18n
```

Run the smallest relevant command while iterating. `pnpm build` builds every workspace package and is useful when you change build output, such as the admin console or the client SDK. Real staging deployment changes Cloudflare resources and requires explicit authorization from the environment's owner.

## Issues and pull requests

Open issues with one of the templates in `.github/ISSUE_TEMPLATE/` (bug report, documentation, or feature request); blank issues are disabled. Pull requests use `.github/pull_request_template.md`. In a pull request, explain:

- the user or operator problem;
- the chosen behavior and alternatives considered;
- affected trust boundaries and failure modes;
- compatibility or migration impact;
- tests performed; and
- documentation updated.

Do not paste secrets or raw assertions into an issue or pull request. Report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

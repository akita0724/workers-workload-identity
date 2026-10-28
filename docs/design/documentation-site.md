---
title: Documentation site
description: How the bilingual documentation site is built, translated, validated, and published to GitHub Pages
---

**Status:** Implemented. The site builds locally and in CI, and is published to GitHub Pages whenever a GitHub Release is published, including a pre-release such as an alpha.

## Architecture

The repository's `docs/` directory is the documentation source of truth. Blume builds a static site that GitHub Actions deploys to GitHub Pages. The site uses static pages, search, and a sitemap; it does not use server-dependent features such as the assistant, MCP endpoint, or API playground proxy. Blume does not influence the admin UI technology choice. See Blume's [GitHub Pages guide](https://useblume.dev/guides/markdown-docs-github-pages) and [static versus server features](https://useblume.dev/guides/static-vs-server-documentation).

English is the default locale and lives at the `docs/` root. The Japanese mirror uses the same relative paths under `docs/ja/`. Sidebar groups come from the `meta.ts` file in each folder: `guides/`, `reference/`, and `design/`. The configuration sets `fallbackLocale: null`, so a page with a missing translation is not published under the other locale's URL.

Blume is isolated in `apps/docs/package.json`; all content remains in `docs/`. `apps/docs/blume.config.ts` reads `GITHUB_REPOSITORY` in Actions and falls back to `akita0724/workers-workload-identity` elsewhere. Ordinary project Pages publish at `https://<owner>.github.io/<repo>`; a repository named `<owner>.github.io` uses no base path. Recheck `DOCS_SITE_ORIGIN` and the base setting when moving to a custom domain.

## Translation rules

- A pull request that changes an English page updates its Japanese mirror in the same pull request.
- The same pull request updates the translation ledger `apps/docs/blume.translations.json`. For each source file, the ledger records a hash per locale: the first 16 hexadecimal characters of the SHA-256 of the English source text that the translation matches.
- `pnpm docs:translations:check` rejects a missing translation or a ledger hash that no longer matches the source.

## Workflow and publishing

1. With Node.js 24 and the pnpm version in the root `package.json` (12.15.0), run `pnpm install --frozen-lockfile`, `pnpm docs:translations:check`, `pnpm docs:validate`, `pnpm docs:build`, and `pnpm docs:audit:i18n`. The docs publish workflow (`.github/workflows/docs-pages.yml`) installs only the docs package and its dependencies from the root lockfile; the checks workflow (`.github/workflows/checks.yml`) installs the whole workspace. Recheck current pnpm, Blume, and Actions compatibility before each release.
2. Preview internal links, deep URLs, `_astro/` assets, search in each locale, `sitemap.xml`, canonical URLs, and reciprocal `hreflang`.
3. Keep organization secrets, real tokens, and unreleased configuration out of `docs/`.
4. GitHub Pages uses **GitHub Actions** as its source, so the site is deployed from the workflow artifact rather than from a branch. Publishing any GitHub Release, including a pre-release such as an alpha, triggers `.github/workflows/docs-pages.yml` and deploys the site. A push to `main` alone does not deploy the site.

GitHub Pages is public static hosting. Do not place internal-only design information in the published content set. Blume build output under `apps/docs/dist/` and generated `.blume/` directories are not committed.

## Dependency updates

The repository pins versions current on 2026-10-24. Update `package.json`, `pnpm-lock.yaml`, and GitHub Actions together after verifying registry and upstream releases. The `pnpm-workspace.yaml` `minimumReleaseAgeExclude` entry was added for newly published Blume 2.2.5 and should be removed during a later update if it is no longer needed. Do not link agent skills distributed by dependencies into the repository.

The Blume 2.2.5 dependency graph currently reports a peer dependency warning between the `oxc-transform-react` range requested by `@astrojs/react@7.1.1` and the newer range requested by `@vitejs/plugin-react@6.1.2`. Link validation and static builds succeed, but recheck the warning on upstream updates.

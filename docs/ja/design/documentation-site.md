---
title: ドキュメントサイト
description: 日英のドキュメントサイトのビルド、翻訳、検証、GitHub Pages への公開方法
---

**状態:** 実装済み。ローカルと CI でビルドでき、GitHub Release（アルファ版などのプレリリースを含む）を publish するたびに GitHub Pages へ公開する。

## 構成

文書ソースはこのリポジトリの `docs/` を正本とする。Blume の静的ビルドを GitHub Actions で GitHub Pages へデプロイする。静的なページ・検索・サイトマップを使い、サーバーを要する assistant、MCP endpoint、API playground proxy は使わない。Blume は管理画面のフロントエンド技術選定には影響しない。[Blume の GitHub Pages 手順](https://useblume.dev/guides/markdown-docs-github-pages)、[静的機能とサーバー機能](https://useblume.dev/guides/static-vs-server-documentation) を参照する。

英語を既定 locale とし、`docs/` 直下に置く。日本語の翻訳は同じ相対パスで `docs/ja/` に置く。サイドバーのグループは各フォルダ（`guides/`、`reference/`、`design/`）の `meta.ts` で定義する。設定は `fallbackLocale: null` とし、翻訳が欠けたページを別 locale の URL で公開しない。

`apps/docs/package.json` に Blume の依存関係を閉じ、本文は `docs/` に置く。`apps/docs/blume.config.ts` は GitHub Actions では `GITHUB_REPOSITORY` を読み、それ以外では `akita0724/workers-workload-identity` を既定値とする。通常の project Pages では `https://<owner>.github.io/<repo>` に公開し、リポジトリ名が `<owner>.github.io` の場合は base path を付けない。公開先を独自ドメインに変える場合は `DOCS_SITE_ORIGIN` と base 設定を再確認する。

## 翻訳の規則

- 英語ページを変更する pull request では、同じ pull request で日本語のミラーも更新する。
- 同じ pull request で翻訳台帳 `apps/docs/blume.translations.json` も更新する。台帳はソースファイルごとに、翻訳が対応する英語ソース本文の SHA-256 の先頭 16 桁（16 進）を locale 別に記録する。
- `pnpm docs:translations:check` は翻訳の欠落と、ソースと一致しない台帳の hash を拒否する。

## 作業と公開

1. Node.js 24 とルート `package.json` 指定の pnpm（12.15.0）で `pnpm install --frozen-lockfile`、`pnpm docs:translations:check`、`pnpm docs:validate`、`pnpm docs:build`、`pnpm docs:audit:i18n` を実行する。ドキュメント公開ワークフロー（`.github/workflows/docs-pages.yml`）は docs パッケージとその依存だけをルートの lockfile からインストールし、検査ワークフロー（`.github/workflows/checks.yml`）はワークスペース全体をインストールする。各リリースの前に pnpm・Blume・Actions の現行版と互換性を再確認する。
2. サイト内リンク、深い URL、`_astro/` のアセット、各 locale の検索、`sitemap.xml`、canonical URL、相互 `hreflang` をプレビューで確認する。
3. 組織の秘密情報、実トークン、未公開の設定を `docs/` に入れない。
4. GitHub Pages の source は **GitHub Actions** とし、ブランチではなくワークフローの artifact からデプロイする。GitHub Release（アルファ版などのプレリリースを含む）を publish するたびに `.github/workflows/docs-pages.yml` が起動し、サイトをデプロイする。`main` への push だけではサイトを公開しない。

GitHub Pages は公開の静的ホストである。内部限定の設計情報を公開対象に置かない。Blume のビルド出力 `apps/docs/dist/` と生成される `.blume/` は Git に含めない。

## 依存関係の更新

2026-10-24 時点の現行版を固定する。更新時は registry と上流のリリースを確認し、`package.json`、`pnpm-lock.yaml`、GitHub Actions を揃えて更新する。`pnpm-workspace.yaml` の `minimumReleaseAgeExclude` は公開直後の Blume 2.2.5 を使うために追加した例外であり、後の更新で不要になれば削除する。依存パッケージが配布する agent skill はリポジトリにリンクしない。

Blume 2.2.5 の依存グラフでは、`@astrojs/react@7.1.1` が要求する `oxc-transform-react` の範囲と、`@vitejs/plugin-react@6.1.2` が要求するより新しい範囲の間に peer dependency 警告がある。リンク検証と静的ビルドは成功しているが、上流の更新時に警告を再確認する。

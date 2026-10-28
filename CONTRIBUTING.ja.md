# コントリビューションガイド

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

`workers-workload-identity` の改善にご協力いただき、ありがとうございます。現在はアルファ版であり、プロトコルとパッケージの境界が変わる可能性があります。小さくレビューしやすい変更から始め、影響するセキュリティ上の前提と互換性を説明してください。

このプロジェクトは [MIT ライセンス](LICENSE)で提供しています。参加するすべての人に [Code of Conduct](CODE_OF_CONDUCT.md)（英語）の遵守をお願いします。

## ワークスペースを用意する

Node.js 24 以上と、ルートの `package.json` に指定された pnpm を使用します。

```sh
pnpm install --frozen-lockfile
pnpm test:e2e
```

実際のアカウント ID、client の登録情報、プロバイダーの ID、JWT、秘密鍵、API トークン、パスキーの情報、招待をフィクスチャや文書に追加しないでください。`example.com` のように架空であることが分かる値を使います。

## 変更を小さく保つ

- ドメインパッケージを Cloudflare、Hono、D1、JOSE、ブラウザー向けのコードから独立させてください。
- 公開 RPC と DTO の形は `packages/contracts` で共有し、DB の行、secret、非公開の binding を公開しないでください。
- 発行には名前付きの Service Binding RPC からだけ到達できるようにしてください。公開 HTTP のトークンエンドポイントや、動的な caller props を受け付けるループバック経路を追加しないでください。
- クレーム、RPC の形、公開エラー、discovery、JWKS、鍵の状態の変更は、プロトコルの変更として扱ってください。
- 認証・認可の変更には、成功例だけでなく拒否されることを確かめるテストを追加してください。
- アサーション、秘密鍵、リモートの例外の内容、交換済みの資格情報をログに出さないでください。

## 日英の文書を同時に更新する

英語が原文です。英語のページは `docs/`（`docs/index.mdx`、`docs/oidc.mdx`、`docs/getting-started.mdx`、`docs/guides/`、`docs/reference/`、`docs/design/`）に置き、日本語の対訳は `docs/ja/` 以下の同じ相対パスに置きます。両方のページが同じ節、表、コードブロックで同じ内容を記載するまで、変更は完了ではありません。日英は同じ pull request で更新してください。

`pnpm docs:translations:check` は、`apps/docs/blume.translations.json` に記録された英語原文のハッシュと各日本語ページを照合し、英語ページがその後に変更されていると失敗します。日本語ページを更新したら、記録されたハッシュも更新して検査が通るようにしてください。

用語は[用語集](docs/ja/reference/glossary.md)（[英語](docs/reference/glossary.md)）の定義に従います。

pull request を作成する前に文書を検証します。

```sh
pnpm docs:translations:check
pnpm docs:validate
pnpm docs:build
pnpm docs:audit:i18n
```

## 文書のスタイル

- **用語（英語）:** 初出は "workload assertion"、以降は "assertion" とします。形式には "JWT"、アサーションを受け取って検証するシステムには "relying party"、AWS などの外部サービスにだけ "provider" を使います。"caller"、"issuer"、"client"、"audience"、"grant"、"subject" は用語集の定義に従い、"alpha"（現在のリリース段階）、"Rotation Controller"、"admin console" を使います。"pre-release" は SemVer と GitHub の一般用語としてだけ使います。
- **用語（日本語）:** 初出はワークロードアサーション、以降はアサーションとします。relying party は英語のまま使います（接続先、受信先、信頼先、受信側は使いません）。プロバイダーは外部サービスにだけ使います。caller、issuer、client、audience、grant、subject は英語のまま使い、アルファ版（現在のリリース段階）、管理画面、鍵ローテーションと書きます。プレリリースは SemVer と GitHub の一般用語としてだけ使います。
- **英語の文体:** 見出しは sentence case、米国式のつづり、日付は ISO 8601（2026-10-28）、短い平叙文を使います。内部の専門用語は避けます。
- **日本語の文体:** 利用者向けのページ（`index`、`getting-started`、`oidc`、`guides/`、`reference/`）はです・ます調、設計ページ（`design/`）はである調で書きます。一般的な英単語は日本語に訳し（プロトコル、パッケージ、ログ、所有者、テスト、行）、コードの識別子、製品名、用語集の用語は英語のまま残します。日本語と英字の間の空白は、ページ内で統一してください。
- **リンクとアンカー:** 文書間のリンクは相対ファイルリンク（`./x.md`、`../guides/x.md`）にします。公開サイトからは参照できないため、`docs/` 以外のリポジトリのファイルには GitHub の絶対 URL でリンクします。英語の見出しにアンカーを固定しないでください。英語のリンクは英語の自動スラッグを、日本語のリンクは日本語の見出しを使います。
- **状態の表示:** 設計ページの冒頭には太字の段落を置きます。たとえば `**状態:** 実装済み。…`（英語: `**Status:** Implemented. …`）と書きます。状態は実装済み、一部実装、目標設計（Implemented、Partially implemented、Target design）のいずれかです。出典をまとめたページは参照資料（Reference material）とします。GitHub のアラート（`> [!NOTE]`）は使わないでください。ドキュメントサイトは `.md` ファイル内のアラートを表示しません。`.md` ファイルでは `:::` ディレクティブを使わないでください（MDX でのみ使えます）。

## 検査を実行する

CI（`.github/workflows/checks.yml`）は次のコマンドを実行します。レビューを依頼する前に実行してください。

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

作業中は関連する最小限のコマンドを使ってください。`pnpm build` はワークスペースのすべてのパッケージをビルドします。管理画面や client SDK などのビルド結果に関わる変更で役立ちます。実際のステージング環境へのデプロイは Cloudflare のリソースを変更するため、環境の所有者の明示的な許可が必要です。

## issue と pull request

issue は `.github/ISSUE_TEMPLATE/` のテンプレート（不具合報告、文書、機能提案）から作成してください。テンプレートを使わない issue は作成できません。pull request には `.github/pull_request_template.md` が適用されます。pull request では次を説明してください。

- 解決する利用者または運用者の問題
- 選んだ動作と検討した代替案
- 影響する信頼境界と失敗条件
- 互換性または移行への影響
- 実行したテスト
- 更新した文書

secret や生のアサーションを issue や pull request に貼らないでください。脆弱性は [SECURITY.ja.md](SECURITY.ja.md) の非公開の手順で報告してください。

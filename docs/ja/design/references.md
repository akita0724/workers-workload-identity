---
sidebar:
  label: 根拠資料
---

# 仕様と一次資料

**状態:** 参照資料。2026-10-24 に確認した。リンク先の仕様変更を実装時とベータ版の前に再確認する。

## 標準

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) — OIDC の ID Token と Provider の一般的なモデル。本プロジェクトは全面実装せず、metadata/JWKS の形だけを利用する。
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html) — OP メタデータと discovery。
- [OpenID Federation 1.1](https://openid.net/specs/openid-federation-1_1-final.html) — 信頼チェーン。初期版の対象外。
- [RFC 7515: JSON Web Signature](https://www.rfc-editor.org/rfc/rfc7515.html) — JWS compact serialization と署名。
- [RFC 7518: JSON Web Algorithms](https://www.rfc-editor.org/rfc/rfc7518.html) — `RS256`、`ES256`、JWK の暗号パラメーター。
- [RFC 7519: JSON Web Token](https://www.rfc-editor.org/rfc/rfc7519.html) — JWT クレームと NumericDate。
- [RFC 7517: JSON Web Key](https://www.rfc-editor.org/rfc/rfc7517.html) — JWK/JWKS。
- [RFC 7521: Assertion Framework for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc7521.html) — assertion を認可 grant または client authentication に使う一般的枠組み。relying party が採用する場合に参照する。
- [RFC 7523: JWT Profile for OAuth 2.0 Client Authentication and Authorization Grants](https://www.rfc-editor.org/rfc/rfc7523.html) — JWT bearer assertion の標準 profile。relying party の token exchange 契約が適用を明示する場合に従う。
- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.html) — token exchange の一般仕様。各プロバイダーが独自の制約を追加するため、互換性は実機で確認する。
- [RFC 8725: JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html) — audience、アルゴリズム、用途分離。
- [RFC 9068: JWT Profile for OAuth 2.0 Access Tokens](https://www.rfc-editor.org/rfc/rfc9068.html) — 独自 API に access token を使う場合の候補。

## Cloudflare

- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) — Worker 間呼び出し。
- [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/) — account 全体と Worker 単位の編集・デプロイ権限。
- [Context (`ctx.props`)](https://developers.cloudflare.com/workers/runtime-apis/context/) — Binding 設定の `props` とその真正性、loopback の例外。
- [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) — Workers の暗号 API。
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) — secret binding。
- [Worker Secrets API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/) — script の secret の追加・更新。Rotation Controller が鍵のアップロードに使う。
- [Worker Deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/) — 指定 version のデプロイ。Rotation Controller は呼び出さない。
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) — 長時間の鍵ローテーションジョブ。
- [Workflow schedules](https://developers.cloudflare.com/workflows/build/trigger-workflows/) — 定期実行。
- [Workflow sleep/retry](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) — キャッシュ待機と再試行。
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — secret を含む環境変数のサイズ上限。
- [Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/) — バージョンと段階的デプロイ。
- [Gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/) — 配信バージョン間のずれ。
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/) — 現行の runtime 内テスト基盤。
- [Cloudflare Secrets Store](https://developers.cloudflare.com/secrets-store/) — アカウント単位の secret 保管。open beta。
- [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/) — 管理データと transaction。
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) — 主系読取とレプリカの整合性。
- [Cloudflare Access JWT の検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) — 署名・issuer・audience の確認。
- [Cloudflare Access application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) — 人間の `sub` と service token の違い。

## relying party

- [AWS: IAM OIDC provider の要件](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html) — discovery/JWKS と各クレーム。
- [AWS: STS AssumeRoleWithWebIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html) — 一時資格情報交換。
- [AWS: IAM OIDC condition keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html) — `aud`/`sub` 制限。
- [AWS: API Gateway JWT authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html) — JWKS キャッシュ等。
- [Google Cloud: 外部 OIDC による Workload Identity Federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers) — audience、署名形式、JWKS。
- [Claude API: Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) — issuer、rule、service account と token exchange。
- [Claude API: WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference) — JWT、アルゴリズム、JWKS キャッシュと交換 API。
- [OpenAI API: Workload identity federation](https://developers.openai.com/api/docs/guides/workload-identity-federation) — provider、service account mapping、JWKS と現行制約。
- [OpenAI API: Token exchange](https://developers.openai.com/api/reference/workload-identity-federation) — JWT の交換、必須クレーム、未対応 issuer の制約。
- [Microsoft Entra: Workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation) — issuer/subject/audience の信頼。
- [Microsoft Entra: Federation considerations](https://learn.microsoft.com/en-us/azure/active-directory/develop/workload-identity-federation-considerations) — 運用上の制約。

## ライブラリ

- [Hono の Cloudflare Workers ガイド](https://hono.dev/docs/getting-started/cloudflare-workers) — 公開 HTTP ルートのフレームワーク。
- [Hono JSX](https://hono.dev/docs/guides/jsx) — 比較したサーバー描画案。
- [TanStack Router](https://tanstack.com/router/latest/docs/overview) — 型付きの管理画面 navigation。
- [TanStack Query](https://tanstack.com/query/latest) — API 状態と mutation 後の再取得。
- [TanStack Start](https://tanstack.com/start/latest/docs/framework/react/overview) — SSR が必要になった場合の比較対象。
- [Workers SPA 配信](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/) — 静的 asset と API の route 制御。
- [Hono CSRF middleware](https://hono.dev/docs/middleware/builtin/csrf) — 適用条件を確認して補完する。
- [`jose`](https://github.com/panva/jose) — Workers をサポートする JOSE/JWT 実装。
- [Zod](https://zod.dev/basics) — 管理入力、実行時設定、DB 境界のスキーマ検証。
- [Turborepo configuration](https://turborepo.dev/docs/reference/configuration) — ワークスペースのタスクとキャッシュ。
- [Turborepo boundaries](https://turborepo.dev/docs/reference/boundaries) — package 間の依存境界（実験的機能）。
- [Vitest projects](https://vitest.dev/guide/projects) — monorepo の複数試験設定。
- [Oxlint](https://oxc.rs/docs/guide/usage/linter) — Oxc の静的解析。
- [Oxfmt](https://oxc.rs/docs/guide/usage/formatter) — Oxc の整形。
- [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server) — パスキーの登録・認証検証。
- [SimpleWebAuthn browser](https://simplewebauthn.dev/docs/packages/browser) — ブラウザー側 WebAuthn 呼び出し。
- [`@oidfed`](https://github.com/Dahkenangnon/oidfed) — OpenID Federation 向け。relying party が OpenID Federation 1.1 を要求した場合に限り別の拡張として再評価し、JWT 発行の代替としては採用しない。

## ドキュメント公開

- [Blume: Markdown docs on GitHub Pages](https://useblume.dev/guides/markdown-docs-github-pages) — 静的ビルドと project Pages の base path。
- [Blume: Static and server documentation](https://useblume.dev/guides/static-vs-server-documentation) — GitHub Pages で使える機能の境界。
- [GitHub Pages: Custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) — Actions source と artifact デプロイ。

ライブラリの採用は Cloudflare Workers での実動作、保守状況、ライセンス、依存関係を確認してから決める。

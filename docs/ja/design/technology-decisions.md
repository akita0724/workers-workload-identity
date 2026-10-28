# 技術選定

**状態:** 実装済み。以下の選定は 2026-10-24 時点の一次資料に基づき、Worker と管理画面はこれに従う。プロバイダーでの受理と本番のデプロイ権限は実機で未確認である。

## 選定原則

issuer の責務を「caller 識別・許可判定・JWT 署名・公開鍵配信」に限定する。独立した Admin Worker が管理画面を配信し、管理データの変更と監査を担当する。プロバイダー固有のクレデンシャル交換は caller 側で行う。OSS コアには組織固有の account ID、role ARN、秘密情報を入れない。アルゴリズムと鍵保管を差し替え可能にする一方、実行時の任意アルゴリズム入力は許さない。[管理画面](./admin-console.md)、[管理画面のフロントエンド技術選定](./frontend-selection.md) を参照する。

## 採用する構成

| 領域                  | 初期版の選定                                                                               | 理由・境界                                                                                                | 将来の変更条件                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 実行基盤              | Cloudflare Workers、TypeScript                                                             | 要求される Service Binding と公開 HTTPS を同一基盤で扱える                                                | ほかの実行基盤はコアを移植する時に検討                                                            |
| 公開 HTTP             | Hono                                                                                       | discovery、JWKS、`/admin/` の Admin Worker への中継を明示的に定義できる。Hono は Workers を公式にサポート | フレームワークや中継が発行境界を変えず、HTTP 発行経路を作らないこと                               |
| 内部発行              | named `WorkerEntrypoint` RPC + Service Binding `props`                                     | `this.ctx.props.clientId` を Cloudflare の権限付き設定として受け取る。中央 CI は必須にしない              | 信頼しない主体による別 caller の `props` 設定を排除できない場合は再設計                           |
| JWT/JWK               | `jose` + Workers Web Crypto                                                                | `jose` は Workers をサポートし、署名/JWK の標準処理を提供。暗号プリミティブは Web Crypto                  | workerd の統合テストに失敗するか、保守・ライセンス上の問題が出た場合                              |
| 管理画面              | React + Vite SPA、TanStack Router/Query、Kumo、Tailwind CSS v4、i18next、ECharts           | 一覧、変更差分、鍵ジョブの進捗、英語・日本語の文言、発行のグラフを扱う                                    | SSR/サーバー関数が必要なら TanStack Start を再評価                                                |
| 管理 API              | 別 Admin Worker + Hono                                                                     | API の認証・RBAC・CSRF と JSON 契約を統一し、issuer の公開 endpoint から分離する                          | サーバー境界を変える場合は全認証経路を再検証                                                      |
| 管理者認証            | 排他的な passkey または Cloudflare Access アダプタ                                         | どちらのデプロイでも共通の operator/RBAC を使う                                                           | 別認証方式は同じインターフェースと脅威評価を通して追加                                            |
| パスキー              | `@simplewebauthn/server` + `@simplewebauthn/browser`                                       | WebAuthn の challenge/署名検証を自作しない                                                                | Workers runtime での互換性やライセンスに問題が出た場合に再検討                                    |
| 入力・設定検証        | **Zod を必須依存**                                                                         | UI/API 入力、`ctx.props`、DB 行、環境設定を同じスキーマ群で境界検証                                       | 変更するならスキーマ/型/エラー処理の移行計画を要する                                              |
| caller・audience 登録 | 環境ごとの Policy D1 を正本にする                                                          | 管理画面から変更し、issuer が発行ごとに主系で認可情報を確認できる                                         | 高負荷時は可用性・失効遅延の要件を保つ別ストアを比較                                              |
| 管理者・パスキー      | 別の Admin D1                                                                              | issuer に operator credential/session を読ませない                                                        | 外部 IdP へ移してもローカル RBAC は維持                                                           |
| 署名鍵                | 鍵ごとの issuer Worker secret binding と Key Registry D1                                   | Admin Worker から JWKS を改変できず、公開鍵・鍵状態を発行と JWKS が共有できる                             | 鍵が非エクスポート可能であることや独立管理者が必要なら外部 KMS を検討                             |
| 鍵生成・自動交換      | 独立した Rotation Controller Worker + Cloudflare Workflows                                 | 管理画面からの開始、長いキャッシュ待機、再試行、定期 schedule を扱い、API token を管理画面から隔離する    | Workers での鍵生成や Cloudflare API が実機試験で成立しなければ専用 CI runner を実行アダプタにする |
| テスト                | `@cloudflare/vitest-plugin`、Vitest、workerd 統合テスト                                    | Cloudflare の現行推奨。Service Binding、Web Crypto、D1、認証アダプタを同じ runtime で試せる               | 新しい公式テスト基盤への移行時                                                                    |
| ワークスペース        | pnpm workspace + Turborepo                                                                 | package ごとに依存・タスク・境界を明示し、キャッシュと実行順を管理する                                    | package 数と作業コストが見合わなくなった場合                                                      |
| 静的解析・整形        | Oxlint + Oxfmt（Oxc）、TypeScript 型検査                                                   | 高速な lint/format を使い、型の正しさは `tsc` に検査させる                                                | ルール不足や実装環境との不整合が出た場合                                                          |
| デプロイ              | Controller は secret のアップロード・削除とデプロイメントの読取のみ。コード更新は Wrangler | 新 secret のデプロイと Key Registry の署名切替を分け、各ゲートを確認できる                                | API の振る舞いと権限分離を実機で確定                                                              |

[Hono Workers ガイド](https://hono.dev/docs/getting-started/cloudflare-workers)、[TanStack Router](https://tanstack.com/router/latest/docs/overview)、[TanStack Start](https://tanstack.com/start/latest/docs/framework/react/overview)、[`jose` の対応 runtime](https://github.com/panva/jose)、[Zod](https://zod.dev/basics)、[D1](https://developers.cloudflare.com/d1/worker-api/)、[Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)、[Workers versions/deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)

## モジュール境界

`packages/domain-identity` は caller・audience・grant、`packages/domain-keys` は鍵状態・署名鍵選択、`packages/domain-operators` は operator・RBAC の純粋な業務規則を保持する。`packages/contracts` は Zod の公開可能な入出力契約のみを保持する。各 Worker はそれぞれのユースケースと Cloudflare/Hono/JOSE/D1 等の処理を持ち、`src/application` と `src/adapters` に分けているのは issuer だけである。React 管理画面は `contracts` のみを参照する。詳細は[リポジトリ構成](./repository-structure.md)を参照する。

リポジトリには依存境界とドメイン規則に加え、issuer の発行・公開 metadata/JWKS、`/admin/` 中継、管理機能、ローテーション機能とデプロイ例がある。本番受け入れとプロバイダーの実機検証は未完了である。`IssueRequest` は希望 `aud` と任意の追跡用 UUID `requestId` を受け取る。`clientId` は RPC メソッドの引数に入れず、Cloudflare アダプタが `this.ctx.props` から抽出する。ドメイン層は caller ID を引数として受けるが、その生成元をアダプタで固定する。issuer の Hono から署名ユースケースへの参照を禁止し、公開 HTTP handler に発行経路を持たせない。Admin Worker は発行用秘密鍵や発行 RPC を持たない。鍵の高権限操作は Rotation Controller に分ける。[公開ホストとルートパス](./domain-routing.md)、[Rotation Controller](./rotation-controller.md) を参照する。

## ポリシーのモデル

初期版の Policy D1 内の client/audience/grant を、読み出し境界で次の概念モデルへ変換する。JSON は架空の表示例であり、運用データをソースへ保存しない。

```json
{
  "clients": {
    "example-caller-prod": {
      "subject": "service:example-caller:prod",
      "enabled": true,
      "audiences": ["urn:example:external-service"]
    }
  },
  "audiences": {
    "urn:example:external-service": {
      "algorithm": "RS256",
      "tokenLifetimeSeconds": 300
    }
  }
}
```

**Zod を実行時の必須依存**とし、`z.strictObject(...)`、enum、上限/下限、相互関係の refinements で入力・DB 行・環境設定を検証する。未知フィールド、重複 ID、空の `aud`、未知アルゴリズム、許可外 TTL、`sub` の再利用は拒否する。発行時には DB の現行値を毎回検証し、失敗時は発行しない。公開リポジトリにはスキーマと架空例のみを置き、実運用の client/audience ポリシーは Policy D1 に保持する。

audience から署名アルゴリズムを選ぶのは relying party の互換性を固定するためで、caller が `alg` を選ぶためではない。relying party ごとの扱いは [署名アルゴリズムと鍵ライフサイクル](./key-management.md) を参照する。

## 鍵保存方式の比較

| 方式                        | 利点                                                   | 課題                                                                                                                | 判断                                                              |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Worker secret binding       | 追加サービス不要、issuer Worker に限定しやすい         | secret 更新は Worker の新バージョンとデプロイを伴う。値は実行中の Worker から読み取り可能。各変数にサイズ上限がある | **初期版で採用**。鍵ごとに 1 secret。ローテーションは複数デプロイ |
| Cloudflare Secrets Store    | アカウントで集中管理し、Worker から `get()` で取得可能 | 2026-10-24 時点で open beta。権限とバインドの管理が別途必要                                                         | 本番要件と安定性を評価して後から選択可能                          |
| 外部 KMS `Sign`             | 鍵の非エクスポート性、独立した管理・監査               | 毎回の外部通信、可用性と遅延、KMS への認証の循環問題、クラウド依存                                                  | 高い鍵保護要求が出た場合のアダプタ                                |
| KV/D1/R2 に秘密鍵を直接保存 | 動的な更新が容易                                       | 暗号鍵を一般データストアへ置く設計になる                                                                            | 採用しない                                                        |

[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) は更新時に新 Worker バージョンを作り、通常の secret 更新はそのバージョンを即時デプロイする。鍵ローテーションは Wrangler や別途のバージョンアップロードを使わない。Rotation Controller が Secrets API（`PUT …/secrets`）を呼ぶと issuer の新しいバージョンが作られてデプロイされ、Controller はその後デプロイメントとバージョンを読み取って、トラフィックの 100% を受けるバージョンに新しい secret が binding されていることを検証するだけである。[Rotation Controller](./rotation-controller.md) と [署名アルゴリズムと鍵ライフサイクル](./key-management.md) を参照する。Workers の環境変数は 1 件 5 KB 上限なので、複数の秘密鍵を 1 つの JSON secret に詰め込まない。[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[Secrets Store](https://developers.cloudflare.com/secrets-store/) を参照する。

## 採用しないもの

- Hono の JWT middleware: relying party 側の API の検証には使えるが、issuer の発行ポリシーと鍵状態を代替しない。
- `jsonwebtoken` 等の Node 専用処理に依存する発行: Workers の Web Crypto で完結する `jose` を優先する。
- 公開 token endpoint と issuer 内部でのクラウド交換: 初期版では扱わない。自動鍵ローテーションは実機のキャッシュ・受理挙動を検証した対象でのみ有効化する。

`@oidfed` は、relying party が OpenID Federation 1.1 を要求した場合に限り、別の拡張として再評価する。JWT 発行の代替としては採用しない。

## バージョンと OSS

直接依存の大半は、2026-10-24 時点の npm registry `latest` を確認した正確なバージョンで固定している。`apps/admin-ui` は UI ライブラリとテストツールにキャレット範囲を使い、共有の lockfile がインストールされるバージョンを固定する。Vitest 5 と `@cloudflare/vitest-plugin`、Vite 8 と React plugin の peer 範囲を確認する。依存ライブラリのライセンス、更新方針、脆弱性対応をベータ版の前に確認する。Worker runtime とプロバイダーとの互換性は、依存の選定だけでなく統合テストと実機試験で確定する。SDK や設定例に Cloudflare account ID とクラウド account ID を固定しない。対応済みクラウド・アルゴリズムは実機試験の結果に限って表示する。

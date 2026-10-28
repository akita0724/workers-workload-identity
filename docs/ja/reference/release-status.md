---
title: リリース状況
description: 検証済みの範囲、残る作業、既知の問題、ベータ版と本番利用のゲート
sidebar:
  order: 3
---

本プロジェクトは**アルファ版**です。現在のリリースは GitHub の prerelease として公開した `v0.1.0-alpha.0` です。公開する契約は今後も変わる可能性があり、本番利用を支援するバージョンはまだありません。[MIT ライセンス](https://github.com/akita0724/workers-workload-identity/blob/main/LICENSE)で提供しています。変更は[変更履歴](https://github.com/akita0724/workers-workload-identity/blob/main/CHANGELOG.md)に記録します。

最終更新: 2026-10-28

## 検証済み

次の動作はローカルの workerd で確認済みです。共通の E2E ケースは Cloudflare のステージング環境でも確認済みです。

- 名前付きの `IssuerRpc` Service Binding エントリポイントと、固定した `ctx.props.clientId` による発行
- Policy D1 による client、audience、grant の評価
- RS256 の署名と、公開 JWKS による検証
- issuer、audience、subject、期限、署名が誤っている場合の拒否
- client の停止と grant の解除が次回の発行に反映されること
- 4並列の発行で `jti` が重複しないこと
- Cloudflare ステージングでの共通 E2E 10ケースと caller 停止テスト
- ステージングでの管理画面と、最初の管理者のパスキー登録
- 最初の署名鍵のサーバー側での生成、先行公開、有効化

## 実装済みで本番相当の受け入れが未完了のもの

次の機能は実装と自動テストがありますが、本番相当の環境での受け入れは完了していません。

- 管理画面でのポリシー編集、管理者とパスキーのライフサイクル管理、監査検索
- 発行ごとの監査記録、発行メトリクスの集計、可用性 SLO の表示
- 定期ローテーションと通常の鍵交換の条件となる、relying party での確認記録
- `operator` または `security-admin` によるローテーションの提案と、提案者以外の `security-admin` による承認、`security-admin` による直接開始、Workflow の一時停止・再開・再試行、即時ローテーション
- アルゴリズムごとに有効化できる定期ローテーション（5分ごとに条件を確認）
- discovery と JWKS の死活監視、構造化ログ、保持期間を過ぎたデータの削除
- D1 のバックアップ、隔離した DB への復元、監査付きの管理者復旧

## 未検証

- 初期の検証対象4件（AWS、Google Cloud、Claude API、OpenAI API）との実機 token exchange
- 初期ゲート外の将来候補である Microsoft Entra との実機 token exchange
- 外部プロバイダーとの ES256 の相互運用性
- アカウント内の複数ロールと API token を使った、Service Binding 設定権限の評価
- 長期運用した本番状態での通常ローテーションと即時ローテーションの演習
- 構造化ログから外部通知サービスへのアラート配信

完全な OpenID Provider としての適合は目標にしていません。

## 既知の問題

- 各 `wrangler.example.jsonc` はひな形です。実際のデプロイに使う設定はステージングスクリプトが生成します。[ステージングへのデプロイ](../guides/deployment.md)を参照してください。

## ベータ版のゲート

リポジトリとドキュメントサイトは最初のアルファ版から公開しています。次のすべてが完了した後に、ベータ版をリリースします。

- [ ] AWS、Google Cloud、Claude API、OpenAI API の実機検証を行い、日付付きの結果を[プロバイダー対応状況](./provider-support.mdx)に記録する。非対応となったプロバイダーは、その旨を明記すれば公開できる。
- [x] リポジトリで GitHub Private Vulnerability Reporting を有効にする。
- [ ] 依存ライブラリのライセンス、第三者通知、既知の脆弱性、秘密情報の混入を確認する。
- [ ] 日英のドキュメント、内部リンク、canonical URL、`hreflang`、言語別の検索をプレビュービルドで確認する。
- [ ] Git タグの署名と互換性方針を決める。リリースには `v0.1.0-alpha.0` のような Semantic Versioning のプレリリースタグを使います。

`SECURITY.md`、`CONTRIBUTING.md`、`SUPPORT.md`、行動規範は整備済みです。

詳細な判定基準は[受け入れ基準](../design/acceptance.md)にあります。

## 本番利用は別に判断する

ソースを公開できることは、本番の ID 基盤として安全に運用できることを意味しません。本番で使う前に、対象の Cloudflare アカウントの権限、各 relying party、障害対応、鍵管理、監視、復旧、組織のセキュリティ要件を評価してください。

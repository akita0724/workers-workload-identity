---
title: セキュリティモデル
description: 信頼境界、bearer token の扱い、権限縮小、鍵漏えいへの対応
sidebar:
  order: 6
---

このシステムは、長期間有効なクラウド資格情報を caller へ配らず、最長5分のワークロードアサーションへ置き換えます。ただし、短命 JWT にしただけで caller の真正性や API の認可が自動的に保証されるわけではありません。

## 守る対象と信頼境界

| 境界                         | 信頼するもの                                                                                                                 | 信頼しないもの                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| caller → issuer              | 同じ Cloudflare account 内の Service Binding と、レビュー済みの固定 `props.clientId`                                         | RPC 引数、caller が申告する subject・TTL・algorithm |
| issuer → relying party       | 事前登録した issuer URL、公開 JWKS、audience ごとのアルゴリズム                                                              | discovery だけから自動作成した認可規則              |
| 管理者 → policy              | 認証済み operator、サーバー側 RBAC、監査を伴う更新                                                                           | ブラウザー側の表示制御だけによる権限制限            |
| Rotation Controller → issuer | account 単位の Workers Scripts Edit と Read 権限を持つ token。コードで固定した issuer script（`CF_ISSUER_SCRIPT`）にだけ使う | ブラウザーから渡された鍵材や任意 Worker 名          |
| 組織 → 公開リポジトリ        | ソース、schema、架空の設定例、公開鍵の形式                                                                                   | 実鍵、実 client 登録、account ID、token、招待情報   |

`ctx.props.clientId` は secret ではありません。Service Binding の `props` を変更できる Cloudflare の管理者、編集者、CI、API token は、別の client ID を設定できます。デプロイ権限を最小化し、Worker ごとの権限と変更レビューを運用へ含めてください。

同一 Worker 内の `ctx.exports` loopback binding は `props` を動的に指定できます。公開 HTTP handler から loopback で `IssuerRpc` を呼ぶ実装や、信頼できないコードへ RPC stub を渡す実装を追加しないでください。

## アサーションは bearer credential

ワークロードアサーションを取得した主体は、有効期間内であれば利用できる可能性があります。`jti` は識別子であり、再提示を自動的に防止しません。アサーションをログ、HTTP レスポンス、ブラウザーのコード、永続ストレージに置かず、意図した token exchange または relying party へ直接渡してください。

relying party は、署名だけでなく `iss`、用途専用の `aud`、許可済み `sub`、必須の時刻クレーム、最大寿命、アルゴリズム allowlist を検証します。詳細は[アサーションを検証する](../guides/verifying-assertions.md)にあります。

## 停止と失効には時間差がある

client の無効化や grant の解除は、次の発行要求から反映されます。すでに発行された JWT は `exp` まで有効であり、交換済みのクラウド資格情報はクラウド側の期限まで残る可能性があります。

緊急停止時は、状況に応じて次を組み合わせます。

1. client を無効化し、新規発行を止める。
2. grant を解除し、特定 audience への新規発行を止める。
3. relying party 側の subject、role、federated credential、service account mapping を無効化する。
4. 署名鍵の漏えいが疑われる場合は即時ローテーションを実行する。
5. プロバイダーが対応していれば、交換済みのセッションや一時資格情報を取り消す。

可用性より封じ込めを優先する権限者と連絡経路を、本番デプロイ前に決めてください。

## 秘密情報の配置を分ける

- 保存時の issuer の署名秘密鍵は `SIGNING_KEY_*` Worker secret にだけ存在します。ローテーション中、Controller はこの secret を登録するためにサーバー側で鍵を生成し、一時的にエクスポートします。秘密鍵をほかの場所に保存してはなりません。
- Key Registry D1 には公開 JWK、`kid`、状態、ローテーション記録だけを保存します。
- Rotation Controller の Cloudflare API token は Controller の secret とし、issuer、Admin Worker、ブラウザー、D1 へ渡しません。
- Admin Worker は policy を変更できますが、署名秘密鍵を読み書きできません。
- caller は issuer RPC だけを持ち、Policy D1、Key D1、管理 API へ直接接続しません。

秘密鍵を D1、KV、リポジトリ、管理画面、監査ログへ置かないでください。ステージングスクリプトが `.deploy/staging/` に保存する token と招待情報も秘密情報です。このディレクトリは Git から除外されていますが、バックアップやファイル共有の対象にしないでください。

## アルゴリズムと用途を混同しない

初期の既定は `RS256` です。`ES256` は相互運用性の試験を記録した audience だけで有効化します。token の `alg` に従って検証方式を選ばず、relying party の allowlist と突き合わせてください。

クラウドの token exchange 用 JWT と、独自 API が直接受ける JWT には別の audience を割り当てます。標準 JWT access token と表明する場合は、別途 RFC 9068 の要件を満たす必要があります。

## 脆弱性は公開 issue に書かない

機密性のある問題は、リポジトリの GitHub Private Vulnerability Reporting から報告してください。利用できない場合は、公開 issue に再現手順、token、account 情報を書かず、メンテナーへ非公開の連絡経路を確認してください。報告の方針と対象バージョンは、ルートの [`SECURITY.ja.md`](https://github.com/akita0724/workers-workload-identity/blob/main/SECURITY.ja.md) に記載しています。

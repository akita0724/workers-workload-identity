---
title: トラブルシューティング
description: 発行、検証、discovery、JWKS、デプロイ、ローテーションの代表的な問題を切り分ける
sidebar:
  order: 9
---

最初に、JWT や secret を出力しない状態で、失敗した境界を特定します。caller の公開エラーコード、issuer の HTTP ステータス、停止したローテーションのゲート、失敗した Wrangler の操作を分けて確認してください。

## 発行が拒否される

| エラー                 | 確認する項目                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invalid-request`      | 入力が `{ aud }` と任意の `requestId` だけか。`aud` が正しい StringOrURI か。`requestId` を指定する場合は UUID か。余分な属性がないか                              |
| `caller-denied`        | `props` が正しい ID を持つ `{ clientId }` だけか。client が登録済みで有効か                                                                                        |
| `audience-denied`      | audience が完全一致するか。client にその audience への grant があるか                                                                                              |
| `rate-limited`         | 同じ client が固定1分 window の上限を超えていないか。連続再試行していないか                                                                                        |
| `issuance-unavailable` | 対象アルゴリズムの現用鍵がちょうど1本あり、その `SIGNING_KEY_*` secret が設定されているか。2つの D1 binding が動作し、audience policy が有効で、監査を保存できるか |
| `transport-error`      | Service Binding が存在し、正しい service と `IssuerRpc` エントリポイントを指すか。issuer Worker が稼働しているか                                                   |
| `invalid-response`     | caller SDK と issuer の版が対応しているか。RPC が compact JWT 文字列を返すか                                                                                       |

`IssuerRpc` を指さない binding では、呼び出しが issuer の RPC メソッドに届かないため、client SDK は `caller-denied` ではなく `transport-error` を返します。`caller-denied` と `audience-denied` は、登録の詳細を caller へ明かしません。運用者が管理画面または Policy D1 で、発行監査を含む実際の状態を確認します。

## JWT の検証が失敗する

| 症状                 | 主な原因                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `iss` 不一致         | `ISSUER_URL` と relying party の登録値が違う。末尾 `/` の有無も確認する                   |
| `aud` 不一致         | token exchange が要求する完全な audience と登録値が違う                                   |
| `sub` 不一致         | client の subject と relying party の許可条件が違う                                       |
| 未知の `kid`         | JWKS キャッシュが古い、先行公開が不足している、または別の issuer を参照している           |
| 署名アルゴリズム拒否 | audience policy と検証側の allowlist が違う。または ES256 の検証記録がない                |
| `nbf` / `exp` エラー | 時刻差、clock tolerance、有効期間の設定が誤っている                                       |
| token が長すぎる     | 想定外のクレームまたは別 issuer の token。この issuer は固定の7つのクレームだけを発行する |

token 本文をログへ出さないでください。非機密な診断情報としては、protected header の `kid` と `alg`、検証結果コード、観測した時刻差だけを使います。

## discovery または JWKS が正しくない

- issuer が提供するのは `/.well-known/openid-configuration` と `/jwks.json` だけです。HTTP の発行エンドポイントはありません。その他のパスはプレーンテキストの 404 を返し、次の規則があります。
  - `ISSUER_URL` と異なるオリジンへのリクエストは、discovery と JWKS を含むすべてのパスで 404 になります。
  - `ISSUER_URL` が `https://example.com/oidc` のようにパスを含む場合、issuer はその接頭辞の下のパスだけを扱い、接頭辞を取り除いてから振り分けます。
  - `/admin` は 308 で `/admin/` へリダイレクトします。`/admin/` 以下のパスは任意の `ADMIN` Service Binding へ転送し、この binding がなければ 404 になります。
- `jwks_uri` は `ISSUER_URL` の末尾 `/` を1つ取り除いて組み立てるため、末尾 `/` があっても `//jwks.json` にはなりません。`issuer` の値と JWT の `iss` は `ISSUER_URL` をそのまま使います。
- JWKS が空の場合、初回鍵の生成が完了していません。ステージングでは `pnpm staging:test` を実行します。
- `id_token_signing_alg_values_supported` は固定のリスト `["RS256", "ES256"]` です。issuer が署名できる方式を示すもので、JWKS に現在掲載中の鍵を表しません。`active` 鍵がある証拠として扱わず、JWKS と管理画面の鍵状態を確認してください。
- プレーンテキストの 503 は、Key D1 を読めない、設定値が不正であるなど、公開ハンドラーの内部障害を示します。レスポンスに詳細を出さずに、Key D1 と Worker の設定を確認してください。

## ステージングデプロイが止まる

| 状況                                         | 対応                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Wrangler の認証期限切れ                      | `pnpm exec wrangler login` と `pnpm exec wrangler whoami` を実行する                                              |
| Rotation API token がない                    | `OIDC_ROTATION_API_TOKEN` を現在のシェルに設定し、対象スクリプトの Read/Edit 権限を確認する                       |
| D1 作成後に中断した                          | Cloudflare 上の DB と `.deploy/staging/settings.json` を照合する。無関係な DB を自動で採用しない                  |
| `staging:test` の初回鍵の有効化が3分を超える | Workflow の run、API token、JWKS、デプロイバージョン、登録済み audience のキャッシュ設定を確認する                |
| bootstrap が拒否される                       | 管理者がすでに存在する。既存の `security-admin` に招待してもらう                                                  |
| bootstrap の招待が期限切れになった           | `pnpm ops recover-admin` で復旧用の招待を発行する。[運用ガイド](./operations.md#パスキーを全員が失った場合)を参照 |

`.deploy/staging/` を削除してもリモートのリソースは消えません。一方で、このディレクトリを失うと database ID とテスト用 token のローカル記録を失います。

## 報告に含める情報

公開 issue には、再現コマンド、公開エラーコード、HTTP ステータス、使用した commit、Node/pnpm/Wrangler の版、秘密情報を除いたログを含めます。JWT、secret、account ID、招待 token、外部プロバイダーの実 ID は削除してください。

セキュリティ上の問題は公開 issue にせず、[`SECURITY.ja.md`](https://github.com/akita0724/workers-workload-identity/blob/main/SECURITY.ja.md) の非公開報告手順に従ってください。

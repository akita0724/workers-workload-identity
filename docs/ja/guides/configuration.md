---
title: issuer と caller の設定
description: issuer の環境変数、D1 Binding、audience、client、grant、Service Binding を設定する
sidebar:
  order: 3
---

発行を始めるには、issuer の公開 ID と保存先を設定し、audience、client、grant、caller の Service Binding を同じ識別子で結びます。caller に署名鍵や Policy D1 を渡す必要はありません。

## issuer の URL と Binding を固定する

issuer Worker は次の設定を必要とします。

| 名前                    | 種類            | 制約                                                                                                                |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ISSUER_URL`            | 環境変数        | 外部から到達できる HTTPS URL。userinfo、query、fragment は不可                                                      |
| `RATE_LIMIT_PER_MINUTE` | 環境変数        | client 単位の固定1分 window。1〜100,000。ステージングスクリプトは120を設定                                          |
| `POLICY_DB`             | D1 Binding      | client、audience、grant、ポリシー監査と、`issuance_audit_events`、`issuance_metrics`、`issuance_rate_limits` を保存 |
| `KEY_DB`                | D1 Binding      | 公開 JWK、鍵状態、ローテーション記録、発行予約を保存                                                                |
| `SIGNING_KEY_*`         | secret          | 署名用の秘密鍵。Rotation Controller が作成・削除するため、手動で設定しない                                          |
| `ADMIN`                 | Service Binding | 任意。issuer のホストで受けた `/admin/` のリクエストを admin Worker へ転送                                          |
| `17 * * * *`            | Cron トリガー   | 発行監査、発行メトリクス、レート制限の bucket、発行予約を毎時削除する。保持期間の管理に必要                         |

`ISSUER_URL` は JWT の `iss` と discovery の `issuer` にそのまま使われます。末尾 `/` の有無を含め、relying party に登録する issuer と完全に一致させてください。query と fragment は使用できません。

最小構成は [`apps/issuer-worker/wrangler.example.jsonc`](https://github.com/akita0724/workers-workload-identity/blob/main/apps/issuer-worker/wrangler.example.jsonc) にあります。例の UUID とドメインは実際の値へ置き換えます。ステージングスクリプトは、これに `ADMIN` Service Binding も追加します。

```json
{
  "triggers": { "crons": ["17 * * * *"] },
  "vars": {
    "ISSUER_URL": "https://oidc.example.com",
    "RATE_LIMIT_PER_MINUTE": "120"
  },
  "d1_databases": [
    { "binding": "POLICY_DB", "database_name": "oidc-policy" },
    { "binding": "KEY_DB", "database_name": "oidc-keys" }
  ]
}
```

## audience は relying party と用途ごとに分ける

audience は relying party が `aud` として完全一致で検証する文字列です。登録時に次の値を固定します。

- `audience`: 1〜2,048文字の完全一致値
- `algorithm`: `RS256`、または検証済みの連携に限り `ES256`
- `tokenLifetimeSeconds`: 1〜300秒
- `description`: 運用者が用途を判別できる、1,024文字以内の説明
- `verifiedForEs256`: relying party で ES256 を検証したか。`ES256` の audience で発行するには `true` が必要
- `exchangeVerified`: 現在の署名アルゴリズムで認証または資格情報交換が成功したか
- `mixedJwksVerified`: 新旧の公開鍵を同時に掲載しても relying party が受理したか
- `jwksCacheSeconds`: relying party の JWKS キャッシュの上限として観測した秒数。0〜2,592,000、不明なら `null`

最後の4項目の既定値は `false` と `null` です。変更できるのは `security-admin` だけです。これらが揃うまで、通常の鍵ローテーションは進みません。[アサーションを検証する](./verifying-assertions.md#jwks-のキャッシュとローテーション)を参照してください。

異なる権限、環境、relying party で同じ audience を使い回さないでください。たとえば本番とステージングには別の値を割り当てます。複数の relying party が同じ audience を共有すると、署名アルゴリズムと鍵キャッシュの条件を最も厳しい relying party に合わせる必要があります。

## client は変更しない subject を持つ

client 登録では次を決めます。

- `clientId`: `[a-z][a-z0-9-]{2,63}` に一致するデプロイ用 ID
- `subject`: relying party が許可する、3〜256文字の一意な `sub`
- `enabled`: 発行を許可する状態
- 許可する audience の集合

`audience` と `subject` は、どちらも RFC 7519 の StringOrURI でなければなりません。`:` を含まない値は任意の文字列として受け付けます。`:` を含む値は、`urn:example:receiver` や `https://api.example.com` のように RFC 3986 の URI として解析できる必要があり、そうでなければ登録と発行で拒否されます。

`subject` は発行開始後に変更しません。ID を変える必要がある場合は、新しい client を登録して relying party の信頼設定を移し、旧 client を停止します。

client と audience の許可関係が grant です。caller が `{ aud }` を要求しても、完全一致する grant がなければ `audience-denied` になります。

## caller の Service Binding に client ID を固定する

caller の Wrangler 設定は issuer の名前付きエントリポイントと `props.clientId` を指定します。

```json
{
  "services": [
    {
      "binding": "OIDC_ISSUER",
      "service": "oidc",
      "entrypoint": "IssuerRpc",
      "props": { "clientId": "example-caller-prod" }
    }
  ]
}
```

TypeScript で設定を組み立てる場合は、設定専用のエクスポートを使えます。

```ts
import { defineIssuerBinding } from "@workers-workload-identity/client/config";

const binding = defineIssuerBinding({
  binding: "OIDC_ISSUER",
  service: "oidc",
  props: { clientId: "example-caller-prod" },
});
```

`defineIssuerBinding` は値の形式を検査し、`entrypoint: "IssuerRpc"` を固定します。binding 名は `[A-Za-z_][A-Za-z0-9_]*`、service 名は `[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}` に一致し、`props` は `{ clientId }` だけでなければならず、満たさない場合は `ZodError` を投げます。Cloudflare の権限設定、issuer への client 登録、ファイルの書き換えは行いません。

`clientId` は秘密ではなく、caller が実行時に証明する暗号鍵でもありません。Service Binding と `props` を変更できる主体を制限し、変更をレビューできるデプロイ手順を用意してください。

## 設定後に確認する

最低限、次を確認します。

1. discovery の `issuer` と `jwks_uri` が外部 URL と一致する。
2. JWKS に現用鍵の `kid` があり、秘密成分を含まない。
3. 許可済み audience には発行でき、未許可 audience は拒否される。
4. client を停止すると次の発行が拒否される。
5. issuer の公開 HTTP に発行経路がなく、未知のパスは 404 になる。

呼び出しコードは[アサーションを発行する](./issuing-assertions.md)、relying party の設定は[アサーションを検証する](./verifying-assertions.md)を参照してください。

---
title: アサーションを検証する
description: JWKS で署名を検証し、issuer、audience、subject、時刻、アルゴリズムを厳密に制限する
sidebar:
  order: 5
---

relying party は、署名が正しいことだけでなく「誰が、何のために、いつまで使える token か」を検証します。信頼の設定を discovery から無条件に採用せず、信頼する issuer、audience、subject、アルゴリズムを relying party 側で設定してください。

## 必須の検証項目

| 項目                  | 要件                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `alg`                 | audience に許可した `RS256` または `ES256` の allowlist と一致する |
| `kid`                 | 信頼する issuer の JWKS に存在する。未知の鍵は拒否する             |
| `iss`                 | 設定した `ISSUER_URL` と文字列で完全一致する                       |
| `aud`                 | この API 専用の audience が1つだけ入り、完全一致する               |
| `sub`                 | この操作を許可した client subject と一致する                       |
| `iat` / `nbf` / `exp` | 必須で、現在時刻と整合する                                         |
| token の有効期間      | `exp - iat` が1〜300秒で、relying party の上限以下                 |
| `jti`                 | 空でない。再利用防止が必要なら使用済み ID を記録する               |

JWT BCP に従い、token 自身が指定するアルゴリズムをそのまま信用しません。`none` や想定外の RSA/EC アルゴリズムを受理しないでください。JWK の `use` は `sig` で、その `alg` は protected header と一致している必要があります。

issuer は現在 `nbf` を `iat` と同じ値に設定します（`nbf = iat`）。fixture の relying party は clock tolerance を0秒にしています。本番の許容差は relying party と時刻同期の運用に合わせて明示的に決め、広すぎる許容差で短い有効期間の意味を失わせないでください。

## `jose` を使った最小例

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://oidc.example.com";
const audience = "urn:example:receiver";
const subject = "workload:example-caller:prod";
const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks.json`));

export async function verifyAssertion(assertion: string) {
  const { payload, protectedHeader } = await jwtVerify(assertion, jwks, {
    issuer,
    audience,
    algorithms: ["RS256"],
    requiredClaims: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
    clockTolerance: 0,
  });

  if (payload.sub !== subject) throw new Error("unexpected subject");
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("missing token lifetime");
  }
  if (payload.exp - payload.iat < 1 || payload.exp - payload.iat > 300) {
    throw new Error("invalid token lifetime");
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new Error("missing token id");
  }

  return { subject: payload.sub, keyId: protectedHeader.kid };
}
```

この例は検証の核だけを示します。実際の API では、入力サイズの上限、例外の非機密化、タイムアウト、JWKS 取得障害、監視、必要に応じた `jti` 再利用防止も設計してください。リポジトリ内の実行可能な fixture は [`apps/smoke-receiver/src/index.ts`](https://github.com/akita0724/workers-workload-identity/blob/main/apps/smoke-receiver/src/index.ts) です。

## JWKS のキャッシュとローテーション

JWKS は `Cache-Control: public, max-age=60` を返します。relying party がこのヘッダーに従う場合も、relying party の JWKS キャッシュについて観測した上限を audience の `jwksCacheSeconds` に記録します。

通常の切替の前に、Rotation Controller は新しい鍵と同じアルゴリズムを使うすべての audience を確認します。次のいずれかに当てはまる audience が1つでもあれば、鍵を有効化せず、現在の現用鍵を維持します。

- `jwksCacheSeconds` が `null`
- 先行公開時間が `jwksCacheSeconds` より60秒以上長くない
- `exchangeVerified` または `mixedJwksVerified` が未確認
- `ES256` を使い、`verifiedForEs256` が未確認

キャッシュの確認は、通常の切替のたびに行います。確認フラグの検査は、新しい鍵が既存の現用鍵を置き換える場合だけ行い、そのアルゴリズムを使う audience が1つもない場合も失敗します。そのため、アルゴリズムごとの最初の鍵は、relying party を試験する前に有効化できます。Controller はデプロイの確認後、切替の直前にもこれらを再確認します。即時ローテーションはこれらの確認を省略します。[運用ガイド](./operations.md#発行監査と-relying-party-の確認)を参照してください。

未知の `kid` を受け取ったときは JWKS を1回更新して再検証できますが、無制限の取得や再試行は避けてください。旧鍵は、最後に発行し得た JWT の寿命と安全余裕が過ぎるまで `verifying` として JWKS に残ります。

## token exchange と API 認証を分ける

外部クラウドが token exchange を提供する場合、issuer JWT は交換エンドポイントにだけ送ります。交換で得た短命 access token や一時資格情報を、対象クラウド API に提示します。issuer JWT を Claude API や OpenAI API の通常の Bearer token として直接送らないでください。

独自 API が issuer JWT を直接受ける場合は、その API が relying party です。用途専用の audience と subject allowlist を設定し、クラウド交換用の audience と共用しないでください。

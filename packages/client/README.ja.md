# Caller client

[English](README.md) | [日本語](README.ja.md)

`@workers-workload-identity/client` は caller 用の SDK です。caller Worker はこれを使い、Service Binding の RPC で issuer にワークロードアサーションを要求し、入力と応答の形式を検証します。このパッケージはアルファ版です。

## アサーションを要求する

```ts
import { createOidcClient, type IssuerBinding } from "@workers-workload-identity/client";

interface Env {
  OIDC_ISSUER: IssuerBinding;
}

async function obtainAssertion(env: Env) {
  const client = createOidcClient(env.OIDC_ISSUER);
  return client.issue({ aud: "urn:example:receiver" });
}
```

`createOidcClient(binding).issue({ aud, requestId? })` はアサーションを文字列で返します。client はリクエストの処理内で作成し、リクエストをまたいで保持しないでください。client ID は RPC の引数に含めません。issuer は Service Binding の `ctx.props` から client ID を読み取ります。

失敗時、`issue` は `OidcClientError` を送出します。`code` は `OidcClientErrorCode` で、issuer の公開 `IssuanceErrorCode`（`invalid-request`、`caller-denied`、`audience-denied`、`rate-limited`、`issuance-unavailable`）か、SDK 独自の `transport-error`、`invalid-response` のいずれかです。リモートの元のエラーメッセージは破棄します。

## Service Binding を設定する

`@workers-workload-identity/client/config` の `defineIssuerBinding` は `IssuerServiceBinding` を返します。これは `entrypoint: "IssuerRpc"` と固定の `props.clientId` を持つ Wrangler の `services` 項目です。デプロイ用のツールでのみ使います。実行中の Worker の context を変更したり、client を登録したりはしません。

```ts
import { defineIssuerBinding } from "@workers-workload-identity/client/config";

const binding = defineIssuerBinding({
  binding: "OIDC_ISSUER",
  service: "oidc",
  props: { clientId: "example-caller-prod" },
});
```

## 守るべき境界

- アサーションは内部のトークン交換処理に渡します。ブラウザーに返したり、ログに出力したりしないでください。
- SDK は自動再試行、アサーションのキャッシュ、クラウドの資格情報交換を行いません。
- 応答の検査は JWT の形式だけを確認します。署名は検証しません。署名の検証は relying party が行います。

## ビルドする

このパッケージは npm に公開しません。リポジトリのルートでソースからビルドします。

```sh
pnpm client:build
```

`packages/client/dist/` に ESM バンドル（`index.js`、`config.js`）、TypeScript の型定義、Zod だけに依存する `package.json`、`LICENSE`、生成される短い `README.md` を出力します。

API、エラーコード、対象外の範囲、受け入れ条件は [caller ライブラリの要件定義](../../docs/ja/design/client-library.md)を参照してください。本番環境での外部プロバイダーとの相互運用は検証していません。

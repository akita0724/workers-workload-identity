---
title: アサーションを発行する
description: caller SDK と Service Binding RPC で短命 JWT を取得し、安全に扱う
sidebar:
  order: 4
---

caller はリクエスト処理の中で SDK を作り、許可済みの audience を1つ指定します。取得した JWT はメモリ上に必要な間だけ保持し、token exchange または relying party へ直接渡します。

## SDK から発行する

```ts
import {
  createOidcClient,
  OidcClientError,
  type IssuerBinding,
} from "@workers-workload-identity/client";

interface Env {
  OIDC_ISSUER: IssuerBinding;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const client = createOidcClient(env.OIDC_ISSUER);

    try {
      const assertion = await client.issue({ aud: "urn:example:receiver" });
      return await callRelyingParty(assertion);
    } catch (error) {
      if (error instanceof OidcClientError) {
        return new Response("Upstream identity unavailable", { status: 503 });
      }
      throw error;
    }
  },
};
```

`createOidcClient` は各リクエスト内で呼びます。binding や JWT を別のリクエストへ持ち越さないでください。SDK はアサーションのキャッシュ、自動再試行、HTTP へのフォールバック、プロバイダーの資格情報への交換を行いません。

client SDK は npm に公開しておらず、公開する予定もありません。このワークスペース内では `@workers-workload-identity/client` が TypeScript のソースを参照します。別のプロジェクトで使う場合は、`pnpm client:build` でソースからビルドします。ESM バンドルと型定義が `packages/client/dist` に出力されます。

## 発行要求と追跡 ID

SDK を使わない caller も、同じ Service Binding 契約を呼べます。

```ts
interface IssuerBinding {
  issue(request: { aud: string; requestId?: string }): Promise<string>;
}

const assertion = await env.OIDC_ISSUER.issue({
  aud: "urn:example:receiver",
});
```

入力は厳密に検証されます。`clientId`、`sub`、有効期間、`alg`、`kid`、追加のクレームを引数へ含めると拒否されます。`aud` は1〜2,048文字の RFC 7519 StringOrURI、`requestId` を指定する場合は UUID でなければならず、満たさない場合は `invalid-request` になります。issuer は `aud` の trim、小文字化、URL 正規化を行わず、登録済みの grant と完全一致で比較します。

issuer には HTTP の発行経路がありません。公開 HTTP で提供するのは discovery と JWKS だけで、`Cache-Control: public, max-age=60` を付けます。未知のパスはプレーンテキストの 404、これらのエンドポイントの内部障害はプレーンテキストの 503 を返します。

SDK は成功応答が32 KiB 以下の compact JWT 形式かを検査します。これは形式の検査だけで、署名やクレームの検証ではありません。JWT を受け取る relying party が[アサーションを検証する](./verifying-assertions.md)の条件を適用します。

`requestId` は発行監査の検索に使う任意の UUID です。省略時は issuer が ID を割り当てます。同じ ID を再利用しても重複排除や再試行の保証はなく、呼び出しごとにポリシーを評価します。この ID は JWT のクレームに入りません。

issuer は発行・拒否・失敗ごとに、イベント ID、request ID、検証できた client ID と audience、選択した公開鍵 ID、結果、発行処理の所要時間（監査保存時間を除く）、開始時刻を Policy D1 に保存します。不正な入力の本文、JWT、秘密鍵、例外の詳細は保存しません。署名に失敗した場合の鍵 ID は試行した鍵を示します。issuer は結果ごとの件数も1分単位で `issuance_metrics` に記録します。

監査イベントを保存できなければ JWT を返さず、拒否を含むすべての結果が `issuance-unavailable` になります。このとき issuer は、イベント `issuance-audit-unavailable` とイベント ID だけを含む JSON のログを出力します。メトリクスの書き込み失敗は発行を妨げず、`issuance-metrics-unavailable` をログに出力します。client SDK がローカルで拒否した入力は issuer に届かないため、監査されません。

## 公開エラーコードだけを扱う

| コード                 | 意味                                                                                                    | caller の基本動作                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `invalid-request`      | 入力の形式、`aud`、`requestId` のいずれかが不正                                                         | コードまたは設定を修正する。再試行しない             |
| `caller-denied`        | props 不正、未登録の client、または停止済みの client                                                    | client の登録と Service Binding を確認する           |
| `audience-denied`      | audience が未登録、または grant がない                                                                  | audience と grant を確認する                         |
| `rate-limited`         | client の1分当たりの上限を超過                                                                          | 短い間隔で再試行を繰り返さない                       |
| `issuance-unavailable` | issuer の設定、鍵、保存先、署名、監査の障害。現用鍵が複数ある場合や、署名の予約が30秒を超えた場合を含む | issuer の運用者に調査を依頼する                      |
| `transport-error`      | RPC 通信の失敗、`IssuerRpc` を指さない binding、または未知の遠隔例外                                    | 障害として扱い、操作の冪等性を確認してから再試行する |
| `invalid-response`     | 応答が compact JWT 形式でない                                                                           | 破損または互換性のないデプロイとして扱う             |

`caller-denied` は未登録の client と停止済みの client を意図的に区別しません。`audience-denied` も、audience が未登録なのか grant がないだけなのかを明かしません。SDK は遠隔例外のメッセージ、スタック、cause も破棄します。

レート制限は HTTP 429 ではなく RPC の `rate-limited` エラーです。現在は client ごとの固定1分 window で、すべての client に同じ `RATE_LIMIT_PER_MINUTE` を適用します。上限は client の照会より前に適用するため、未登録・停止済み・audience 拒否となる client の試行も回数を消費します。props や入力が不正なリクエストは先に拒否され、回数に含めません。

## JWT をログやブラウザーへ出さない

ワークロードアサーションは bearer credential であり、有効期限までに提示した者が利用できる可能性があります。次の場所に置かないでください。

- `console.log`、例外、trace の属性
- 公開 HTTP レスポンスやブラウザーのコード
- D1、KV、Cache API、分析用ストレージ
- URL、クエリ文字列、cookie
- 障害報告や公開 issue

監視には client と audience の非機密な識別子、結果コード、遅延、`kid` を使い、JWT や秘密鍵を含めません。発行監査と1分単位のメトリクスもこの方針に従います。保持期間と監視は[運用ガイド](./operations.md)を参照してください。

## SDK リファレンス

| エクスポート                                   | エントリポイント                           | 説明                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `createOidcClient(binding)`                    | `@workers-workload-identity/client`        | `OidcClient` を返す。入力をローカルで検証し、`binding.issue` を呼び、応答の形式を検査する                               |
| `OidcClient`                                   | `@workers-workload-identity/client`        | `issue({ aud, requestId? }): Promise<string>` だけを持つインターフェース                                                |
| `OidcClientError`                              | `@workers-workload-identity/client`        | `OidcClient.issue` が投げるエラー。`code` は `OidcClientErrorCode`。遠隔のメッセージ、スタック、cause を含まない        |
| `OidcClientErrorCode`                          | `@workers-workload-identity/client`        | `IssuanceErrorCode` に `transport-error` と `invalid-response` を加えたもの                                             |
| `IssuanceErrorCode`                            | `@workers-workload-identity/client`        | issuer が返す5つのコード。`invalid-request`、`caller-denied`、`audience-denied`、`rate-limited`、`issuance-unavailable` |
| `IssuerBinding`, `IssueRequest`, `CallerProps` | `@workers-workload-identity/client`        | Service Binding の RPC 契約、その入力、binding の `props` の型                                                          |
| `defineIssuerBinding(options)`                 | `@workers-workload-identity/client/config` | デプロイ設定用の `IssuerServiceBinding` を返す。名前や `props` が不正なら `ZodError` を投げる                           |
| `IssuerServiceBinding`                         | `@workers-workload-identity/client/config` | `{ binding, service, entrypoint: "IssuerRpc", props }`                                                                  |

`defineIssuerBinding` が検査する名前の規則は、[issuer と caller の設定](./configuration.md#caller-の-service-binding-に-client-id-を固定する)を参照してください。

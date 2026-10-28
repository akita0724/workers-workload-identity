# caller ライブラリの要件定義

**状態:** 実装済み。ライブラリとローカルテストがある。本番デプロイとプロバイダーとの互換性の実機確認は未完了である。npm での公開は予定しておらず、ソースからビルドして使う。

`@workers-workload-identity/client` は、caller Worker の Service Binding 設定と発行 RPC を型安全に扱うためのライブラリとする。[要件定義](./requirements.md)、特に FR-02・FR-03 の認証・認可境界を保つ。SDK を使わない caller に対しても、issuer の検証と拒否条件は同じである。

## ctx の設定はデプロイ時に固定する

ここで扱う ctx は **issuer 側の `this.ctx.props`** を指す。caller の `ExecutionContext`、Hono の Context、JWT のクレームとは区別する。

デプロイ時に `services[].props.clientId` を設定し、Cloudflare が named entrypoint に渡す値を issuer が読む。SDK は実行中の ctx を生成・変更せず、RPC 引数で client ID を送らない。`defineIssuerBinding` はデプロイ設定を作る補助であり、Cloudflare の権限制御や issuer への登録処理を代行しない。[Cloudflare Context](https://developers.cloudflare.com/workers/runtime-apis/context/) を参照する。

型で防げるのは設定漏れや呼出しの誤りである。Binding を編集できる主体による別 client ID の設定は、要件定義のデプロイ権限の信頼境界と実機の受け入れ試験 A-04 で扱う。SDK が caller の身元を証明すると表現しない。

## 初期版の機能要件

| ID    | 要件                                                                                                                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CL-01 | `@workers-workload-identity/client/config` から `defineIssuerBinding` を提供する。binding 名、service 名、`props: { clientId }` を入力とし、`entrypoint: "IssuerRpc"` を固定した Wrangler の Service Binding 設定片を返す。未知フィールドと不正値を実行時にも拒否する。 |
| CL-02 | `CallerProps`・`IssueRequest`・`IssuerBinding` を共有契約から提供する。Worker 実装や D1 schema、管理画面、秘密鍵の型に依存しない。issuer の entrypoint も同じ契約を実装し、型のずれを検出する。                                                                         |
| CL-03 | `createOidcClient(binding).issue({ aud })` を提供する。現行 RPC の `issue` と `Promise<string>` の戻り値を保つ。Binding のメソッドを元の receiver で呼び出す。                                                                                                          |
| CL-04 | `aud` を完全な文字列として渡し、trim・小文字化・URL 正規化をしない。client ID、`sub`、TTL、`alg`、`kid`、任意クレームを受け付けない。型検査を迂回した JavaScript 入力も厳密なスキーマで拒否する。                                                                       |
| CL-05 | 応答は 32 KiB 以下の署名付き compact JWT の文字列形式として検査する。形式検査は署名・クレーム検証やプロバイダーとの互換性の保証とは扱わない。検証責任は要件定義の relying party の要件に従う。                                                                          |
| CL-06 | `OidcClientError.code` によって、入力不正・caller 拒否・audience 拒否・レート制限・発行障害・通信障害・応答不正を判別可能にする。独自 Error の追加属性が RPC を越えて保存されることに依存しない。                                                                       |
| CL-07 | 自動再試行、JWT キャッシュ、リクエスト共有を行わない。各呼出しを issuer に送り、client 停止や grant 解除を次の発行に反映する既存仕様を保つ。                                                                                                                            |
| CL-08 | JWT、RPC 応答、例外の元メッセージ・stack・cause をログへ出さない。SDK が新たに投げるエラーは許可したコードだけを保持する。呼出し側にもトークンのログ記録を求めない。                                                                                                    |
| CL-09 | Worker 実行用の ESM を提供し、Node 専用 API やネットワーク fetch を必要としない。workspace は TypeScript ソースを export し、`pnpm client:build` が ESM バンドルを生成する。npm での公開は予定しない。                                                                  |
| CL-10 | 通信は既存の Service Binding RPC に限定する。HTTP の発行 URL、公開 fallback、動的 props を指定する loopback API を SDK に設けない。                                                                                                                                     |

`aud` のローカルな文字列型は issuer の許可リストを表さない。登録・grant の変更後も issuer の毎回の認可判定を正本とする。client ID の形式は既存の `clientIdSchema` と共有する。

## 使用する API

デプロイ設定用のコードは実行時クライアントと別の export に置く。次の例で返す値は、既存の `examples/caller.wrangler.jsonc` の `services` 配列の 1 要素と一致する。

```ts
import { defineIssuerBinding } from "@workers-workload-identity/client/config";

const binding = defineIssuerBinding({
  binding: "OIDC_ISSUER",
  service: "oidc",
  props: { clientId: "example-caller-prod" },
});
// デプロイツールで services: [binding] に組み込む。
```

設定ヘルパーはファイルを書き換えず、環境間の設定継承や client 登録を自動化しない。生成された値を各環境の設定に明示的に組み込む。

```ts
import { createOidcClient, type IssuerBinding } from "@workers-workload-identity/client";

interface Env {
  OIDC_ISSUER: IssuerBinding;
}

async function obtainAssertion(env: Env) {
  const oidc = createOidcClient(env.OIDC_ISSUER);
  return oidc.issue({ aud: "urn:example:receiver" });
}
```

caller の Env 全体は Wrangler の生成型を基本とし、上記は SDK が必要とする最小の構造を示す。取得した assertion は caller 内でプロバイダーとの交換処理へ渡す。公開 HTTP レスポンスやブラウザーへ返す利用例は用意しない。Binding とクライアントはリクエスト処理の中で使い、別リクエストへ保持しない。

## 失敗は公開可能なコードだけで分類する

| コード                 | 意味                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `invalid-request`      | SDK または issuer が入力を拒否した                            |
| `caller-denied`        | props 不正、未登録または無効 caller。内訳を区別しない         |
| `audience-denied`      | 許可されていない、または未登録の audience。内訳を区別しない   |
| `rate-limited`         | issuer の発行試行数上限を超えた                               |
| `issuance-unavailable` | 設定・保存先・現用鍵・署名等の障害。詳細を公開しない          |
| `transport-error`      | 分類不能な RPC 例外または通信障害。元のメッセージを保持しない |
| `invalid-response`     | 返却値が共有した応答形式を満たさない                          |

issuer は RPC の例外メッセージに公開コードだけを入れる。SDK は許可したメッセージをコードに変換し、その他は `transport-error` とする。遠隔側の Error サブクラスとの `instanceof` 判定や追加プロパティに依存しない。

## 既存仕様との整合と対象外

RPC の入力は `{ aud, requestId? }` とする。`requestId` は追跡用 UUID として共有契約・SDK・issuer で検証し、監査記録に保存する。省略時は issuer が生成する。同じ ID の再送でも発行は毎回評価する。JWT クレームや caller 認証には使わない。

外部クラウド資格情報への交換、AWS 等の SDK adapter、relying party での JWT 検証、管理 API、登録情報からの audience 型の生成は初期版の対象外とする。タイムアウトやキャンセルも初期版に追加しない。ローカルで待機を打ち切っても遠隔発行が停止したとは限らないため、再試行可能性を一律に保証しない。

既存 RPC の成功時の戻り値を維持する一方、未整理だった例外メッセージを上記の公開コードに揃える。初期開発版のため既存の内部エラー文字列との互換性は保証しない。将来、入力または戻り値の破壊的変更を行う際は caller と issuer の組合せを検証し、変更手順を記載する。

## 受け入れ条件

| ID     | 確認内容                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CL-T01 | 不正な props、client ID 欠落、禁止された RPC 引数、文字列 URL を渡す通信設定が TypeScript の検査に失敗する。期待される型エラーをコードで固定する。                                                                  |
| CL-T02 | SDK から有効な `{ aud }` を 1 度送り、元の Binding receiver で 1 度呼ぶ。余分な属性を持つ入力は RPC 前に拒否する。                                                                                                  |
| CL-T03 | 全公開エラーと分類不能な遠隔例外をテストする。JWT や遠隔例外の機密文字列が SDK エラーへ残らず、拒否・障害時に自動再試行しない。                                                                                     |
| CL-T04 | 不正応答・長すぎる応答を拒否し、トークンをキャッシュせず呼出しごとに RPC を行う。                                                                                                                                   |
| CL-T05 | workerd 上で SDK → named entrypoint → Policy D1 → 署名 → 公開 JWKS による検証をテストする。停止・grant 解除の次回発行への反映、欠落 props、偽装引数、HTTP からの発行不可を確認する。                                |
| CL-T06 | デプロイ設定片が既存 Wrangler サンプルと一致する。本番相当 account の別 Worker から固定 props 付き Service Binding を呼ぶ実機確認と A-04 はベータ版のゲートとして残す。ローカル loopback テストで合格扱いにしない。 |

ベータ版を出す前に、[受け入れ基準](./acceptance.md) とプロバイダーの実機検証を終える。ベータ版のゲートは [リリース状況](../reference/release-status.md) に列挙する。SDK の単体テストやローカル発行の成功だけで AWS、Google Cloud、Claude API、OpenAI API の対応を表明しない。

## 配布用ビルド

`pnpm client:build` は `packages/client/dist/` に ESM と TypeScript 型定義を生成する。`/config` も独立した export とし、公開不能な workspace 依存を配布物に残さない。生成物の依存は Zod のみである。ルートの `pnpm build` からも実行する。生成する package は `private: true` のままとする。npm での公開は予定せず、caller はソースからビルドする。semver とアップグレード方針はまだ定めていない。

# プロバイダー検証用の例

[English](README.md) | [日本語](README.ja.md)

これらの例は、アルファ版の期間中にプロバイダーとの実機検証を行うためのものです。各例は、プロバイダー側を設定する Terraform と、検証用 Worker の組み合わせです。Worker は `IssuerRpc` の Service Binding で issuer からアサーションを取得し、プロバイダーで交換して、読み取り専用の API を 1 つ呼び出します。どのプロバイダーとの対応も**未検証**です。[プロバイダー対応状況](../docs/ja/reference/provider-support.mdx)と[プロバイダー検証計画](../docs/ja/design/provider-validation.md)を参照してください。試験用のアカウントでのみ使用してください。

検証用 Worker は、アサーションや交換後の資格情報をレスポンスに含めません。

| ディレクトリ                              | Terraform が作成するもの                                                            | Worker が呼び出す API                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| [aws](aws/README.ja.md)                   | IAM OIDC provider と、1 つの `aud` と `sub` に限定した trust policy を持つ role     | STS `GetCallerIdentity`                       |
| [google-cloud](google-cloud/README.ja.md) | Workload Identity Pool と Provider、権限を 1 つだけ含むカスタム role とその binding | Cloud Resource Manager の `projects.get`      |
| [claude](claude/README.ja.md)             | federation issuer と rule（コミュニティの Terraform provider）                      | Claude Models API                             |
| [openai](openai/README.ja.md)             | 作成しない。OpenAI Platform で作成した provider と mapping の ID を記録する         | OpenAI Models API                             |
| [azure](azure/README.ja.md)               | Entra application、federated credential、検証用 resource group とその Reader 権限   | Azure Resource Manager の resource group 読取 |

Azure の例は Microsoft Entra を対象としています。Microsoft Entra は初期の検証ゲート（AWS、Google Cloud、Claude API、OpenAI API）の対象外で、将来の候補です。

`caller.wrangler.jsonc` は caller Worker に必要な最小限の Service Binding の例です。

## 共通の準備

1. このリポジトリの issuer を同じ Cloudflare アカウントにデプロイします。実際の issuer URL、公開 discovery メタデータと JWKS、有効な RS256 鍵を確認してください。Worker、Service Binding、その `props` を編集できる主体は、信頼できる範囲に限定してください。
2. 対象の例の `worker/wrangler.jsonc` で、`services[0].service` を issuer Worker の名前に変更します。`props.clientId` を issuer に client として登録し、固定の subject を設定して、`AUDIENCE` の値を grant します。これらは Terraform の issuer、subject、audience と一致させてください。各 audience は RS256、有効期間 300 秒を推奨します。
3. 対象の例の README に従って、Terraform とプロバイダー側の設定を準備します。`terraform init` と `terraform plan` の内容を確認してから適用してください。IAM OIDC provider などのリソースが既にある場合は、重複して作成せず、例を環境に合わせて変更してください。
4. Terraform の出力とその他の ID を `worker/wrangler.jsonc` の `vars` に反映します。Cloudflare Access などで Worker へのアクセスを制限したうえで、リポジトリのルートから次を実行します。`PROBE_SECRET` を設定するまで、リクエストは認証に失敗します。

```sh
pnpm exec wrangler deploy --config examples/aws/worker/wrangler.jsonc
```

5. `examples/aws/worker` で長いランダムな secret とヘッダーファイルを作成し、secret を Worker に設定します。パスの `aws` は対象のディレクトリに置き換えてください。

```sh
cd examples/aws/worker
umask 077
openssl rand -hex 32 > .probe-secret
pnpm exec wrangler secret put PROBE_SECRET --config wrangler.jsonc < .probe-secret
printf 'Authorization: Bearer %s\n' "$(cat .probe-secret)" > .probe-headers
curl --fail-with-body -X POST -H @.probe-headers https://YOUR_WORKER_URL/
```

成功時は `{"ok":true,"exchange":"ok","api":"..."}` を返します。認証後の失敗では、資格情報が漏れないよう HTTP 502 で `{"ok":false,"error":"probe_failed"}` だけを返します。secret がない、または誤っている場合は 401、`POST /` 以外のリクエストは 404 です。失敗した段階は、issuer の監査ログとプロバイダーの認証ログで確認してください。Worker は毎回新しいアサーションを要求します。たとえば Claude API は、同じ `jti` を再利用した交換を拒否します。

## 後片付け

`terraform destroy` で削除される対象を確認したうえで、検証用 Worker、その secret、信頼設定、その他のリソース、ローカルの `.probe-secret` と `.probe-headers` を削除します。Terraform の state と ID は安全に管理してください。AWS STS の資格情報は最短でも 15 分有効で、issuer のアサーションが失効した後も残ります。

## ローカルでのテスト

リポジトリのルートで `node --test examples/shared/probe.test.mjs` を実行します。これはプロバイダーを模擬したテストであり、実際のトークン交換が成功することは示しません。

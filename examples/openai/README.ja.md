# OpenAI API

[English](README.md) | [日本語](README.ja.md)

先に[共通の準備](../README.ja.md)を確認してください。OpenAI API との対応は未検証で、この例はその検証のためのものです。[プロバイダー対応状況](../../docs/ja/reference/provider-support.mdx)を参照してください。

OpenAI Platform で Workload Identity Provider と project service account の mapping を作成します。issuer、audience、subject、公開 JWKS を登録し、service account に Models API の読み取りに必要な権限を付与してください。

`terraform/terraform.tfvars.example` を `terraform.tfvars` にコピーし、`identity_provider_id`、`service_account_id`、`issuer_url`、`subject`、`audience` を設定します。この Terraform は値を記録して `worker_config` 出力で返すだけで、OpenAI 側の provider や mapping は作成しません。同じ値を Worker の `OPENAI_PROVIDER_ID`、`OPENAI_SERVICE_ACCOUNT_ID`、`AUDIENCE` と issuer の grant に反映してください。API key やトークンは tfvars に書かないでください。

Worker は OpenAI のトークンエンドポイントでアサーションを OpenAI のアクセストークンに交換し、`GET /v1/models` を呼び出します。

OpenAI のワークロード ID フェデレーションは OIDC JWT を交換し、provider と mapping で設定します。公式ガイドは、一覧にない OIDC provider について OpenAI サポートへの問い合わせを案内しており、token exchange のリファレンスには独自 issuer に関する制限も記載されています。この issuer を登録して交換できるかは、環境で確認してください。[OpenAI WIF ガイド](https://developers.openai.com/api/docs/guides/workload-identity-federation)、[token exchange](https://developers.openai.com/api/reference/workload-identity-federation)

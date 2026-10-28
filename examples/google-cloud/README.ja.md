# Google Cloud

[English](README.md) | [日本語](README.ja.md)

先に[共通の準備](../README.ja.md)を確認してください。Google Cloud との対応は未検証で、この例はその検証のためのものです。[プロバイダー対応状況](../../docs/ja/reference/provider-support.mdx)を参照してください。

Terraform は Workload Identity Pool と、`google.subject` を `assertion.sub` に対応付け、設定した subject と audience だけを受け入れる OIDC Provider、`resourcemanager.projects.get` だけを含むカスタム role、固定 subject に対する project の binding を作成します。IAM、Resource Manager、STS の各 API の有効化と、project の管理権限は別途用意してください。

`terraform/terraform.tfvars.example` を `terraform.tfvars` にコピーし、`project_id`、`issuer_url`、`audience`、`subject` と、一意な `pool_id`、`provider_id`、`role_id` を設定します。認証は Application Default Credentials などで行ってください。`terraform output -raw provider_audience` を Worker の `vars` の `GOOGLE_PROVIDER` に、`project_id` を `GOOGLE_PROJECT_ID` に反映し、`AUDIENCE` は `audience` と同じ値にします。`GOOGLE_PROVIDER` は Google STS に送る provider のリソース名であり、JWT の `aud` とは別です。

Worker は Google STS でアサーションを交換し、Cloud Resource Manager で project を読み取ります。

この例は service account の権限借用を使わず、federated principal に直接 role を付与します。subject は Google の `google.subject` の上限である 127 文字以内にしてください。[Google Cloud の構成](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers)

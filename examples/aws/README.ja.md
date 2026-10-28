# AWS STS

[English](README.md) | [日本語](README.ja.md)

先に[共通の準備](../README.ja.md)を確認してください。AWS との対応は未検証で、この例はその検証のためのものです。[プロバイダー対応状況](../../docs/ja/reference/provider-support.mdx)を参照してください。

`terraform/main.tf` は、issuer 用の IAM OIDC provider を新規に作成し、`aud` が `audience`、`sub` が `subject` と一致する場合だけ `sts:AssumeRoleWithWebIdentity` を許可する trust policy を持つ role を作成します。`GetCallerIdentity` に追加の IAM 権限は不要です。

`terraform/terraform.tfvars.example` を同じディレクトリの `terraform.tfvars` にコピーし、`issuer_url`、`subject`、`audience`、`aws_region`、role 名の `name` を設定します。AWS の認証情報は AWS CLI / SDK の通常の方法で設定し、tfvars には書かないでください。`terraform output -raw role_arn` を Worker の `vars` の `AWS_ROLE_ARN` に、region を `AWS_REGION` に反映します。`AUDIENCE` と issuer の grant は `audience` と同じ値にしてください。

Worker は `AssumeRoleWithWebIdentity`（`DurationSeconds: 900`）でアサーションを交換し、取得した一時的な資格情報で `GetCallerIdentity` を呼び出します。

同じ issuer URL の IAM OIDC provider が既にある場合、この Terraform では重複して作成できません。既存の provider を import するか、構成を変更してください。issuer URL にパスや末尾の `/` がある場合は、provider の ARN と IAM の条件キーが AWS の登録結果と一致することを実機で確認してください。

[AWS STS API: AssumeRoleWithWebIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html)

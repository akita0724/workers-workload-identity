# Microsoft Entra / Azure

[English](README.md) | [日本語](README.ja.md)

先に[共通の準備](../README.ja.md)を確認してください。Microsoft Entra は初期の検証ゲートの対象外の将来の候補で、対応は未検証です。[プロバイダー対応状況](../../docs/ja/reference/provider-support.mdx)を参照してください。

Terraform は Entra application、issuer と subject に対する audience `api://AzureADTokenExchange` の federated identity credential、service principal、検証用 resource group、その resource group を範囲とする Reader の role assignment を作成します。Entra のアプリ登録と Azure の role assignment を作成する権限が必要です。

`terraform/terraform.tfvars.example` を `terraform.tfvars` にコピーし、`subscription_id`、`issuer_url`、`subject`、`name`、`location` を設定して、Azure CLI などで検証環境に認証してください。Terraform の出力 `tenant_id`、`client_id`、`subscription_id`、`resource_group` を、それぞれ Worker の `AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_SUBSCRIPTION_ID`、`AZURE_RESOURCE_GROUP` に反映します。`AUDIENCE` は既に `api://AzureADTokenExchange` です。issuer の client にこの audience を grant し、RS256 に設定してください。

Worker はアサーションを client assertion として Microsoft ID プラットフォームのトークンエンドポイントに送り、Azure Resource Manager で resource group を読み取ります。

role assignment の反映には時間がかかる場合があります。[Microsoft Entra のワークロード ID フェデレーション](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-spiffe-spire)

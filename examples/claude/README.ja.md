# Claude API

[English](README.md) | [日本語](README.ja.md)

先に[共通の準備](../README.ja.md)を確認してください。Claude API との対応は未検証で、この例はその検証のためのものです。[プロバイダー対応状況](../../docs/ja/reference/provider-support.mdx)を参照してください。

Terraform は実験段階のコミュニティ provider `frank-bee/anthropic` を使い、federation issuer（JWKS は discovery から取得）と、issuer、`aud`、subject に限定した federation rule を作成します。適用前に Claude Console で service account とその workspace membership を作成し、`org:admin` を持つ OAuth token を `ANTHROPIC_OAUTH_TOKEN` 環境変数で provider に渡してください。この操作に Admin API key は使えません。

`terraform/terraform.tfvars.example` を `terraform.tfvars` にコピーし、`issuer_url`、`subject`、`audience`、`organization_id`、`service_account_id`、`workspace_id` を設定します。rule は subject を `subject_prefix`（前方一致）で照合するため、caller の完全な固定 subject を指定してください。空の subject や `*` を含む subject は Terraform が拒否します。出力の `rule_id`、`organization_id`、`service_account_id`、`workspace_id` を、Worker の `CLAUDE_RULE_ID`、`CLAUDE_ORGANIZATION_ID`、`CLAUDE_SERVICE_ACCOUNT_ID`、`CLAUDE_WORKSPACE_ID` に反映します。`AUDIENCE` と issuer の grant は `audience` と同じ値にしてください。

Worker は JWT bearer grant で Claude の OAuth トークンエンドポイントでアサーションを交換し、モデルの一覧を取得します。rule は `workspace:developer` scope、有効期間 600 秒のアクセストークンを発行します。この scope では Models API を含む workspace の管理系以外の API にアクセスできます。より狭い権限が必要な場合は、プロバイダーのドキュメントを確認してください。

この Terraform provider は公式ではなく、その WIF リソースは provider 自身の実機受け入れテストでも検証されていません。[Claude のワークロード ID フェデレーション](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation)、[Terraform provider](https://registry.terraform.io/providers/frank-bee/anthropic/latest/docs)

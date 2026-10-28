---
sidebar:
  label: プロバイダー検証計画
---

# プロバイダーの実機検証計画

**状態:** 目標設計。まだどのプロバイダーも検証していない。初期の検証対象4件（AWS、Google Cloud、Claude API、OpenAI API）と、以下の Microsoft Entra と OCI に関する記述は検証対象であり、対応済みの表明ではない。Claude は **Claude API への直接アクセス**、OpenAI は **OpenAI API への直接アクセス**を指す。Amazon Bedrock、Vertex AI、ChatGPT、Codex の認証方式と混同しない。

## 共通原則

- issuer はプロバイダーを知らず、許可された単一 `aud` の短命 JWT を発行する。token exchange は caller 側のアダプタまたはプロバイダーの SDK が実行し、交換後の資格情報で API を呼ぶ。
- relying party ごとに異なる `aud` を割り当てる。`iss`、`sub`、`aud` の完全一致と、relying party 側の最小権限の設定を検証する。組織固有の relying party の ID は公開サンプルへ入れない。
- 各プロバイダーで正規 token の交換・最小権限 API 呼出、別 `aud`/`sub`/`iss`、期限切れ、不正署名、鍵ローテーション中の交換を試す。署名アルゴリズムと JWKS のキャッシュ動作は対象環境で記録する。
- 検証記録には日付、プロバイダーの製品・プラン、設定手順、匿名化した metadata/JWKS/クレーム、成功・失敗、再現可能な test ID、既知制約を残す。実 token、秘密鍵、アカウント ID は公開しない。
- 結果は `unverified`（未検証）、`successful`（成功）、`unsupported`（非対応）、`unverifiable`（検証不能）として扱う。4 対象すべての実機検証を終えてからベータ版を出す。ベータ版のゲートの正本は [リリース状況](../reference/release-status.md) とする。プロバイダーの制約で評価を進められない場合は、制約を記録して `unsupported` または `unverifiable` と分類する。サポート表には成功した対象だけを載せる。

## 対象別の交換経路とゲート

| 対象         | relying party の設定と交換                                                                                                                                                                    | 特有の検証点                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS STS      | IAM OIDC provider と `sub`/`aud` を絞った role trust policy を作り、`AssumeRoleWithWebIdentity` で一時資格情報へ交換                                                                          | OIDC discovery の必須フィールドと実装能力の整合性、IAM provider 作成、role の過剰許可、旧・新 JWKS の受理                                                                                                                     |
| Google Cloud | Workload Identity Pool/Provider の issuer・audience・属性マッピング/条件を設定し、Google STS で交換                                                                                           | provider の期待 `aud`、属性条件による `sub` 制限、対象リソースの権限、鍵ローテーション                                                                                                                                        |
| Claude API   | Claude Console に federation issuer、service account、workspace、`aud` と `sub` 等で絞った federation rule を登録し、`POST /v1/oauth/token` の JWT bearer grant で Claude access token へ交換 | discovery/直接 JWKS のどちらを使うか、rule ID と organization/service account ID、scope、JWT と交換後 token の寿命、鍵キャッシュ。直接 API に issuer JWT を渡さない                                                           |
| OpenAI API   | OpenAI Platform に Workload Identity Provider と project service account の mapping を登録し、`https://auth.openai.com/oauth/token` の token-exchange grant で OpenAI access token へ交換     | 公式文書は現在、任意の issuer の登録を制限しているため、`https://oidc.example.com` を登録して交換できるか実機で確認する。mapping の一意性・権限、discovery/JWKS の方式、鍵キャッシュを確認。直接 API に issuer JWT を渡さない |

Claude の issuer は discovery、公開 JWKS URL の直接指定、インライン JWKS を選べる。自動鍵ローテーションには公開 JWKS を参照する方式を優先し、インライン方式は事前更新を自動化・検証できない限り自動切替の対象にしない。Claude の文書は新鍵を署名開始の **少なくとも 15 分前**に JWKS へ掲載することを推奨するが、他の relying party の待機時間をこれで代用しない。[Claude WIF](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation)、[Claude WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference)

OpenAI は公開 discovery/JWKS とアップロード JWKS を選べる。公開 JWKS のキャッシュは公式文書上 600 秒で、未知 `kid` に遭遇すると再取得する。アップロード方式では鍵の切替前に relying party 側の JWKS 更新が必須である。**これらの設定項目が存在することだけでは、任意の issuer が利用可能とは判断しない。** [OpenAI WIF](https://developers.openai.com/api/docs/guides/workload-identity-federation)、[OpenAI token exchange reference](https://developers.openai.com/api/reference/workload-identity-federation)

## 主要クラウドの設定例

以下は架空の検証用設定であり、接続成功を確認した設定ではない。`https://oidc.example.com` は検証環境の HTTPS issuer に置き換える。issuer の表記は末尾 `/` を含め、設定、metadata、JWT の `iss`、relying party で完全に一致させる。例は全て `clientId: example-caller`、`subject: service:example-caller`、`algorithm: RS256`、有効期間 300 秒を使う。各 audience を issuer の audience として登録し、client に grant する。公開 JWKS にその署名鍵を掲載し、Service Binding の `props.clientId` を `example-caller` に固定する。

### AWS IAM / STS

| 設定先            | 項目                    | 例                                                                                                      |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| issuer            | audience / grant        | `urn:example:aws:staging` を登録し、client に許可                                                       |
| IAM OIDC provider | Provider URL / Audience | `https://oidc.example.com` / `urn:example:aws:staging`                                                  |
| IAM role          | 信頼する provider       | `arn:aws:iam::123456789012:oidc-provider/oidc.example.com`                                              |
| IAM role          | trust policy の条件     | `oidc.example.com:aud` は `urn:example:aws:staging`、`oidc.example.com:sub` は `service:example-caller` |
| caller            | 交換先                  | 対象 role の ARN を指定して STS `AssumeRoleWithWebIdentity` を呼ぶ                                      |

ロールに必要な最小権限を付ける。パス付き issuer では IAM provider ARN と条件キーにもパスを含める。AWS は公開 JWKS に少なくとも 1 鍵を要求する。[AWS IAM の設定](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)、[OIDC 条件キー](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html)

### Google Cloud

| 設定先                            | 項目                      | 例                                                                          |
| --------------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| issuer                            | audience / grant          | `urn:example:gcp:staging` を登録し、client に許可                           |
| Workload Identity Pool / Provider | issuer / allowed audience | `https://oidc.example.com` / `urn:example:gcp:staging`（カスタム audience） |
| Provider                          | attribute mapping         | `google.subject=assertion.sub`                                              |
| Provider                          | attribute condition       | `assertion.sub == 'service:example-caller'`                                 |
| Google Cloud                      | 権限                      | 上記 subject に、検証用リソースまたはサービスアカウントの最小権限を付与     |
| caller                            | 交換先                    | Google STS に対象 provider のリソース名と assertion を渡す                  |

カスタム audience を指定しない場合、Google Cloud が期待する provider リソース名を issuer の `aud` に使う。Google の `google.subject` は最大 127 文字である。JWKS を直接アップロードする場合は、relying party 側の鍵更新も必要になる。[Google Cloud の設定](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers)

### Microsoft Entra ID / Azure

| 設定先                                      | 項目                        | 例                                                                                                     |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| issuer                                      | audience / grant            | `api://AzureADTokenExchange` を登録し、client に許可                                                   |
| federated identity credential               | issuer / subject / audience | `https://oidc.example.com` / `service:example-caller` / `api://AzureADTokenExchange`                   |
| アプリまたは user-assigned managed identity | 権限                        | 検証対象の Azure リソースに限定したロール                                                              |
| caller                                      | 交換先                      | tenant ID と application client ID を指定し、外部 JWT を client assertion として token endpoint に渡す |

公開鍵には `use: sig` を付け、RS256 を使う。上記 audience は Microsoft の例であり、実際のクラウド環境の値を確認する。[Microsoft Entra の設定](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-spiffe-spire)

### Oracle Cloud Infrastructure（OCI）

| 設定先                     | 項目                               | 例                                                                                              |
| -------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| issuer                     | audience / grant                   | `urn:example:oci:staging` を登録し、client に許可。OCI 側の必要な audience 検査方式は実機で確認 |
| Identity Propagation Trust | name / type / issuer               | `example-workload-trust` / `JWT` / `https://oidc.example.com`                                   |
| Identity Propagation Trust | 状態 / subject type / クレーム条件 | 有効 / `Resource` / `sub` を `service:example-caller` に制限する設定を検証                      |
| OCI                        | 許可                               | 交換を許可する OAuth client、対象 resource と必要最小限の policy                                |
| caller                     | 交換先                             | token exchange で OCI resource principal session token（RPST）を要求                            |

OCI の例で交換要求に渡す `public_key` は RPST を使った API 要求用の鍵であり、issuer の署名公開鍵とは役割が異なる。issuer の鍵を OCI がどう取得・信頼するか、クレーム条件の構文と audience の扱いは対象テナンシーで確認する。[OCI の設定と交換](https://docs.oracle.com/en-us/iaas/Content/Identity/api-getstarted/token_exchange_grant_type_workload_id-federation.htm)

## 実機テストに必要なもの

### 共通の準備

- [ ] 検証用 Cloudflare account、公開 HTTPS issuer、信頼された証明書、外部から到達する discovery と JWKS。
- [ ] issuer の Policy D1・Key Registry D1、RS256 の現用鍵とローテーション用の新鍵、鍵に対応する Worker secret binding。
- [ ] client・一意な subject・プロバイダー別の audience・grant、および固定された Service Binding。relying party が異なる issuer や subject を拒否することを試すための負例も用意する。
- [ ] Worker や Service Binding を変更できる主体の権限を確認し、他 client の ID を使った偽装を防げることを実証する。未実証なら発行を有効にしない。
- [ ] 各プロバイダーの隔離された検証環境、設定を作成・削除する権限、最小権限で読み取れる検証用リソース、交換を実行する caller と SDK またはコマンド。
- [ ] 鍵や token を公開せずに結果を残す場所。検証日時、設定、匿名化した metadata・JWT クレーム・JWKS、成功・失敗、エラー、鍵キャッシュ時間、片付け結果を記録する。

### プロバイダーごとの準備

- [ ] **AWS:** 検証用 account、IAM OIDC provider と role の作成権限、provider URL・audience・role ARN、`sub`/`aud` を絞る trust policy、検証リソースへの限定権限。
- [ ] **Google Cloud:** 検証用 project、Workload Identity Pool/Provider と IAM binding を作成する権限、project 番号・pool ID・provider ID、属性 mapping・condition、必要ならサービスアカウントと impersonation の権限。
- [ ] **Microsoft Entra:** 検証用 tenant、アプリ登録または user-assigned managed identity と federated credential を設定する権限、tenant ID・client ID、issuer・subject・audience、対象 Azure リソースのロール。
- [ ] **OCI:** 検証用 tenancy と identity domain、Identity Propagation Trust・OAuth client・対象 resource と policy を設定する権限、交換要求の署名用鍵、トークン交換と API 呼出に必要な設定。
- [ ] **Claude / OpenAI:** 検証用 organization / project、issuer と service account・信頼ルールを設定する権限、workspace / scope または project 権限。OpenAI は任意 issuer の受理可否を事前に確認する。

### 実行と判定

- [ ] 正しい assertion の署名を公開 JWKS で検証し、交換した資格情報で許可された API 呼出が成功する。
- [ ] `iss`・`sub`・`aud` の不一致、期限切れ、不正署名、未知の `kid` をそれぞれ拒否する。未知 `kid` の JWKS 再取得の有無も記録する。
- [ ] 権限外の API 呼出が拒否され、client 停止と grant 解除が次の発行に反映される。
- [ ] 新鍵の先行公開、伝搬・キャッシュ待機、署名切替、旧 JWT の期限切れ後の旧鍵削除を行い、各段階の交換結果を記録する。
- [ ] 発行 JWT と交換後資格情報の寿命、relying party ごとの JWKS キャッシュ・再取得動作を記録し、テスト用の信頼設定・権限・リソースを削除する。

外部アカウントでの実行は未完了。結果を記録するまでは、このチェックリストの項目を完了扱いにしない。

## 公開時の表示

README に検証日と `成功` の対象を明記する。`非対応`・`検証不能` の対象は理由と再検証条件を示し、「4 対象を検証した」ことを「4 対象に対応した」と表現しない。OpenAI API が任意 issuer を受理しないままなら、OpenAI 対応を表明せず、提供元の対応や仕様変更を待つ。

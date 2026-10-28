---
title: ステージングへのデプロイ
description: 隔離した Cloudflare ステージング環境を作り、初回鍵の生成、発行テスト、初期管理者の登録を行う
sidebar:
  order: 6
---

この手順は、デプロイ担当者が Cloudflare の検証用環境を作り、JWT の発行テストを行うためのものです。リポジトリのルートで実行します。初回は 1〜6 の順に進め、再デプロイや失敗時は後半を参照してください。

対象は `workers.dev`、または任意のカスタムドメインを使うステージングです。管理画面の認証はパスキーだけです。Cloudflare Access と外部プロバイダーとの資格情報交換は、このデプロイコマンドでは設定しません。

確認状況（2026-10-27）: ローカル E2E 21 ケース、5つの Worker の dry-run、Cloudflare ステージングでの共通 E2E 10 ケースと caller 停止テストに合格しています。未検証の範囲は[リリース状況](../reference/release-status.md)を参照してください。

## 1. 実行環境と Cloudflare の権限を用意する

Node.js 24 以上と、`package.json` 指定の pnpm 12.15.0 を使用します。

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler whoami
```

デプロイするアカウントの ID と、そのアカウントの `workers.dev` サブドメインを確認してください。デプロイ担当者には Worker のデプロイ、D1 の作成・マイグレーション・データ更新、Workflow のデプロイに必要な権限が必要です。Wrangler のログインと API トークンの権限は、[Cloudflare の権限ガイド](https://developers.cloudflare.com/workers/authorization/workers/)で確認できます。

これとは別に、Rotation Controller が署名鍵を issuer の Worker secret に登録するための API トークンを用意します。対象アカウントの Workers Scripts の編集・読取を許可し、ローカルの環境変数 `OIDC_ROTATION_API_TOKEN` に設定してください。Controller はこのトークンで secret の登録・削除とデプロイバージョンの確認を行います。

zsh で値を画面に表示せず入力する例です。

```zsh
read -rs 'OIDC_ROTATION_API_TOKEN?Rotation API token: '
printf '\n'
export OIDC_ROTATION_API_TOKEN
```

この変数は `staging:deploy` の実行時に必要です。`staging:check`、`staging:bootstrap`、`staging:test` は、この変数を直接読みません。Wrangler の認証と Controller 用トークンは、それぞれ別の用途として用意します。

## 2. デプロイ先を設定する

```sh
pnpm staging:configure \
  --account-id <CLOUDFLARE_ACCOUNT_ID> \
  --workers-subdomain <WORKERS_SUBDOMAIN>
```

`<...>` は実際の値に置き換えます。サブドメインには `https://` や `.workers.dev` を付けません。たとえばアカウントのサブドメインが `example-account.workers.dev` なら、指定値は `example-account` です。

リソース名の接頭辞は既定で `oidc` です。変更する場合は、初回の設定時に `--prefix <worker-name>` を追加します。名前は英小文字で始め、英小文字・数字・ハイフンから成る 3〜41 文字にします。issuer Worker は指定した名前そのものを使い、その他のリソースには `-admin` などの接尾辞を付けます。別の検証環境を作る場合は、たとえば `--prefix oidc-staging` を指定してください。

issuer をカスタムドメインで公開する場合は、`--public-url https://oidc.example.com` を追加します。値は、認証情報、query、fragment、末尾 `/` を含まない HTTPS URL でなければなりません。生成される issuer の設定では、この値を `ISSUER_URL` に使い、そのホスト名のカスタムドメインのルートを追加して、issuer の `workers.dev` URL を無効にします。管理画面は `<公開 URL>/admin/` に移ります。

設定は `.deploy/staging/settings.json` に保存されます。既存の設定とアカウント・サブドメイン・接頭辞・公開 URL が異なる場合、コマンドは拒否します。別環境は別の checkout で管理してください。

## 3. デプロイ前のビルドを確認する

```sh
pnpm staging:check
```

管理画面をビルドし、5つの Worker（issuer、rotation、admin、receiver、smoke）すべてを `wrangler deploy --dry-run` で検査して、binding の型を生成します。リモートのリソースは作成・更新しません。D1 がまだ作成されていない場合、この検査には仮の database ID を使用します。

デプロイ先の設定や認証を用意せず、ビルドだけを確認する場合は次を実行します。

```sh
pnpm staging:check --sample
```

サンプル設定の出力先は `.deploy/sample/` です。`--sample` は check 専用で、deploy には指定できません。dry-run が成功した後も、実環境の権限や通信の確認は必要です。

## 4. D1 と Worker をデプロイする

Wrangler の認証と `OIDC_ROTATION_API_TOKEN` を用意したターミナルで実行します。

```sh
pnpm staging:deploy
```

コマンドは次の順に処理します。

1. Wrangler の認証を確認し、保存済みの database ID がない D1 を `--location apac` で作成します。
2. Policy、Key Registry、Admin の各 D1 に、未適用のマイグレーションをリモートで適用します。
3. 初回は CSRF 用 secret と smoke テスト用トークンを生成し、管理画面をビルドします。
4. issuer → rotation → admin → receiver → smoke の順にデプロイします。rotation のデプロイには鍵生成用の Workflow も含みます。

既定の接頭辞を使う場合、以下のリソースを作成します。

| 種類     | 名前                     | 公開先・用途                                                                                                                                                                                                    |
| -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker   | `oidc`                   | `https://oidc.<WORKERS_SUBDOMAIN>.workers.dev`。公開 HTTP は discovery と JWKS を提供し、`/admin/` を `ADMIN` binding 経由で `oidc-admin` へ転送する。発行は内部 RPC。毎時の削除 Cron                           |
| Worker   | `oidc-rotation`          | 公開 URL なし。鍵生成・ローテーション用 RPC。5分ごとの Cron                                                                                                                                                     |
| Worker   | `oidc-admin`             | 自身の公開 URL なし。パスキー認証の管理画面で、`https://oidc.<WORKERS_SUBDOMAIN>.workers.dev/admin/` から利用する。5分ごとの Cron                                                                               |
| Worker   | `oidc-smoke`             | `https://oidc-smoke.<WORKERS_SUBDOMAIN>.workers.dev`。テスト用トークンで保護した検証用 caller                                                                                                                   |
| Worker   | `oidc-receiver`          | 公開 URL なし。JWT を検証し、認証した API 呼び出しだけを許可する E2E 用の relying party                                                                                                                         |
| D1       | `oidc-policy`            | `clients`、`audiences`、`client_audience_grants`、`policy_audit_events`、`issuance_audit_events`、`issuance_metrics`、`issuance_rate_limits`                                                                    |
| D1       | `oidc-keys`              | `signing_keys`、`issuance_reservations`、`rotation_runs`、`rotation_evidence`、`rotation_schedules`、`rotation_proposals`、`rotation_actions`                                                                   |
| D1       | `oidc-admin`             | `operators`、`operator_identities`、`passkey_credentials`、`webauthn_challenges`、`access_step_up_challenges`、`admin_sessions`、`bootstrap_invites`、`auth_rate_limits`、`admin_audit_events`、`health_checks` |
| Workflow | `oidc-rotation-workflow` | サーバー側の鍵生成と切替                                                                                                                                                                                        |

公開されるホストは issuer と smoke の2つだけです。管理画面は issuer のホストの `/admin/` から提供し、管理 API には認証が必要です。smoke はテスト用トークンを要求します。smoke はテストのために鍵生成を開始できるため、本番環境へ流用しないでください。

デプロイ設定と secret のアップロードはコマンドが行います。Cloudflare 側の secret の扱いは[公式ガイド](https://developers.cloudflare.com/workers/configuration/secrets/)を参照してください。デプロイ後は `unset OIDC_ROTATION_API_TOKEN` で現在のシェルから値を外せますが、後述のローカルファイルにも値が保存されます。

完了すると、コマンドは `Run pnpm staging:bootstrap and pnpm staging:test.` と表示します。2つのコマンドは互いに依存しません。このガイドでは、手順 5 の理由により `staging:test` を先に実行します。

## 5. 初回署名鍵を生成して発行テストを行う

管理画面から audience を追加する前、かつ `staging:bootstrap` の前に実行します。

```sh
pnpm staging:test
```

現用鍵がなければ、smoke Worker が Rotation Controller の鍵生成を開始します。先行公開の待機時間は 60 秒で、コマンドは最初の鍵が有効になるまで最大 3 分待ちます。**署名鍵は deploy の時点では生成されません。初回の test で生成します。**

先に実行する理由は2つあります。

- 最初の切替では、そのアルゴリズムで登録済みのすべての audience について JWKS キャッシュの設定を確認します。audience がまだなければ、切替が止まることはありません。
- bootstrap の招待は作成から15分で期限が切れます。テストの後に作成すれば、パスキー登録に15分をすべて使えます。

鍵が有効になった後、テスト専用の audience、caller、grant を Policy D1 に登録して以下を確認します。

- 固定の Service Binding props で発行でき、RS256 の署名を公開 JWKS で検証できる。
- grant のない audience への発行が拒否される。
- テスト用 caller の停止が次の発行に反映される。テスト後は caller を再び有効にする。
- `/admin/api/me`、`/admin/api/clients`、`/admin/api/keys` への未認証のリクエストが 401、issuer の HTTP 発行経路が 404 を返す。

成功時は `PASS:` の各行と、最後に `Staging smoke test passed.` で始まる行が出力されます。smoke Worker は JWT 本文や秘密鍵を HTTP レスポンスに返しません。このテストでは AWS などのプロバイダーとの資格情報交換は行いません。

そのアルゴリズムの audience がすでに登録されている場合、Controller は最初の鍵を有効にする前に、それらの JWKS キャッシュの設定を確認します。キャッシュの上限が未設定の audience があると切替を止めます。2回目以降のローテーションでは relying party の確認も必要です。[アサーションを検証する](./verifying-assertions.md#jwks-のキャッシュとローテーション)を参照してください。

### Worker 間 E2E テスト

ローカルだけで実行する場合は、Cloudflare へのログインやデプロイは不要です。

```sh
pnpm test:e2e
```

実際の issuer Worker、caller、relying party を別々の workerd Worker として起動します。Service Binding の `ctx.props`、D1、RSA 署名、JWKS、HTTP の Bearer トークンを通し、RPC や署名検証はモックにしません。署名鍵は実行時に生成したテスト用の鍵で、リモート環境には触れません。通常の `pnpm test` にも含まれます。

デプロイ済みの環境では、`pnpm staging:test` が smoke テストに続けて同じ 10 ケースを実行します。

| ケース                              | 確認内容                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `valid`                             | SDK で取得したトークンを Bearer ヘッダーで receiver へ送り、200 になる          |
| `missing-token` / `malformed-token` | トークンなし・不正な形式は 401                                                  |
| `tampered-token`                    | 署名を書き換えたトークンは 401                                                  |
| `wrong-audience`                    | grant のある別の audience 向けに正規発行されたトークンは 401                    |
| `wrong-subject`                     | 別の caller の固定 props で正規発行されたトークンは 401                         |
| `wrong-issuer`                      | 信頼する issuer と一致しない receiver の設定では 401                            |
| `expired-token`                     | 専用 audience の 2 秒有効なトークンが、期限内は 200、同じトークンで期限後は 401 |
| `unique-tokens`                     | 4 並列の発行で `jti` が重複せず、すべて receiver で検証できる                   |
| `audience-denied`                   | grant のない audience は receiver への送信前に発行を拒否される                  |

receiver は RS256、issuer、subject、audience、必須のクレーム、有効期限、最大 300 秒の有効期間を検証します。JWKS は issuer の公開 HTTP ハンドラーから Service Binding 経由で取得し、鍵や DB の binding は持ちません。インターネット経由の JWKS 取得は `/check` の probe が別途確認します。`/wrong-issuer` は issuer 不一致の拒否を確認するためのテスト専用のパスです。

ローカルの 21 ケースには上記に加え、caller の停止・再開、grant 削除、未登録 caller、props 不足、現用鍵なし、鍵 secret 不足、発行制限、relying party が許可しない署名アルゴリズム、要求値による設定の上書き、テスト用認証の欠落、HTTP 発行経路がないことも含みます。デプロイ済み環境でも専用 caller の停止を確認し、テスト後は再び有効にします。鍵や発行制限を変える拒否テストはローカルに限定します。

試験は予約済みの `<prefix>-smoke` と `<prefix>-smoke-other`、`urn:<prefix>:smoke` とその `:other` / `:short-lived` の audience を使用します。これらを通常のアプリケーションに割り当てないでください。HTTP レスポンスには結果だけを返し、JWT 本文や秘密鍵は出力しません。AWS STS など各プロバイダーとの互換性は、このテストの対象外です。

## 6. 初期管理者を登録する

```sh
pnpm staging:bootstrap
```

初期の `security-admin` と、15 分有効の招待を作成します。コマンドが表示する `.deploy/staging/bootstrap.json` をローカルのエディターで開き、次を行います。

1. `adminUrl` の URL をブラウザーで開きます。issuer の URL に `/admin/` を付けた値で、たとえば `https://oidc.<WORKERS_SUBDOMAIN>.workers.dev/admin/` です。
2. 「招待・復旧コードで登録」を選び、`invitationToken` を「招待・復旧コード」に入力します。
3. パスキーを登録し、管理画面に入れることを確認します。

このコマンドは Admin D1 の管理者が 0 人の場合だけ実行できます。追加の管理者は、登録済みの `security-admin` が管理画面から招待してください。登録を終えた招待ファイルは削除できます。

パスキーを登録する前に招待が期限切れになった場合は、`staging:bootstrap` を再実行しないでください。[運用ガイド](./operations.md#パスキーを全員が失った場合)の手順に従い、`pnpm ops recover-admin` で bootstrap の管理者に復旧用の招待を発行します。

## 再デプロイは保存済みの設定を使う

コードを更新したら、Controller 用 API トークンを環境変数に設定して実行します。

```sh
pnpm staging:check
pnpm staging:deploy
pnpm staging:test
```

`staging:deploy` は保存済みの D1 を再利用し、未適用のマイグレーションを適用します。`staging:bootstrap` は初回専用なので再実行しません。`staging:test` は現用鍵があればそれを使い、実行のたびに鍵をローテーションすることはありません。

`.deploy/staging/` には次のファイルが残ります。このディレクトリは Git の追跡対象外です。

| ファイル                                                                    | 内容                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------- |
| `settings.json`                                                             | デプロイ先と作成済み D1 の ID。再デプロイに使用する |
| `issuer.json`、`rotation.json`、`admin.json`、`receiver.json`、`smoke.json` | 生成した Wrangler 設定                              |
| `secrets.json`、`admin.secrets.json`、`smoke.secrets.json`                  | CSRF 用 secret、テスト用トークン                    |
| `rotation.secrets.json`                                                     | Controller 用 Cloudflare API トークン               |
| `bootstrap.json`                                                            | 初期管理者の招待情報                                |
| `wrangler.log`、`operation.sql`                                             | 実行ログと最後に実行した初期化・テスト用 SQL        |

secret や招待を含むファイルをコミット・共有しないでください。環境を引き継ぐ場合は、デプロイ担当者間の秘密情報の受け渡し経路を使用します。`.deploy/staging/` を削除しても Cloudflare のリソースは消えませんが、database ID やテスト用トークンのローカル記録が失われます。

## 失敗時は停止した段階を確認する

| 状況                                             | 確認と対応                                                                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 認証期限切れ・未ログイン                         | `pnpm exec wrangler login` と `pnpm exec wrangler whoami` で認証を確認する                                                                                             |
| Controller 用トークンがない、または権限不足      | 環境変数 `OIDC_ROTATION_API_TOKEN` と対象アカウントの権限を確認する。デプロイ後の鍵生成の失敗は Workflow のログも確認する                                              |
| D1 作成後に ID の解析で失敗した                  | Cloudflare 側に作成された DB と `settings.json` を照合する。コマンドは作成済みの DB を名前から自動で採用しない                                                         |
| 最初の鍵の有効化が 3 分以内に終わらない          | Cloudflare ダッシュボードで rotation Workflow の状態と失敗箇所を確認する。API トークン、issuer の JWKS、デプロイバージョン、登録済み audience のキャッシュ設定を調べる |
| bootstrap が「管理者が存在する」として拒否される | 登録済みの `security-admin` から招待してもらう                                                                                                                         |
| bootstrap の招待が期限切れになった               | bootstrap の管理者を対象に `pnpm ops recover-admin` を実行する。[運用ガイド](./operations.md#パスキーを全員が失った場合)を参照                                         |

コマンドの一覧は `pnpm staging:configure --help` でも確認できます。デプロイで解決できない場合は、停止したコマンド、HTTP ステータス、秘密情報を除いたログをデプロイ担当者へ渡してください。[トラブルシューティング](./troubleshooting.md)も参照してください。

本文の issuer は発行 Worker、caller は発行を依頼する Worker、grant は client と audience の許可関係を指します。実装は [`scripts/staging.mjs`](https://github.com/akita0724/workers-workload-identity/blob/main/scripts/staging.mjs) と [`scripts/deployment-config.mjs`](https://github.com/akita0724/workers-workload-identity/blob/main/scripts/deployment-config.mjs) を参照してください。

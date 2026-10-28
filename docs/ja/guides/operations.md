---
title: 運用ガイド
description: 鍵ローテーション、無効化、監視、D1 保護、アップグレード、廃止を運用する
sidebar:
  order: 7
---

本番運用には、発行が成功するだけでは足りません。運用者は鍵を安全にローテーションし、権限の縮小を次のリクエストから反映し、インシデントを relying party 側で封じ込められる必要があります。本プロジェクトはまだアルファ版のため、このページでは実装済みの動作と、本番リリース前に必要な作業を分けて記載します。

## 鍵は先に公開し、最後の JWT が失効してから削除する

鍵は `prepared`、`active`、`verifying`、`removed` の順に遷移します。

1. Rotation Controller が RSA 3072 bit または P-256 の鍵をサーバー側で生成します。
2. 秘密鍵を issuer Worker の secret に、公開 JWK を Key Registry D1 に保存します。
3. 新しい公開鍵を、署名に使う前に `prepared` 状態で JWKS に掲載します。
4. 先行公開時間が経過したこと、公開 JWKS に新しい鍵が含まれること、最新のデプロイメントがトラフィックの 100% を受ける 1 つのバージョンだけで構成され、そのバージョンが新しい secret を binding していることを確認します。
5. 新しい鍵を `active`、以前の鍵を `verifying` にします。
6. 旧鍵が署名し得た最後の JWT の有効期間、安全余裕、設定した猶予期間を待ちます。
7. 未完了の発行予約がないことを確認してから、旧鍵の secret と公開 JWK を削除します。

アルゴリズムごとの `active` 鍵は、D1 の一意制約で1本に限定されます。ゲートが失敗した場合、ローテーションは先へ進まずに停止します。再試行できる失敗は Workflow が扱います。Cloudflare API の認証・認可の拒否では新しい rotation run が必要です。secret の登録結果が不明な場合は、自動では再開せず手動で整合性を確認します。実装済みの状態と目標設計は、[署名アルゴリズムと鍵ライフサイクル](../design/key-management.md)と [Rotation Controller](../design/rotation-controller.md) の仕様に分けて記載しています。

## client の停止と grant の解除を定期的に試験する

issuer はリクエストごとに Policy D1 の主系を読み、認可結果をリクエストをまたいでキャッシュしません。そのため、client の停止や grant の解除は次の発行から反映されます。

少なくともリリースごとに、次の確認を自動化してください。

- 有効な caller と audience での発行と検証の成功
- grant のない audience の拒否
- client の停止直後の拒否と、再有効化後の復旧
- discovery と JWKS の公開と、HTTP の発行経路がないこと
- issuer、audience、subject、有効期限、署名を改変した JWT の拒否
- 並列発行での `jti` の一意性

`pnpm test:e2e` はローカルの経路を、`pnpm staging:test` はデプロイ済みのステージング環境で中心的なケースを確認します。

## token を記録せずに監視を組み立てる

Wrangler のサンプル設定はログと trace を有効にしています。さらに各 Worker は、次の非機密な情報を記録します。

| 情報                           | 記録元                         | 内容                                                                                             |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| 発行監査イベント               | issuer、Policy D1              | 成功・拒否・失敗ごとのイベント ID、request ID、client、audience、`kid`、結果、所要時間、開始時刻 |
| 発行メトリクス                 | issuer、Policy D1              | 結果ごとの1分単位の件数。JWT と client ID は含まない                                             |
| issuer のヘルスチェック        | admin Worker、Admin D1         | 最新の discovery と JWKS の確認結果、所要時間、確認時刻                                          |
| `issuance-audit-unavailable`   | issuer、JSON ログ              | 監査イベントを保存できなかった。ログにはイベント ID だけを含む                                   |
| `issuance-metrics-unavailable` | issuer、JSON ログ              | メトリクスの書き込みに失敗した。発行は妨げない                                                   |
| `issuer-health-changed`        | admin Worker、JSON ログ        | discovery または JWKS の確認結果が変化した                                                       |
| `rotation-schedule-blocked`    | Rotation Controller、JSON ログ | relying party の確認が不足していたため、期限が来たローテーションのスケジュールを無効化した       |

管理画面は直近24時間の可用性を `success / (success + issuance-unavailable)` として表示します。ポリシー、入力、レート制限による拒否は想定どおりの判定なので除外します。リクエストがない場合、可用性は未計測と表示します。目標値は admin Worker の `ISSUANCE_SLO_PERCENT` で設定し、既定は99.9です。

admin Worker に `ISSUER_URL` を設定すると、5分ごとに discovery と JWKS を確認します。管理画面は15分より古い結果を最新として表示しません。管理画面の「接続を確認」は確認を再実行しますが、プロバイダーとの token exchange は行いません。

本番利用の前に、通知先、当番体制、外部へのアラート送信、D1 のサイズ監視をデプロイ環境ごとに設定してください。rotation run の状態、失敗したゲート、経過時間も確認できるようにします。

JWT 本文、秘密鍵、Cloudflare API token、パスキーの情報、招待 token、交換で得たクラウドの資格情報は、ログや trace に記録しないでください。

## データの保持期間

Cron トリガーが短期間のデータを削除します。ポリシー変更と管理者操作の監査は自動では削除しません。

| データ                                                | 保持期間        | 削除する処理                       |
| ----------------------------------------------------- | --------------- | ---------------------------------- |
| 発行監査イベント（`issuance_audit_events`）           | 30日            | issuer の毎時 Cron（`17 * * * *`） |
| 発行メトリクス（`issuance_metrics`）                  | 30日            | issuer の毎時 Cron                 |
| 発行のレート制限 bucket（`issuance_rate_limits`）     | 60分            | issuer の毎時 Cron                 |
| 発行予約（`issuance_reservations`）                   | 期限切れから1日 | issuer の毎時 Cron                 |
| 管理セッション、WebAuthn と追加認証の challenge、招待 | 期限まで        | admin の5分ごとの Cron             |
| 管理画面の認証レート制限（`auth_rate_limits`）        | 60分            | admin の5分ごとの Cron             |

admin の5分ごとの Cron は、削除の後、`ISSUER_URL` が設定されていれば issuer のヘルスチェックを実行します。issuer の Cron トリガーがないと、これらのテーブルは際限なく増えます。

## コードをデプロイする前にマイグレーションを適用する

更新した Worker をデプロイする前に、各データベースに未適用のマイグレーションをすべて適用してください。先にコードをデプロイすると、存在しないテーブルや列へのアクセスで失敗します。コードを以前の版へ戻す前に、残したスキーマと制約で古いコードが動作することを確認してください。

| データベース    | マイグレーション                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy D1       | `0001_initial`、`0002_operations`、`0003_audience_notes`、`0004_remove_verification_notes`、`0005_remove_verification_date`、`0006_issuance_audit_and_rotation_checks` |
| Key Registry D1 | `0001_initial`、`0002_automation`、`0003_rename_immediate_rotation`                                                                                                    |
| Admin D1        | `0001_initial`、`0002_access_step_up`、`0003_management`、`0004_step_up_actions`、`0005_rename_immediate_rotation`                                                     |

Policy の `0005_remove_verification_date` は、以前の確認日時の列を削除します。削除の前に、確認日時がない、未来の日時である、または180日より古い audience の `jwks_cache_seconds` を `NULL` にします。古い確認が有効な設定として残らないようにするためです。マイグレーション後に、これらの audience を見直してください。Policy の `0006_issuance_audit_and_rotation_checks` は発行監査のテーブルと、未確認の状態で始まる `exchange_verified` と `mixed_jwks_verified` の列を追加します。監査テーブルがなければ、issuer はアサーションを返しません。

`pnpm staging:deploy` は必要な順序でマイグレーションを適用します。マイグレーションのファイルは [`migrations/`](https://github.com/akita0724/workers-workload-identity/tree/main/migrations) にあります。

## D1 と設定を復旧できるようにする

Policy、Key Registry、Admin の各 D1 は、復旧の要件が異なります。環境ごとの手順を作成し、少なくとも次を演習してください。

- client、audience、grant と監査履歴の復旧
- 公開 JWK と鍵状態と、対応する Worker secret との整合確認
- 不要なセッションを失効させたうえでの、管理者とパスキーの復旧
- マイグレーションの適用状態とアプリケーションの版の対応確認

D1 のバックアップでは署名用の秘密鍵を復元できません。秘密鍵をバックアップする場合は、暗号化、アクセス制御、監査、各公開 JWK と `kid` の対応を別途設計してください。秘密鍵を意図的に復元しない方針なら、災害復旧では relying party の信頼を新しい鍵または issuer へ移す必要があります。

## バックアップと隔離したデータベースへの復元

`pnpm ops` には `--config`、`--binding`、`--target` の明示が必要です。`--target remote` は Cloudflare 上の D1 を、`--target local` は開発用のローカル Wrangler の状態だけを対象にします。デプロイ済みのステージング環境では `--target remote` を使い、実行前に account とリソースを確認してください。バックアップには認証関連のデータが含まれるため、保護された場所に保管します。出力ファイルは新規でなければならず、権限は0600に制限されます。

```sh
pnpm ops backup --config .deploy/staging/admin.json --binding ADMIN_DB --target remote --out /tmp/admin-backup.sql
```

Policy と Key Registry は、`.deploy/staging/issuer.json` と `POLICY_DB`、`KEY_DB` の binding を指定して個別にエクスポートします。これらのエクスポートは分散トランザクションではありません。整合した復旧点が必要なら、管理変更、発行、ローテーションを止め、Cloudflare 自体の復旧機能も検討してください。D1 のエクスポートには issuer の secret は含まれません。

`restore` は、選択したデータベースに対して `wrangler d1 execute --file <file> --yes` を実行するだけです。対象が隔離された空のデータベースかどうかは確認せず、何も失効させません。最初は必ず**隔離した空のデータベース**へインポートし、稼働中の本番データベースには使わないでください。

```sh
pnpm ops restore --config /path/to/isolated-admin.json --binding ADMIN_DB --target remote --file /tmp/admin-backup.sql --confirm-restore
```

その後、次の手順を手動で行います。

1. `restore` の実行前に、設定が隔離した空のデータベースを指していることを確認します。
2. インポート後に、管理セッション、WebAuthn と追加認証の challenge、未使用の招待を削除します。
3. 管理者の状態と監査履歴を確認します。
4. 廃止済みの鍵や停止済みの client を復活させずに、Policy と Key Registry をデプロイ中の issuer、公開鍵、secret と照合します。

本番として受け入れる前に、実際の復旧演習を完了してください。[D1 のインポートとエクスポート](https://developers.cloudflare.com/d1/best-practices/import-export-data/)も参照してください。

## パスキーを全員が失った場合

別のセキュリティ管理者がログインできる場合は、管理画面の「パスキーの復旧を開始」から復旧用の招待を発行します。それができない場合は、デプロイ担当者が既存の有効な `security-admin` を対象に指定し、本人確認を行い、理由を記録します。コマンドは対象者のパスキーとセッションを失効させ、15分で期限が切れる一回限りの招待を発行します。新たに誰かを管理者へ昇格させることはしません。

```sh
pnpm ops recover-admin --config .deploy/staging/admin.json --binding ADMIN_DB --target remote --operator 11111111-1111-4111-8111-111111111111 --reason "本人確認済み、全管理端末を紛失" --confirm-revoke-credentials --out /tmp/admin-recovery.json
```

`--operator` には管理者の ID を小文字の UUID で指定します。`--reason` は8〜1,024文字で、管理者の監査ログに保存されます。最初のパスキーを登録する前に bootstrap の招待が期限切れになった場合も、このコマンドで復旧できます。

招待 token は `--out` で指定した新規ファイルにだけ書き込まれ、標準出力や監査ログには出ません。ログイン画面で「招待・復旧コードで登録」を選び、「招待・復旧コード」に token を入力して新しいパスキーを登録します。その後、復旧ファイルを削除してください。Cloudflare Access モードでは、このパスキー用コマンドではなく、Access アプリケーションと ID 管理側の復旧手順を使います。

## 発行監査と relying party の確認

発行イベントは既存の監査画面と API に表示されます。client、audience、結果、request ID、鍵 ID で検索できます。

セキュリティ管理者は audience の編集画面で、現在の署名アルゴリズムで認証が成功すること（交換方式の relying party では資格情報の交換）、新旧の公開鍵を同時に掲載しても relying party が受理すること、JWKS キャッシュの上限の3つを記録します。API の項目は `exchangeVerified`、`mixedJwksVerified`、`jwksCacheSeconds` で、`ES256` では `verifiedForEs256` も必要です。`operator` ロールの管理者は確認内容を変更できません。管理画面で署名アルゴリズムを変更すると、見直しのために確認が解除されます。

Policy の `0006` より前から存在する audience は、新しい確認が未設定の状態で始まります。キャッシュの上限だけでは自動化を有効にできません。スケジュールの有効化時、期限が来た各実行時、通常の切替の直前に、そのアルゴリズムのすべての audience を確認します。確認が不足していれば、期限が来たスケジュールを無効化するか、旧鍵を現用のまま切替を止めます。両方の鍵を残したまま確認を修正し、安全な再試行を行ってください。

明示的な即時ローテーションでは、従来どおり relying party のための待機と確認のゲートを省略します。デプロイと JWKS の整合性のゲートと、旧鍵の廃止のゲートは引き続き適用します。

アルゴリズムごとの最初の鍵は、認証成功と新旧鍵の受理の確認から除外されるため、relying party を試験する前に有効化できます。自動化には現用鍵が必要です。

## アップグレードの段階を飛ばさない

```sh
pnpm staging:check
pnpm staging:deploy
pnpm staging:test
```

デプロイの前に、マイグレーション、共有の契約、caller SDK、issuer、relying party の fixture の互換性を確認します。JWT のクレーム、RPC の入出力、公開エラーコード、discovery、JWKS の変更は、通常の内部リファクタリングではなくプロトコルの変更です。

署名用の secret と JWKS は常に整合している必要があるため、署名に関わる変更では計画外の段階的デプロイを避けてください。複数のバージョンがトラフィックを受ける場合は、すべてのバージョンが同じ公開鍵の集合と必要な secret を持つことをローテーションのゲートで確認する必要があります。

## 廃止は relying party の側から逆順に進める

新しい発行を止めた直後に JWKS を削除しないでください。

1. 新しい client と grant の追加を止めます。
2. relying party の信頼ポリシーと資格情報のマッピングを、後継の issuer へ移します。
3. 旧 client を停止し、交換済みの資格情報の最大有効期間を待ちます。
4. 最後の JWT の `exp` と JWKS のキャッシュ時間を待ちます。
5. issuer、admin、rotation のリソース、D1 データベース、secret を削除します。
6. 監査記録は組織の方針に従って保管または削除します。

ステージングスクリプトは削除を自動化しません。`.deploy/staging/` を削除しても Cloudflare のリソースは削除されません。

## 既知の制約

- admin Worker は、Rotation Controller の RPC やパスキー操作から返された、識別できないエラーを、汎用の HTTP 503 `{ "error": "unavailable" }` に変換します。例として、スケジュールのバージョン競合、relying party の確認が記録されていないためにスケジュールやローテーションが止められた場合、並行するリクエストがパスキーのチャレンジを先に消費した場合があります（既に消えたチャレンジを再利用した場合は、通常 400 `invalid-input` を返します）。そのため、管理画面はローテーション操作やパスキー操作の失敗理由を表示できない場合があります。Rotation Controller のログと rotation run の状態を確認してください。

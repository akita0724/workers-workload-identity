---
sidebar:
  label: 受け入れ基準
---

# 受け入れ基準と検証計画

**状態:** 目標設計。この文書は設計に対するテスト計画であり、現時点で合格を示すものではない。要件 ID は [要件定義](./requirements.md) を参照する。

## 1. アーキテクチャの検証

| ID   | 合格条件                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-01 | 公開 HTTPS の OIDC 経路では discovery と JWKS を取得でき、`/admin/` は Admin Worker へ中継される。発行 RPC は直接 HTTP で呼べず、Service Binding からのみ発行できる。                                                                                                                                                                                                                                                                     |
| A-02 | `ctx.props.clientId` が欠落・不正・未登録・無効なら発行できない。RPC 引数や HTTP header の client ID で識別を上書きできない。                                                                                                                                                                                                                                                                                                             |
| A-03 | Worker runtime で採用ライブラリの RS256 署名・検証・JWK 出力を実行できる。ES256 を有効化する場合は同じ試験を P-256 鍵で行う。Node 専用 API への依存を検出する。                                                                                                                                                                                                                                                                           |
| A-04 | 本番相当 account で管理者、Worker 編集者、CI/API token の実効権限を棚卸しする。アカウント外主体は issuer への Service Binding をデプロイできず、信頼しないアカウント内主体は別 caller の `props.clientId` を指定した発行を成立させられないことを負の実機試験で確認する。全デプロイ主体を単一の信頼境界に置く場合は、その範囲と変更監査を記録する。中央 CI は合格条件にしない。公開 handler から loopback binding を通じた発行もできない。 |
| A-05 | 管理 UI/API は issuer と同じ公開ホストの `/admin/` から別 Admin Worker へ中継され、認証なしでは管理データへ到達できない。Admin Worker に発行秘密鍵と発行 RPC の Binding がない。                                                                                                                                                                                                                                                          |
| A-06 | Policy D1 の client 停止と grant 解除が、issuer の次の発行要求で拒否として反映される。読取障害は fail closed。issuer に Admin D1 Binding がない。                                                                                                                                                                                                                                                                                         |
| A-07 | Admin Worker に Key Registry D1 Binding、秘密鍵、Cloudflare Worker 更新 token がない。Controller の許可外操作・対象 Worker 指定・鍵材入力を拒否する。                                                                                                                                                                                                                                                                                     |
| A-08 | Key Registry D1 の公開鍵が JWKS と一致し、Admin Worker の Policy D1 更新では公開 JWK や `active` 鍵を変更できない。                                                                                                                                                                                                                                                                                                                       |
| A-09 | Admin SPA の deep link と `/api/*` が正しく振り分けられ、API は HTML fallback を返さない。passkey の公開 shell/asset に管理データがなく、Access モードでは公開ホストの管理パス全体が保護される。                                                                                                                                                                                                                                          |

## 2. 発行と検証

| ID   | 合格条件                                                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-01 | 正規 caller は許可 `aud` の JWT を取得し、`iss`/`sub`/`aud`/`iat`/`nbf`/`exp`/`jti`、audience policy が選んだ `alg` と `kid` が想定どおり。                                                                                                     |
| T-02 | 未登録 client、無効 client、欠落/不正 `ctx.props`、不正 `aud` を発行時に拒否する。relying party は署名不正、未知 `kid`、期限切れ、未来の `iat` を拒否する。                                                                                     |
| T-03 | client が `sub`、TTL、署名アルゴリズム、追加クレームを入力しても任意変更できない。`kid` と鍵種別・`alg` の不一致は拒否する。                                                                                                                    |
| T-04 | JWT を relying party で別 `aud`、別 `iss`、別用途、許可外 `sub` に使うと拒否される。                                                                                                                                                            |
| T-05 | メタデータの `issuer` と JWT の `iss` が一致し、JWKS に秘密パラメータが存在しない。                                                                                                                                                             |
| T-06 | 新鍵の先行公開、全配信バージョンでの JWKS 一致確認、キャッシュ待機、切替、旧 JWT 失効後の旧鍵削除を通して検証結果が設計どおり。切替中の段階的デプロイとロールバック制限も確認する。                                                             |
| T-07 | 発行 JWT、issuer 秘密鍵、交換後資格情報が標準ログとエラーレスポンスに出ない。                                                                                                                                                                   |
| T-08 | audience policy が RS256 の場合、caller が ES256 を要求しても変わらない。ES256 opt-in 時は対象外 audience が RS256 のままで、混合 JWKS と metadata の両方が relying party に受理される。                                                        |
| T-09 | 鍵の `kid`、公開鍵、`alg` の対応が一貫し、鍵の再利用・重複・秘密成分の公開を拒否する。                                                                                                                                                          |
| T-10 | Zod が管理 API の未知フィールド、不正 TTL/alg/aud、欠落 `ctx.props`、不正 DB 行を拒否する。UI の検証を迂回してもサーバー側の判定が同じ。                                                                                                        |
| T-11 | UI の鍵生成要求で公開 JWK と `kid` だけが返り、秘密鍵が画面、Admin Worker、D1、Workflow の payload/step result、標準ログに現れない。Controller が生成した鍵と issuer secret binding の署名検証が一致する。                                      |
| T-12 | 自動ローテーションは新鍵先行公開、全配信 version の secret 確認、relying party のキャッシュ待機、新鍵発行、旧 JWT の失効後の旧鍵廃止を順守する。デプロイ競合、観測欠落、API 障害、重複 schedule、途中再試行では切替を停止または安全に再開する。 |
| T-13 | `T_publish` から `T_remove` まで JWKS に旧・新公開鍵が並び、切替前は旧鍵、切替後は新鍵だけで新規署名する。切替延期時は同時掲載を延長し、旧鍵の最終発行上界が不明な場合は自動削除しない。                                                        |
| T-14 | 鍵ローテーション直前に始まった旧鍵発行の予約・期限・完了を競合テストで確認し、旧鍵の最終発行上界を実証する。予約が残るか期限を保証できない場合は旧鍵の自動削除を拒否する。                                                                      |
| T-15 | audience を ES256 へ移した後の RS256 復帰は、旧アルゴリズムの鍵と secret binding を保持する期間にだけ成功する。廃止済み鍵への policy 復帰を拒否する。                                                                                           |
| T-16 | client ごとの発行レート制限は並行・分散要求で上限を守り、超過時に発行を拒否する。制限状態の障害時に許可が広がらないことを確認する。                                                                                                             |

## 3. 外部との互換性ゲート

「対応済み」と公表する各プロバイダーにつき、隔離された検証環境で以下を実施し、設定手順、使用したメタデータ、成功・失敗結果、日付、製品仕様へのリンクを記録する。ローカルの署名・JWKS テストだけでプロバイダーへの対応済みとしない。Microsoft Entra は将来候補であり、ベータ版のゲートの 4 対象に含めない。

| 対象                        | 必須の実機確認                                                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS                         | IAM OIDC provider 作成、対象 role の `aud`/`sub` 制限、STS `AssumeRoleWithWebIdentity` 成功、別 `aud`/`sub` 失敗、発行鍵ローテーション後の挙動。discovery の標準整合性を別途レビューする。                                                                                    |
| Google Cloud                | Workload Identity Pool/Provider 作成、属性条件で `sub` を絞った交換成功、別 `aud`/`sub` 失敗、鍵ローテーション後の挙動。                                                                                                                                                      |
| Claude API                  | federation issuer、service account、`aud` と `sub` を絞った rule、workspace/scope を設定し、JWT bearer grant による交換と最小権限の API 呼出を確認。別 `aud`/`sub`、期限切れ、鍵ローテーション、JWKS 取得・キャッシュ、交換後 token の寿命も確認。                            |
| OpenAI API                  | 任意 OIDC issuer の登録可否を提供元に確認し、本 issuer による provider/mapping と token exchange を実機で試す。受理される場合は別 `aud`/`sub`、最小権限 API 呼出、鍵ローテーション、JWKS 取得・キャッシュも確認。受理されない場合は非対応として記録し、サポートを表明しない。 |
| Microsoft Entra（将来候補） | 対応を表明する時は federated identity credential の issuer/subject/audience 一致で交換成功、不一致で失敗、鍵ローテーション後の挙動を確認。                                                                                                                                    |
| 独自 API                    | 署名、`iss`、単一 `aud`、`sub`、時刻、鍵更新、用途分離の検証。                                                                                                                                                                                                                |

AWS、Google Cloud、Claude API、OpenAI API は現時点では**検証対象**であり、対応済みではない。4 対象すべての実機検証を終えてからベータ版を出す。ベータ版のゲートの正本は [リリース状況](../reference/release-status.md) とする。提供元制約による非対応や検証不能も結果として公表し、成功した対象だけをサポート表へ載せる。[プロバイダーの実機検証計画](./provider-validation.md) と [プロバイダー対応状況](../reference/provider-support.mdx) を参照する。

アルゴリズム別の試験は [署名アルゴリズムと鍵ライフサイクル](./key-management.md) に従う。RS256 以外を「対応済み」とするには、その audience の relying party が混合 JWKS と当該署名方式を受理する実機証拠を必要とする。

## 4. 運用ゲート

管理画面のパスキー・Cloudflare Access・RBAC・CSRF・監査・初期管理者・復旧の試験は [管理画面の受け入れ基準](./admin-console.md#6-管理画面の受け入れ基準) を満たす。本番設定では認証方式を明示的に一つ選び、暗黙のフォールバックを許さない。

- 鍵の通常交換と漏えい対応の演習を実施し、旧鍵をいつ外せるかを relying party のキャッシュの実測または文書で説明できる。
- caller 停止後、既発行 JWT とクラウド一時資格情報の残存時間を運用手順で扱う。
- 公開メタデータ、発行、client 登録情報の異常を独立に検知できる。
- README とリリースノートに未検証のクラウドや OIDC 適合性を「対応済み」と記載しない。

ベータ版のゲート（AWS、Google Cloud、Claude API、OpenAI API の実機検証、秘密情報スキャン、セキュリティ報告窓口などを含む）は [リリース状況](../reference/release-status.md) にだけ列挙する。

## 5. 現在のローカル検証

caller SDK と issuer の共有契約は実装済みである。`packages/client/src/index.test.ts` と型検査用の `index.typecheck.ts` で、禁止された引数、設定不正、応答形式、公開エラー分類、再試行・キャッシュの不使用を確認する。

`apps/issuer-worker/test/issuance.test.ts` は workerd 上で一時的な RSA 鍵とローカル D1 を使い、SDK 経由の発行、JWKS の公開鍵による RS256 検証、caller 停止・grant 解除の即時反映、props 欠落と引数偽装の拒否、共有レート制限、設定・DB 障害時の拒否、HTTP からの発行不可を確認する。これらは A-01・A-02・A-03・A-06、T-01・T-02・T-03・T-05・T-16 のローカル検証に当たり、各条件の本番相当試験の完了を意味しない。

テスト用 loopback は固定 props を持つ別 Worker の Service Binding の代替証拠にはしない。A-04 の実効権限、本番相当の Worker 間通信、鍵ローテーション、管理画面と API の受け入れ条件、プロバイダーの実機確認は引き続き未完了とする。[caller ライブラリの受け入れ条件](./client-library.md#受け入れ条件) も適用する。

---
sidebar:
  label: 鍵ライフサイクル
---

# 署名アルゴリズムと鍵ライフサイクル

**状態:** 実装済み。鍵ライフサイクルは Rotation Controller（`apps/rotation-worker`）が、発行予約は issuer が実装している。プロバイダーごとの待機時間とアルゴリズム対応は、引き続き実機検証を要する。

## 1. アルゴリズムの選定

| relying party                                | RS256        | ES256          | 判断根拠と扱い                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS STS `AssumeRoleWithWebIdentity`          | 文書上対応   | 文書上対応     | RSA/EC の許容アルゴリズムに含まれる。実機成功後にサポートを表明する。[AWS STS](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html)                                                                                                                                                |
| Google Cloud Workload Identity Federation    | 文書上対応   | 文書上対応     | 外部 OIDC assertion の署名に RS256/ES256 を許容。[Google Cloud](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers)                                                                                                                                                             |
| Claude API Workload Identity Federation      | 文書上対応   | 文書上対応     | Claude の WIF reference は RSA/ECDSA 系を許容。対象アカウントで実機確認する。[Claude WIF reference](https://platform.claude.com/docs/en/manage-claude/wif-reference)                                                                                                                                                  |
| OpenAI API Workload Identity Federation      | 実機確認前   | 実機確認前     | 公式文書は JWT の `alg` を検証するが、任意の OIDC issuer を現時点の制約としている。署名方式と issuer 登録の双方を実機で確認する。[OpenAI WIF](https://developers.openai.com/api/docs/guides/workload-identity-federation)、[token exchange](https://developers.openai.com/api/reference/workload-identity-federation) |
| Microsoft Entra workload identity federation | 文書上対応   | サポート対象外 | Microsoft は RS256 のみをサポート対象とする。[Microsoft](https://learn.microsoft.com/en-us/azure/active-directory/workload-identities/workload-identity-federation-considerations)                                                                                                                                    |
| AWS API Gateway JWT authorizer               | 文書上対応   | 非対応         | RSA 系のみ。STS と別製品として扱う。[API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)                                                                                                                                                                          |
| 独自 API                                     | 検証規則次第 | 検証規則次第   | relying party の明示的な allowlist と相互運用試験で決める                                                                                                                                                                                                                                                             |

Cloudflare Workers の Web Crypto は RSA PKCS#1 v1.5、ECDSA、Ed25519 等の署名に対応する。しかし **runtime が署名できることと、相手が受理することは別**である。初期版は `RS256` を必須の既定値、`ES256` を audience ごとの opt-in とする。`EdDSA`、`PS256`、`RS384`、`RS512` 等は実装拡張点に残すが、初期版のクラウド交換には使用しない。[Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

ES256 を opt-in にする条件は、対象の relying party が ES256 JWT と RSA/EC 混合 JWKS を処理できる実機試験、relying party 側の設定変更手順、RS256 へ戻す手順が揃うこと。Entra や API Gateway を含む audience に ES256 を割り当てない。アルゴリズムは issuer の audience policy が固定し、RPC 引数では受け取らない。

1 つの `aud` を複数の relying party が共用する場合、全員が受け付けるアルゴリズムの共通部分だけを選ぶ。互換性または権限が異なる relying party には別の `aud` を割り当てる。メタデータの署名方式は実装が扱える方式を表し、現在利用できる鍵の一覧ではない。新アルゴリズムを使い始める前に、全配信バージョンの JWKS と各 relying party の対応を確認する。

## 2. 鍵と JWKS の不変条件

- 各鍵には環境・issuer 内で一意の不透明な `kid` を割り当て、異なる公開鍵や `alg` に再利用しない。Controller は `kid` をランダムな UUID として生成する。
- `RS256` 鍵は RSA 鍵である。Controller は常に 3072 bit の RSA 鍵を生成し、鍵長を変える設定はない。`ES256` 鍵は P-256 を使う。RSA と EC の鍵が同じ `kid` を共有することはない。
- JWK は公開成分のみとし、`kid`、`kty`、`use: "sig"`、`alg` を明示する。RSA は `n`/`e`、EC は `crv`/`x`/`y` を載せる。秘密成分、対称鍵、未使用鍵は載せない。
- 発行時には issuer が鍵レコードの `alg` と JWK の型を検査してから `jose` へ渡す。relying party には許容 `alg` を明示し、JWT header の値だけで検証アルゴリズムを広げない。[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)
- 1 つの issuer の公開 JWKS は RS256 と ES256 の鍵を同時に含み得る。ただし混合 JWKS に弱い relying party が見つかれば、その relying party に新アルゴリズムを有効化しない。必要なら別 issuer URL の互換性プロファイルを新設し、信頼する issuer を再登録する。
- 通常時の JWKS は 1 アルゴリズムにつき現用 1 鍵、ローテーション時は旧・新 2 鍵までを運用目標とする。AWS の JWKS 鍵数上限等に近づかない。[AWS IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)

秘密鍵は鍵ごとに異なる issuer Worker secret binding に保存する。公開鍵マニフェストの正本は issuer と Rotation Controller だけが接続する **Key Registry D1** とし、`kid`、`alg`、公開 JWK、対応する secret binding 名、鍵状態を置く。Admin Worker が書ける Policy D1 へ JWKS の鍵を置くと、管理面の侵害から攻撃者の公開鍵を信頼させられるため分離する。いずれの D1 にも**秘密鍵本体を置かない**。Worker secret を Web Crypto に import しても、元の secret 値が Worker 実行環境に渡るため、外部 KMS の非エクスポート鍵と同等の保護とは説明しない。[Rotation Controller](./rotation-controller.md) を参照する。

## 3. 鍵状態と選択規則

| 状態        | JWKS に掲載 | 発行で使用 | 意味                                           |
| ----------- | ----------- | ---------- | ---------------------------------------------- |
| `prepared`  | はい        | いいえ     | 新鍵を先行公開し、relying party に取り込ませる |
| `active`    | はい        | はい       | そのアルゴリズムの新規 JWT に署名する唯一の鍵  |
| `verifying` | はい        | いいえ     | 旧 JWT の検証のために残す旧鍵                  |
| `removed`   | いいえ      | いいえ     | 鍵廃止。元の `kid` は再使用しない              |

### 公開鍵の移行期間

定期ローテーションは**旧鍵 A と新鍵 B が JWKS に同時掲載される期間**を必須とする。署名に使う鍵は対象 `alg` ごとに常に 1 つだけで、複数の公開鍵があることは同時に複数の新規署名鍵を選ぶことを意味しない。

| 区間                        | JWKS  | 新規発行 | 切替条件                                                                 |
| --------------------------- | ----- | -------- | ------------------------------------------------------------------------ |
| `T_publish` より前          | A     | A        | B の secret と公開鍵を準備                                               |
| `T_publish` ～ `T_activate` | A + B | A        | B を先行公開し、全配信 version と relying party のキャッシュの待機を確認 |
| `T_activate` ～ `T_remove`  | A + B | B        | A で発行済みの JWT を検証可能に保つ                                      |
| `T_remove` 以降             | B     | B        | A の最終発行 JWT が失効し、許容時刻ずれを過ぎたことを確認                |

`T_activate - T_publish` の下限は、対象の全 relying party で確認した JWKS の最大キャッシュ時間に伝搬余裕を足して決める。`T_remove` は計画時刻から機械的に決めず、**A の最終発行時刻の保守的な上界 + 最大 JWT 有効期間 + 許容時刻ずれ + 運用余裕**以降とする。切替が遅れたら旧・新の同時掲載を延長し、早めに旧鍵を除かない。relying party のキャッシュ上限が不明なら自動切替を有効化しない。漏えい時の緊急廃止は別のインシデント手順とする。

A の最終発行時刻の上界は発行予約で定める。issuer は署名前に、選んだ鍵の予約を Key Registry D1 に挿入する。挿入はその鍵が `active` の間だけ成功し、予約は 30 秒後に期限切れとなる。署名を終えた時点で予約が期限切れなら、issuer はその JWT を破棄して失敗を返す。切替後の A は新たな予約を取得できず、未完了かつ期限内の A の予約が残る間は廃止に進まない。Cloudflare の実行時間を暗黙の上限として使わない。

切替時に Controller は切替時刻を `lastOldIssuedAt` として記録し、`removeNotBefore` を **切替時刻 + 330 秒 + `retirementGraceSeconds`** に設定する。330 秒は、アサーションの最大有効期間 300 秒と予約期間 30 秒の和である。猶予期間（300 秒以上）は時刻ずれと運用余裕を吸収する。

ローテーション計画のスキーマは Zod で `prepublishSeconds`（60～2,592,000）と `retirementGraceSeconds`（300～2,592,000）を検証する。通常の切替ではさらに、そのアルゴリズムを使う全 audience に JWKS キャッシュ上限が設定され、`prepublishSeconds` がその上限に 60 秒を加えた値以上であることを要する。Registry は実際の `publishedAt`、`activatedAt`、`lastOldIssuedAt`、`removeNotBefore` を保持する。scheduler は、同じ `alg` に `removed` でも `failed` でもない実行が残る間は新しいローテーションを開始しない。RS256 と ES256 を併用する場合、移行中の JWKS には各アルゴリズムで旧・新 2 鍵、合計最大 4 鍵が載り得る。relying party の JWKS 上限は事前に確認する。

Key Registry D1 のマニフェストを、発行と JWKS の両方が参照する。発行では `alg` ごとに高々 1 つの `active` 鍵を選び、対応する issuer Worker secret binding がない・鍵ペアが一致しない時は fail closed にする。段階的デプロイ中は旧・新バージョンが混在し得るため、Controller は新鍵の binding が配信中のバージョンに存在することを確認するまで `active` を切り替えない。JWKS は切替前から旧・新両方の公開鍵を返す。公開 JWKS の障害は別途監視する。

## 4. 通常ローテーション

ローテーションは管理画面から開始する。`security-admin` は直接開始できる。`operator` または `security-admin` は提案でき、提案には提案者以外の `security-admin` の承認を要する。同じゲートを通る自動スケジュールも実装済みである。自動化の有効化は relying party の鍵キャッシュ挙動と切替ゲートの実測後に限る。

管理画面は新鍵生成と、ローテーションの開始・承認・一時停止・再開・再試行・状態確認を提供する。ブラウザーは鍵材を生成・アップロード・表示しない。Rotation Controller がサーバー側で鍵を生成して Cloudflare に登録する。Controller は管理画面から JWK や `kid` を受け取らず、自身で生成し、状態遷移を実環境の証拠で検証する。権限境界と失敗回復は [Rotation Controller](./rotation-controller.md)、運用者側の操作は [管理画面](./admin-console.md) を参照する。

Controller は Cloudflare のデプロイメント API でデプロイメントを作成・変更しない。デプロイメントとバージョンは検証のために読み取るだけであり、issuer を変更するのは [Worker Secrets API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/) による secret のアップロードと削除だけである。

1. **準備:** Controller が Web Crypto で新鍵 B を生成し、公開 JWK と秘密鍵を分離する。秘密鍵 B を専用の issuer Worker secret としてアップロードすると、Cloudflare がその binding を持つ issuer の新バージョンを作る。続いて Key Registry D1 に B を `prepared` として登録し、A は `active` のままとする。秘密鍵は Controller のメモリと Cloudflare API への転送中にのみ存在する。アップロードの結果が不明な場合、実行は `secret-staging` に留まって再試行できず、手動での復旧を要する。
2. **先行公開:** 発行は A のまま、公開 JWKS に B が載る。Controller は `prepublishSeconds` だけ待つ。対象 relying party の JWKS キャッシュ・未知 `kid` の再取得・メタデータ更新間隔を文書または実機で確認し、キャッシュ上限を各 audience に記録する。AWS API Gateway の JWT authorizer では最大 2 時間の公開鍵キャッシュが文書化されているが、これを AWS STS の挙動と混同しない。[API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
3. **切替:** 切替前に Controller は audience のキャッシュ上限と relying party の確認結果を検査し、公開 JWKS に B があること、最新のデプロイメントが 100% の単一バージョンで、その binding に B の secret が含まれることを確認する。いずれかが満たされなければ切替は失敗し、A が署名を続ける。満たされれば Key Registry D1 の条件付き更新で B を `active`、A を `verifying` にし、デプロイメントの証拠を記録する。以後の発行は B となり、JWKS は A/B 両方を返す。`kid` 別の発行数、外部交換の失敗、JWKS エラーを監視する。切替の進行中は issuer をデプロイしない。[Cloudflare versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
4. **旧鍵の廃止:** `removeNotBefore` を過ぎ、A の未完了の予約が残っていない場合に限り、Controller は A の secret を削除して A を `removed` にし、A を JWKS から外す。以後 A のみを持つバージョンへロールバックせず、必要な回復は B 以降へ roll forward する。

即時ローテーションは先行公開の待機、audience のキャッシュ検査、relying party の確認の検査を省略するが、JWKS とデプロイメントの検証は行い、廃止の時期も変わらない。

新しいアルゴリズムへ移る時も同じ手順を使う。まず新アルゴリズムの公開鍵を先行掲載し、混合 JWKS を relying party が読めることを確認し、対象 audience だけを切り替える。RS256 へ戻す予定期間は RS256 の有効な秘密鍵・公開鍵・全配信版の binding を保持し、問題が出たらその audience の policy を RS256 に戻す。RS256 の鍵を廃止した後の復帰は policy 変更だけでは行えず、新鍵を準備・先行公開・デプロイする手順を要する。

## 5. 緊急時と失効の限界

秘密鍵漏えい時は該当鍵での新規発行を直ちに止め、新鍵を公開・有効化し、旧鍵を JWKS から除去する。同時に relying party 側の信頼設定、ロール、権限、交換済みの一時資格情報の停止を検討する。relying party が旧 JWKS をキャッシュしていれば、JWKS からの削除だけで旧署名が直ちに拒否されるとは限らない。通常の先行公開期間を待てないため、一時的な認証停止を許容するインシデント手順を用意する。

caller の Binding を止めても、既に発行した短命 JWT や交換済みのクラウド資格情報は失効まで残り得る。issuer の `jti` は発行記録の識別子であり、relying party に強制失効を伝える仕組みではない。[AWS IAM の鍵漏えい対応](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)

## 6. 運用時に記録する値

鍵ごとに `kid`、`alg`、生成日時、公開開始、署名開始、署名終了、最終 JWT 失効時刻、JWKS 削除時刻、デプロイバージョンを記録する。audience ごとに対象の relying party、対応アルゴリズム、JWKS キャッシュ上限を管理する。鍵生成間隔は運用ポリシーで決め、実測前に固定の安全期間を保証値として公表しない。

relying party の JWKS キャッシュ上限は audience ごとに管理者が入力する。未設定、または先行公開期間がキャッシュ上限に 60 秒を加えた時間に満たない場合、通常の鍵ローテーションは停止する。確認日は保存せず、設定の見直しは運用者が行う。

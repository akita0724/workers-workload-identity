---
sidebar:
  label: 要件定義
---

# ワークロード ID アサーション発行サービス 要件定義

**状態:** 一部実装。初期実装はローカルとステージングの検証を通過している。本番受け入れとプロバイダーの実機検証は未完了である。

## 1. 目的と前提

Cloudflare Worker で動く社内サービスが、AWS を含む外部サービスにアクセスする際に、恒久的なクラウドアクセスキーを配布せず、固有のサービス ID を持つ短命の署名付き JWT を取得できるようにする。利用先は AWS に限定しない。相手が独自 API の場合は JWT を直接検証し、クラウドの ID 連携機能がある場合は JWT を一時クレデンシャルへ交換する。

OSS 名は `workers-workload-identity`。デフォルトの発行 Worker 名は `oidc`、issuer URL は `https://oidc.<WORKERS_SUBDOMAIN>.workers.dev` とする。独自ドメインの例は `https://oidc.example.com`。ステージングは別の issuer、鍵、client 登録、relying party の信頼設定を持つ。ステージングのドメインは運用者が決める。公開する OSS 実装では issuer URL を設定可能にする。

以下の「必須」は初期版の実装受け入れ条件、「推奨」は初期版で実装を目指す条件、「将来」は明示的に対象外の候補とする。

## 2. 用語と境界

| 用語               | 意味                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| caller             | issuer に発行を依頼する Cloudflare Worker                                                                   |
| issuer             | JWT に署名し、公開メタデータと公開鍵を配信する専用 Worker                                                   |
| client ID          | issuer が caller ごとに割り当てる不変の識別子                                                               |
| subject (`sub`)    | relying party のポリシーで識別する、環境内で一意かつ再利用しないサービス ID                                 |
| audience (`aud`)   | 1 つのトークンの意図した relying party・交換先                                                              |
| workload assertion | issuer が発行するサービス ID の JWT。エンドユーザーの ID トークンや一般的な API access token と同一視しない |
| relying party      | JWT を検証する独自 API、またはクラウドのトークン交換サービス                                                |

Cloudflare Service Binding は caller から issuer への内部到達経路である。指定した named RPC entrypoint に Binding の `props` を設定すると、issuer は `this.ctx.props` からその値を読む。Cloudflare はこの値を設定できる権限を制御すると説明しており、初期版ではこれを caller 認証の根拠とする。単に Binding があるだけで Worker 名が自動的に渡るとは扱わない。[Cloudflare Context: `ctx.props`](https://developers.cloudflare.com/workers/runtime-apis/context/)

caller 向けの型安全な Binding 設定・RPC ライブラリは[caller ライブラリの要件定義](./client-library.md)に定める。矛盾がある場合は本文の認証・認可・発行ポリシーを優先する。

## 3. 対象範囲

### 必須

- issuer 専用 Worker と公開 HTTPS ドメイン。
- Service Binding を使う内部発行 API。発行メソッドはインターネットから呼べない構成にする。
- caller ごとの Service Binding `props` と issuer 側の登録情報: client ID、固定 `sub`、許可された `aud` の集合、有効/無効状態。
- `ctx.props` による caller 識別、発行ポリシー評価、JWT 署名。
- 公開鍵集合と互換性に必要なメタデータの公開。
- 独自 API 向け検証プロファイルと、AWS、Google Cloud、Claude API、OpenAI API での実機相互運用検証。各対象の結果は成功・非対応・検証不能を区別して記録し、成功した対象だけを対応済みとする。
- 鍵ローテーション、停止、監査の運用手順。
- 管理画面からのサーバー側の鍵生成・ローテーション開始。検証済みの relying party に限った自動ローテーション。
- 独立した管理画面と API。パスキーまたは Cloudflare Access による排他的な管理者認証と共通 RBAC。
- Zod による管理入力・設定・D1 読取結果の実行時検証。

### 対象外

- 人間のログイン、同意画面、認可コード、ユーザー情報、ユーザーセッション、パスワード管理。
- 初期版での OpenID Federation 1.1 エンティティステートメント、トラストアンカー、信頼チェーン。
- issuer 内部の AWS/GCP/Azure SDK や、プロバイダーの API ごとのクレデンシャル交換処理。
- 公開の汎用トークン発行 API、caller の自己登録、任意の `sub`/`aud`/TTL 指定。
- JWT の失効リストを全 relying party へ強制する機能。短命 JWT と relying party の信頼設定を前提にし、緊急停止の限界を運用要件で扱う。

## 4. 機能要件

### FR-01 caller の登録と権限

認可された管理者は専用の管理画面から caller ごとに一意な client ID、固定の `sub`、許可 `aud` 集合を登録・変更・無効化できること。登録情報の正本は環境ごとの Policy D1 とする。`sub` は一度割り当てたら別サービスへ再利用しない。1 caller が複数の relying party を持つ場合、許可 `aud` は複数登録できるが、発行する JWT の `aud` は原則 1 値とする。管理 API は認証前に必要な限定経路を除き、Admin Worker の全ルートで管理者認証と RBAC を必須にし、外部向けの自己登録 API は設けない。

登録情報と relying party の IAM/フェデレーション設定は別の設定である。**issuer 側に必要なのは caller ごとの許可 audience であり、プロバイダーの API ごとのコネクタ設定ではない。** relying party には信頼する issuer、`aud`、`sub`、権限を設定する必要がある。設定単位は relying party の信頼ドメイン・ロール・プロバイダーに従い、HTTP リクエストごとに設定を作るものではない。

### FR-02 `ctx.props` による caller 認証

caller の Wrangler Service Binding 設定には、発行専用 named entrypoint と固定の `props: { "clientId": "..." }` を定義する。issuer は RPC entrypoint の `this.ctx.props.clientId` だけから client ID を取得する。RPC の引数、HTTP header、JWT クレームから caller ID を受け取らない。`clientId` が欠落、不正形式、未登録、無効の場合は拒否する。issuer は登録情報から固定 `sub` と許可 `aud` を引く。

`props` は秘密値でも Worker の自動的な身元証明でもなく、Binding に設定された認可コンテキストである。Service Binding の対象 Worker は同一 Cloudflare account に属するが、**アカウントに所属することと Worker を編集・デプロイできることは異なる**。アカウント外の主体を排除できても、信頼しない主体が発行用 Binding と任意の `clientId` を設定できるなら caller 間のなりすましは防げない。中央 CI は必須ではない。組織が許可する管理者・CI token・Worker 編集者の実効権限を棚卸しし、`clientId` を変更できる主体をその client の信頼境界に含める。別 client としての発行を許さない主体がいる場合は、デプロイ権限・Binding 設定経路の分離が実証できるまで発行を有効にしない。Cloudflare の文書には `props` の設定権限の説明と、caller 側で Binding を設定する説明があるため、利用する権限構成での実際の拒否動作を実機試験で確かめる。`ctx.exports` の loopback binding は呼び出し側が `props` を動的に指定できるので、公開 HTTP handler から発行 entrypoint を loopback で呼ばず、RPC stub を信頼できないコードに渡さない。[Cloudflare Context: props と loopback](https://developers.cloudflare.com/workers/runtime-apis/context/)、[Workers の権限](https://developers.cloudflare.com/workers/authorization/workers/)、[Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)

### FR-03 発行ポリシー

発行 API の入力は希望 `aud` と任意の追跡用リクエスト ID に限定する。issuer が `ctx.props.clientId` に紐づく登録情報から `sub` を決め、`aud` の完全一致許可を検査し、TTL と署名鍵を決める。任意のクレーム、`sub`、署名アルゴリズム、`kid`、有効期限の入力は受け付けない。無効 client、未許可 `aud`、登録不整合は発行しない。

### FR-04 発行 JWT

署名アルゴリズムは**RS256 を必須の既定値**とし、**ES256 は relying party での実機検証後に audience 単位で有効化可能**とする。鍵は RS256 なら RSA 2048 bit 以上とし、実装は RSA 鍵を 3072 bit に固定する。ES256 なら P-256 とする。JOSE header に選択した `alg` と一意の `kid` を含め、`none`、対称鍵アルゴリズム、未登録 `kid`、`kid` と鍵種別・アルゴリズムの不一致を許容しない。caller は `alg` を選べず、issuer の audience policy が選ぶ。payload は以下を必須とする。[署名アルゴリズムと鍵ライフサイクル](./key-management.md) を参照する。

| クレーム | 値                                                        |
| -------- | --------------------------------------------------------- |
| `iss`    | 環境ごとに固定された HTTPS issuer URL。完全一致で比較する |
| `sub`    | issuer が登録情報から決定する不変のサービス ID            |
| `aud`    | issuer が許可した relying party 1 つ                      |
| `iat`    | 発行時刻の NumericDate                                    |
| `nbf`    | 利用開始時刻の NumericDate                                |
| `exp`    | 失効時刻の NumericDate                                    |
| `jti`    | 発行ごとに一意なランダム ID                               |

有効期間は初期設計値 **5 分以内**とし、relying party の要件に合わせて短縮可能にする。長い有効期間を caller に指定させない。`azp` は AWS の `aud` 判定に影響するため、初期版では発行しない。個人情報、機密データ、権限を暗示する未管理のクレームは含めない。JWT は bearer credential であり、取得後の転送経路とログでも秘匿する。[AWS の `azp`/`aud` の扱い](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)

### FR-05 公開メタデータと鍵

`GET /.well-known/openid-configuration` と `GET /jwks.json` を公開 HTTPS で配信する。`issuer` は JWT の `iss` と完全一致し、`jwks_uri` は同じ運用主体の HTTPS URL とする。JWKS には公開鍵のみを含め、秘密鍵・対称鍵・内部登録情報を出さない。メタデータに掲載するアルゴリズムとクレームは実装事実に一致させる。複数アルゴリズムを掲載する際は、対象の relying party が混合 JWKS を処理できることを検証する。

**標準適合性の留保:** 公開メタデータの `response_types_supported: ["id_token"]` は AWS IAM 向けの互換性項目であり、認可フローや ID Token を提供するものではない。OIDC Discovery の必須項目を満たさず、完全な OP メタデータを要求する relying party には対応しない。AWS を含む各プロバイダーへの対応は、実際に必要な項目と交換を検証するまで未確認とする。[AWS 必須フィールド](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)、[OIDC Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html)

### FR-06 relying party での利用

issuer は relying party の種類を知らない。caller または別の小さなアダプタが、JWT を AWS STS `AssumeRoleWithWebIdentity`、Google Cloud Workload Identity Federation、Claude API Workload Identity Federation、OpenAI API Workload Identity Federation 等へ渡す。交換手順と必要な relying party 側の ID はプロバイダーごとに異なり、issuer の署名 JWT をそのまま各 API の bearer credential として使わない。独自 API は JWT の署名・`iss`・単一 `aud`・許可 `sub`・時刻・許可アルゴリズムを検証する。relying party 側で権限を最小化し、トークンの発行だけをアクセス許可とみなさない。[プロバイダーの実機検証計画](./provider-validation.md) を参照する。

独自 API に直接 bearer として提示する方式は、クラウドの交換用アサーションと受理・検証規則が異なる。直接 API 用のプロファイルを別途定義し、audience を共有しない。必要なら [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html) の JWT access token profile を採用する。トークン種別を混同させないため、少なくとも厳密な `aud` と用途別検証規則を必須にする。[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)

### FR-07 エラーと可観測性

発行失敗は caller に分類可能なエラーコードを返す。ただし未知 client などの詳細を公開しない。ログ・トレースには時刻、内部 request ID、client ID、`aud` の識別子、結果、遅延、鍵 ID を残し、JWT 本文、issuer 秘密鍵、交換後のクラウド資格情報を残さない。トークン発行数、拒否数、メタデータ/JWKS のエラー率、鍵ローテーション状態を監視する。観測データの保存期間は運用者が定める。

### FR-08 管理画面、認証、監査

管理画面は caller、audience、grant の一覧・検索・作成・更新・無効化、Service Binding 設定案内、鍵状態とローテーション作業記録、管理者と認証情報、監査ログを提供する。AWS・Google Cloud・Claude API・OpenAI API 向けの独立した relying party 設定チェックリストは廃止し、実装していない。relying party の確認は audience ごとに記録する。Admin Worker は公開 issuer Worker と分離し、署名秘密鍵を保持しない。[管理画面・認証・運用要件](./admin-console.md) を参照する。

本番の管理者認証は **passkey** または **Cloudflare Access** の排他的な 1 モードを設定で選ぶ。認証アダプタは共通の operator 主体を返し、権限判定はアダプタの外で統一する。Access を通過しただけの人や最初の訪問者を自動管理者にしない。初期管理者はデプロイ権限に紐づく bootstrap 手順で登録する。管理操作は変更前後の非機密差分と actor を監査する。ポリシー変更監査は Policy D1、管理者操作監査は Admin D1 に記録する。

issuer は発行時に Policy D1 主系のポリシーを読み、client 停止や grant 解除を次の発行に反映する。Admin D1 に管理者・パスキー・セッションを分離し、issuer に Admin D1 Binding を与えない。ポリシー変更は更新と監査イベントを Policy D1 の同じ transaction に記録し、競合更新を拒否する。管理 API 入力、`ctx.props`、環境設定、DB 行は Zod で境界検証し、未知フィールドや不正な組み合わせを拒否する。

### FR-09 管理画面からの鍵生成と自動ローテーション

`security-admin` は管理画面で許可されたアルゴリズムの新鍵生成、ローテーションの計画・承認・開始・停止、進捗・失敗の確認ができること。管理画面と Admin Worker に秘密鍵や Cloudflare の Worker 更新 token を渡さない。独立した Rotation Controller がサーバー側で鍵を生成して issuer Worker secret に登録し、公開 JWK と鍵状態を Admin Worker が書けない Key Registry D1 に記録する。issuer は Key Registry D1 の主系を読み、JWKS と発行の鍵選択に使う。秘密鍵はどの D1 にも保存しない。[Rotation Controller](./rotation-controller.md) を参照する。

定期ローテーションは既定で無効とし、対象 relying party の JWKS キャッシュ、混合鍵の受理、交換成功を実機で確認した場合だけ有効にできる。自動実行も新鍵の先行公開、全 Worker version への secret デプロイ、待機、切替、旧鍵廃止の各ゲートを省略しない。観測値が不足すれば旧鍵で発行を続け、ジョブを停止・通知する。

管理者は対象アルゴリズムごとに移行期間を定める。新鍵の公開後から旧鍵の廃止まで、JWKS には旧・新の公開鍵を併記する。切替前の新規発行は旧鍵、切替後は新鍵だけを使い、旧鍵の最終発行 JWT が失効するまで旧公開鍵を保持する。移行期間の下限と延期時の扱いは[鍵ライフサイクル](./key-management.md#公開鍵の移行期間)に従う。

## 5. セキュリティ要件

- **SR-01 信頼境界:** 公開 HTTP ハンドラから発行処理を呼び出せないこと。発行専用 RPC entrypoint では `this.ctx.props.clientId` を唯一の caller 識別情報とし、引数からのなりすましを拒否する。公開 handler からの loopback 呼び出しも行わない。
- **SR-02 権限分離:** `props` と発行 Binding の設定・変更権限を、issuer 管理者が認めた主体に限定する。中央 CI は一つの実現方法に過ぎない。アカウント管理者、Worker ごとの編集者、API token の実効権限を含めて確認し、信頼しない主体が別 client の `props.clientId` をデプロイできる環境では発行を有効にしない。生成時に Controller が秘密鍵を Cloudflare API に投入した後は、issuer のみがその鍵を実行時に使用できる設定にし、開発・ステージング・本番で鍵を共有しない。
- **SR-03 鍵保護:** issuer 署名秘密鍵は Cloudflare Worker secret または同等の secret binding から実行時に読み込み、ソース、`wrangler` 設定、Workflow 永続状態、D1、ログ、テスト fixture に実鍵を置かない。鍵形式と Web Crypto 互換性は実装時に検証する。
- **SR-04 ポリシー完全一致:** `sub` は固定、`aud` は完全一致。ワイルドカードや URL 前方一致を既定で許可しない。relying party も `iss`、`aud`、`sub`、署名、期限を検証する。
- **SR-05 大量発行:** client ごとのレート制限を設ける。公開鍵取得へのレート制限は正規の relying party の取得を妨げないよう設計する。`ctx.props` を使う RPC 呼び出しには client assertion の再送ストアを設けない。発行 JWT の `jti` は各トークンの識別子であり、単独で bearer JWT の再利用を防ぐものではない。
- **SR-06 鍵ローテーション:** 新公開鍵を先に JWKS に載せ、relying party が新鍵を取得可能になってから署名鍵を切り替え、旧鍵で発行した最終 JWT の失効と許容時刻ずれを待ってから旧鍵を除く。新鍵への切替前に待つ時間は、relying party ごとの JWKS キャッシュ・再取得動作を確認して決める。緊急漏えい時は通常手順を短縮し、relying party 側のロール/信頼も停止できる手順を持つ。詳細は [署名アルゴリズムと鍵ライフサイクル](./key-management.md) を参照する。
- **SR-07 失効の限界:** 署名済み bearer JWT は発行後に即時回収できない。client を止めても既発行 JWT と、交換済みのクラウド一時資格情報はそれぞれの失効まで使える可能性がある。緊急停止では relying party 側の信頼・権限・セッションも扱う。
- **SR-08 サプライチェーン:** 依存ライブラリの固定、ライセンス確認、脆弱性更新、CI の秘密情報検査をベータ版のゲートとする。
- **SR-09 管理面:** Admin Worker の API は認証前に必要な限定経路を除き認証し、passkey/Access の認証結果に対してローカル RBAC を適用する。パスキーモードの SPA shell/asset に管理データを含めず、Access モードではホスト全体を Access で保護する。Admin Worker に署名秘密鍵や発行 RPC を結び付けない。cookie を使う変更経路は CSRF、セッション固定、XSS に対処する。
- **SR-10 管理者復旧:** 最初の管理者登録はデプロイ権限に紐づく手順に限る。最後の有効な `security-admin` の削除や自己昇格を拒否し、パスキー喪失時の復旧は監査付き CLI 手順を持つ。
- **SR-11 ローテーション権限:** Admin Worker は鍵材・Cloudflare API token・Key Registry D1 Binding を持たない。Controller は対象 issuer Worker と操作を固定し、二重実行、未検証の relying party、デプロイ競合、不整合状態で切替を拒否する。token 漏えい時の停止・失効手順を持つ。

## 6. 非機能・運用要件

- **NFR-01 可用性:** 発行経路、client 登録情報、公開メタデータ、JWKS の障害を別々に監視する。発行経路の障害時は fail closed とする。具体的な SLO と容量は実測を踏まえて運用者が決定する。
- **NFR-02 性能:** 署名、登録情報の参照、Service Binding の往復とクラウド交換を分けて計測する。数値目標は計測後に設定する。
- **NFR-03 時刻:** issuer と relying party の時計ずれを考慮し、`iat`/`nbf`/`exp` に明確な許容幅を設ける。発行期間を延ばしてずれを隠さない。
- **NFR-04 キャッシュ:** JWKS/メタデータの Cache-Control とrelying party の実際の更新頻度をローテーション計画に織り込む。特に AWS API Gateway の JWT authorizer は公開鍵を最大 2 時間キャッシュし得る。[AWS ドキュメント](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
- **NFR-05 変更管理:** Service Binding の `props`、client 登録、許可 `aud`、署名鍵、公開メタデータの変更はレビュー可能な手順と監査記録を持つこと。署名鍵を廃止した後は旧鍵だけを持つ Worker 版へロールバックせず、新しい版への roll forward で回復する。audience のアルゴリズムを戻す場合は旧アルゴリズムの有効鍵を保持している期間に限る。
- **NFR-06 ポータビリティ:** OSS コアは特定の Cloudflare account ID、AWS account ID、組織の内部設定に依存しない。Cloudflare Worker/Service Binding 実装はアダプタとして明示する。
- **NFR-07 管理データ:** D1 のバックアップ、スキーマ移行、監査ログの保持期間、管理者復旧手順を運用開始前に決める。認可ポリシーの読取失敗時は新規発行を拒否する。

## 7. relying party ごとの設定責任

| 場所            | 必要な設定                                                                                                         | 単位                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| issuer          | client ID、固定 `sub`、許可 `aud`                                                                                  | caller ごと。relying party を増やす時に許可 `aud` を追加                                  |
| caller          | 発行専用 Service Binding、その `props.clientId`、要求する `aud`                                                    | Worker ごと。`props` の変更はデプロイ権限で制御                                           |
| 独自 API        | issuer/JWKS、許可 `aud` と `sub`、認可規則                                                                         | API の信頼境界ごと                                                                        |
| AWS             | IAM OIDC provider、audience、`sub`/`aud` に絞った IAM role trust policy、最小権限 policy                           | AWS account/role ごと                                                                     |
| Google Cloud    | Workload Identity Pool/Provider、audience、属性マッピング・条件、権限付与                                          | pool/provider と対象リソースごと                                                          |
| Claude API      | federation issuer、`aud`/`sub` 等で絞る federation rule、service account、workspace と scope                       | Anthropic organization/workspace と利用主体ごと                                           |
| OpenAI API      | Workload Identity Provider、期待 `aud`、`sub` 等に一致する service account mapping、project/service account の権限 | OpenAI organization/project と利用主体ごと。任意の OIDC issuer のサポート可否を実機で確認 |
| Microsoft Entra | federated identity credential の issuer/subject/audience と対象 identity の権限                                    | app または managed identity ごと                                                          |

この設定は「すべての relying party の URL を issuer に列挙する」ことを意味しない。relying party 側の信頼設定は現実に必要で、運用者がその relying party に対して一度作り、権限変更に応じて更新する。

## 8. OSS 公開要件

サンプルは `example.com` と架空 ID のみを用いる。本番ドメインは設計例として記述してよいが、実アカウント番号、ロール ARN、プロジェクト番号、秘密鍵、トークン、内部ネットワーク情報をコミットしない。デプロイ設定のサンプルと実設定を明確に分離する。**ベータ版は AWS、Google Cloud、Claude API、OpenAI API の実機検証を終えてから出す**。失敗・プロバイダーの未対応も結果として記録し、成功した対象だけをサポート表へ載せる。README でサポート済みのプロバイダーと非対応のプロバイダーを明確に分ける。ベータ版のゲートの全項目は [リリース状況](../reference/release-status.md) を唯一の正本とする。

## 9. 未決事項・決定ゲート

1. **OIDC 互換性:** AWS 等が求める discovery フィールドを、実際の能力に忠実な形で提供できるか。できなければ対応範囲を縮小するか、必要な OIDC 機能を実装する。
2. **発行 API 形式:** Cloudflare named RPC entrypoint を第一候補とする。公開 fetch handler との到達分離を実環境で検証する。
3. **`ctx.props` 権限境界:** アカウント内の管理者・Worker 編集者・CI/API token がどの Binding と `props` を変更できるかを実環境で検証する。全変更主体を信頼できる単一管理境界に置くなら中央 CI は必須ではない。信頼しない主体に別 caller の client ID をデプロイさせない権限分離が実証できなければ、その主体への発行権限を与えない。
4. **管理データ:** Policy D1 と Admin D1 を分離し、前者を caller/audience/grant の正本とする。スキーマ移行、バックアップ、障害時復旧、変更監査、最短の停止反映を実装時に検証する。認可情報を caller の RPC 引数へ移さない。
5. **鍵保管:** 鍵ごとの Worker secret binding を初期版の基準とし、Secrets Store や外部 KMS は運用要件と実測に基づき選択する。Cloudflare Worker secret の変更が新バージョンのデプロイを伴うことをローテーション手順に含める。
6. **検証対象:** AWS、Google Cloud、Claude API、OpenAI API を実機で評価する。OpenAI API の Workload Identity Provider と service account mapping を設定し、本 issuer の利用可否を確認する。各対象の試験完了後、成功したものだけをサポート表へ追加する。
7. **命名・運用値:** ステージング issuer、client ID 規則、`sub` 命名規則、レート制限、ログ保存、SLO は運用者が決める。実装の公開版は設定可能とする。
8. **ベータ版の体制:** 脆弱性窓口、保守者、リリース手順をベータ版の前に確定する。
9. **認証のデプロイ選択:** 各環境で passkey または Cloudflare Access のどちらを使うか、公開ホストの管理 base path、Access team domain/application AUD、パスキー RP ID を運用者が設定する。Access の step-up を使う場合だけ、別 origin も設定する。暗黙の本番フォールバックは設けない。
10. **自動鍵ローテーション:** Cloudflare API の secret version と deployment 操作、Web Crypto 鍵生成時間、Key Registry の反映、relying party の鍵キャッシュを実測する。実機検証を通らない relying party は管理画面からの手動承認付き切替に限定する。

実装の合否は [受け入れ基準](./acceptance.md) に従う。

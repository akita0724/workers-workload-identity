---
sidebar:
  label: 管理画面
---

# 管理画面・認証・運用要件

**状態:** 実装済み。管理画面は、client・grant・audience の編集と変更内容の確認、停止済み client と未使用 audience の削除、operator のロール変更・停止・削除、Access 主体の連携・解除、パスキーの追加と削除、復旧招待、ページ送り付きの監査検索、audience ごとの relying party の確認、発行の集計、公開状態の監視に対応する。鍵ローテーションの承認・一時停止・再開・自動化・即時ローテーションは [Rotation Controller](./rotation-controller.md)、DB 移行と復旧は [運用ガイド](../guides/operations.md) を参照する。以下の受け入れ基準の一部は、実環境での確認を要する本番の目標である。

## 1. 配置と責務

管理画面と管理 API は**専用の Admin Worker** に置く。パスキーモードでは issuer と同じ公開ホストの `<issuer path>/admin/` を入口とし、issuer Worker が Admin Worker へ中継する。OIDC の discovery/JWKS、発行 RPC、管理 API の責務は混ぜない。issuer と管理画面のルート規則は[公開ホストとルートパス](./domain-routing.md)を正本とする。

Admin Worker は Hono の JSON API と、React と Vite でビルドした SPA を同じ管理 origin・base path から配信する。SPA は画面遷移とデータ取得に TanStack Router と TanStack Query、部品とスタイルに Cloudflare Kumo と Tailwind CSS v4、英語・日本語の文言に i18next、発行のグラフに ECharts を使う。[管理画面のフロントエンド技術選定](./frontend-selection.md) を参照する。ログイン、認証 challenge、初期招待の引換えなど認証前に必要な経路は明示的な allowlist に限定し、レート制限・短い有効期限・一回限りの処理を課す。それ以外の管理 API の全ルートに同じ認証・認可を適用する。パスキーモードの静的 shell/asset には秘密を含めず、Access モードでは管理パス全体を Access で保護する。Admin Worker が発行用秘密鍵や Cloudflare の Worker 更新 token に触れたり、caller の代わりに JWT を発行したりしない。

D1 を環境ごとに **Policy DB**、**Admin DB**、**Key Registry DB** に分ける。Policy DB は client、audience、grant、ポリシー変更監査を保持し、Admin Worker が書き、issuer Worker が発行時に読む。Admin DB は operator、パスキー、challenge、管理セッション、管理者操作監査を保持し、Admin Worker だけに Binding を与える。Key Registry DB は公開 JWK、鍵状態、ローテーション履歴を保持し、Rotation Controller が書き、issuer Worker が読む。Admin Worker は Controller の制限付き RPC 経由で鍵情報を表示する。issuer から管理者の認証情報を読めない構成にする。issuer は発行時に Policy DB の主系から client の有効状態と許可 audience を読む。**停止の反映が必要な認可判定では read replica や期限付きローカルキャッシュを使わない。** Policy DB に障害があれば新規発行を拒否する。D1 の `batch()` は複数文を単一トランザクションとして実行できる。[D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)

## 2. 認証アダプタ

本番の `ADMIN_AUTH_MODE` は `passkey` または `cloudflare-access` の**どちらか一つ**とする。Admin Worker は起動時ではなくリクエストごとに設定を Zod で検証する（`adminConfig()`）。値が未設定または形式不正の場合（未知の `ADMIN_AUTH_MODE`、`https://` URL でない `ADMIN_ORIGIN`、32 文字未満の `CSRF_SECRET`、未設定の `RP_ID`、未設定の `ACCESS_*` の値など）はスキーマ検証に失敗し、すべてのリクエストが HTTP 400 とエラーコード `invalid-input` で失敗する。形式は正しいが互いに矛盾する設定（オリジンだけでない `ADMIN_ORIGIN`、`ADMIN_ORIGIN` のホスト名と一致しない `RP_ID`、パスキーモードでの Access 設定や Access モードでの `RP_ID`、本体と同じ step-up オリジンまたは AUD）では、すべてのリクエストが HTTP 503 とエラーコード `unavailable` で失敗する。Worker が読まない設定は無視される。Access モードでパスキーの認証・登録 API を公開せず、パスキーモードでは Access header を認証として扱わない。開発環境への切替を本番設定の暗黙フォールバックにしない。

両アダプタは認証済み主体を同じ形に正規化する。

```ts
type AuthenticatedOperator = {
  provider: "passkey" | "cloudflare-access";
  providerSubject: string;
  operatorId: string;
  authenticatedAt: number;
};

interface AdminAuthProvider {
  authenticate(request: Request): Promise<AuthenticatedOperator | null>;
  registerRoutes(app: AdminApp): void;
}
```

これはインターフェースの概念図であり、実装時の型名は変更可能。アダプタは本人確認までを担当し、**ローカルの operator レコードの有効状態・ロールを共通の認可層が毎回確認**する。メールアドレスや表示名は識別子・権限の根拠にしない。認証方式変更時のアカウント連結は自動的に行わず、既存の security admin による明示的な移行と監査を必要とする。

### パスキーモード

- WebAuthn の登録・認証には `@simplewebauthn/server` と `@simplewebauthn/browser` を使う。独自の WebAuthn 暗号処理は書かない。[SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server)
- `rpID` は issuer と管理画面が共有する正確な公開ホスト名、`expectedOrigin` はその HTTPS origin に固定する。issuer の discovery/JWKS 経路では WebAuthn を処理せず、管理用 API 以外へ認証情報を送らない。
- 登録・認証 challenge は乱数から生成し、D1 に短時間・一回限りで保存する。challenge、origin、RP ID、user verification、署名、credential ID をサーバーで検証する。`userVerification: "required"` とし、登録時の attestation 要求は初期版では設けない。
- credential 公開鍵、ID、sign counter、作成/最終利用時刻、利用者との紐付けを保存する。同期パスキーでは counter が 0 の場合があるため、それのみで誤って排除しない。operator 1 人が登録できるパスキーは最大 10 個である。
- 認証後は高エントロピーの不透明なセッション ID を発行し、D1 にはハッシュを保存する。cookie は `Secure`、`HttpOnly`、`SameSite=Lax` またはより厳格な設定とし、セッション固定を防ぐためログインで再発行する。セッションは 8 時間で失効する。失効・ログアウトをサーバーで反映する。
- 認証前のパスキー経路は、クライアント IP アドレスごとに毎分 20 リクエストまでに制限する。
- 初期管理者は「最初の訪問者」を自動昇格させない。デプロイ権限を持つ運用者の CLI/bootstrap 手順で一回限りの招待を作り、短い期限でパスキーを登録する。紛失時は別 security admin による再登録、全員が失った場合は監査付き CLI の復旧手順を使う。メールによる無条件の救済経路は設けない。

### Cloudflare Access モード

- 公開ホストの**管理パス全体**（`<issuer path>/admin/*`）を Cloudflare Access application で保護する。discovery と JWKS は公開のままにし、管理画面、管理 API、静的アセット、補助ルートに Access を適用する。production では未保護の `workers.dev` 等の別経路を閉じるか、少なくともアプリ内 JWT 検証によって同じ拒否を保証する。
- 各管理リクエストで `Cf-Access-Jwt-Assertion` の署名を Access 公開鍵で検証し、設定済み team domain の `iss` と application AUD tag、`exp`/`nbf`、`type=app`、空でない人間の `sub` を確認する。Cloudflare Access の service token は人間の管理画面ログインとして受け付けない。header の存在だけで認証成功にしない。[Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[token クレーム](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- `providerSubject` は検証済み Access の `iss` + `sub` に固定し、ローカル operator に明示的に紐付ける。Access を通過しただけで管理者を自動作成しない。Access group のロール同期は初期版で行わず、ローカル RBAC を権限の根拠にする。
- Access モードでは管理アプリ独自のログインセッションを本人確認の根拠にしない。毎回の Access JWT 検証とローカル operator 確認を行う。Access 鍵更新は公開鍵の再取得で追随し、取得障害で有効性を確認できない場合は fail closed にする。

#### 高影響操作の Access 再認証

次の 9 つの高影響操作には、通常の管理用 Access application と別の **step-up Access application** を使う: `operator.create`、`operator.update`、`operator.delete`、`operator.recover`、`rotation.plan`、`rotation.approve`、`rotation.control`、`rotation.schedule`、`rotation.immediate`。後者は `ACCESS_STEP_UP_ORIGIN` に指定する**別の HTTPS ホスト**全体を保護し、通常の管理ホストと同じ Admin Worker へルーティングする。両ホストの Access cookie と AUD tag を分離する。step-up application には通常の管理用 application と同じ人間の利用者条件またはさらに厳しい条件を設定する。Worker は通常ホスト上の通常経路と、step-up ホスト上の `GET /api/access-step-up/complete` だけを受け付け、ホストを取り違えた要求を拒否する。[Access authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)

step-up application には Cloudflare Access の独立 MFA を必須とし、MFA authentication duration を **Require every login**、application と policy の session duration を **5 分以下**にする。Cloudflare One Client 認証による session duration の上書きを無効にし、Bypass と Service Auth policy を置かない。通常の管理 application の Access JWT と step-up application の JWT は `ACCESS_AUD` と `ACCESS_STEP_UP_AUD` で区別し、両値の一致や欠落を設定エラーとする。`ACCESS_STEP_UP_ORIGIN` も必須で、通常の `ADMIN_ORIGIN` と一致させない。Access JWT の `iat` は MFA 自体を証明しない。Worker は step-up application の署名済み JWT が 5 分以内に発行されたことを確認し、MFA 実施は step-up application のポリシーに依存する。[MFA の再認証設定](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)、[session duration](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

操作時は通常の Access 認証・ローカル RBAC・Origin/CSRF 確認の下で、操作種別、operator ID、Access `iss`+`sub` に紐付く 2 分の challenge を Admin D1 に作る。管理画面が別ウィンドウで step-up ホストを開き、step-up AUD の JWT、同じ Access 主体に紐付く有効な operator、操作権限、JWT 発行時刻を Worker が検証して challenge を完了する。元画面は通常ホストの API で完了状態を確認し、challenge ID を高影響 POST に渡す。Worker は操作種別・operator・Access 主体・期限・完了状態を照合して**原子的に一度だけ消費**する。別操作・別管理者・期限切れ・再利用・通常 AUD の JWT を拒否する。step-up の失敗や設定不備では高影響 POST を拒否する。通常の管理 API や静的画面は通常の Access application で保護し、step-up JWT だけでは利用できない。操作本体が一時的に失敗しても challenge は消費済みとなるため、再試行には新たな step-up 確認が必要になる。

本番導入時は、(1) Admin D1 のマイグレーション `0002_access_step_up.sql`、`0004_step_up_actions.sql`、`0005_rename_immediate_rotation.sql` を適用、(2) 管理ホストと step-up ホストを同じ Worker に割り当て、未保護の別経路を閉じる、(3) 各ホストに上記の別々の Access application とポリシーを設定、(4) `ADMIN_ORIGIN`、`ACCESS_STEP_UP_ORIGIN`、両 AUD を Worker に設定する、の順に進める。両ホストの Access 認証、MFA 画面、各高影響操作、challenge 再利用の拒否を実環境で確認するまでは本番の高影響操作を有効と判定しない。ステージングの `workers.dev` デプロイ手順はパスキーモード専用で、この Access 設定は作成しない。

## 3. 認可と初期管理者

| ロール           | 閲覧 | client/audience/grant 変更 | client 緊急停止 | operator 管理・認証移行 | 鍵ローテーションの承認 |
| ---------------- | ---- | -------------------------- | --------------- | ----------------------- | ---------------------- |
| `viewer`         | 可   | 不可                       | 不可            | 不可                    | 不可                   |
| `operator`       | 可   | 可                         | 可              | 不可                    | 提案まで               |
| `security-admin` | 可   | 可                         | 可              | 可                      | 可                     |

初期の `security-admin` はデプロイ権限に紐づく CLI/bootstrap で登録する。Access モードでは Access の `iss` + `sub`、パスキーモードでは招待経由の operator ID を紐付ける。公開の「最初のユーザーを管理者にする」画面は設けない。最後の有効な `security-admin` の停止・削除は禁止する。権限変更や管理者追加は自己昇格を禁止し、変更者と対象者を監査ログへ残す。

`operator` が作った変更も認可の本体はサーバー側で検査する。ボタンの非表示だけに依存しない。上記の 9 つの高影響操作では、パスキーモードは 5 分以内の認証時刻、Access モードは上記の step-up challenge をサーバー側で要求する。パスキーの追加・削除にも 5 分以内の認証を要求する。実行前には対象と変更内容を画面で確認する。

## 4. 管理画面と操作

| 画面                     | 必要な表示・操作                                                                                                                                                                                                                                                                                                                                          | 初期版の範囲                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ダッシュボード           | 直近 24 時間の発行成功数と可用性、discovery と JWKS の最新の監視結果（古い場合はその旨を表示）と再確認ボタン（`viewer` には表示しない）、直近 24 時間の 1 時間ごとの発行リクエスト、最新 5 件の監査イベント、セットアップ完了までのチェックリスト（audience、現用の署名鍵、client と grant）。現用の `kid` とローテーションの状態は署名鍵の画面に表示する | 必須                                                                  |
| caller 一覧・詳細        | client ID、固定 `sub`、有効状態、許可 audience、作成・更新日時、検索/絞り込み                                                                                                                                                                                                                                                                             | 必須                                                                  |
| caller 作成・変更        | `sub` の一意性確認、許可 audience の選択、変更差分確認、無効化・再有効化。`sub` は発行後に変更不可                                                                                                                                                                                                                                                        | 必須                                                                  |
| Service Binding 設定案内 | `props.clientId` を含む Wrangler 設定例、発行 entrypoint 名、account 内の管理者・Worker 編集者・API token の権限確認、構成確認の手順                                                                                                                                                                                                                      | 必須。中央 CI を前提にせず、Binding の遠隔変更は行わない              |
| audience 一覧・詳細      | 正確な `aud`、用途、relying party の種別、選択アルゴリズム、TTL、利用中 caller、JWKS キャッシュ上限                                                                                                                                                                                                                                                       | 必須                                                                  |
| audience 作成・変更      | 完全一致値、RS256/ES256 選択、TTL 上限、既存 grant への影響表示。grant が残っていない場合に削除可能                                                                                                                                                                                                                                                                             | 必須                                                                  |
| grant 変更               | caller と audience の許可関係の追加・解除、影響範囲と反映時刻の表示                                                                                                                                                                                                                                                                                       | 必須                                                                  |
| 緊急停止                 | caller を即時無効化、既発行 JWT/交換済み資格情報が残る注意表示、監査記録                                                                                                                                                                                                                                                                                  | 必須                                                                  |
| 署名鍵                   | `kid`、`alg`、公開 JWK/fingerprint、状態、JWKS 掲載、デプロイバージョン、ローテーション手順・ゲート、履歴                                                                                                                                                                                                                                                 | 必須。秘密鍵を画面に表示しない                                        |
| 鍵生成・切替             | 新鍵生成の要求、先行公開期間・旧鍵保持期間の計画、承認、開始・一時停止・再開、各ゲートの証拠と結果                                                                                                                                                                                                                                                        | 必須。サーバー側の Rotation Controller が鍵の生成とアップロードを実行 |
| 自動ローテーション       | 周期、対象アルゴリズム、relying party の互換性とキャッシュ実測、旧・新鍵の同時掲載予定と実績、次回予定、失敗時の停止                                                                                                                                                                                                                                      | 必須。既定は無効、検証済み環境でのみ有効化                            |
| 管理者・パスキー         | operator ロール/停止、パスキーの追加・削除、全鍵削除防止                                                                                                                                                                                                                                                                                                  | パスキーモードで必須                                                  |
| 管理者・Access           | Access `iss` + `sub` と operator の紐付け/解除、ローカルロール/停止                                                                                                                                                                                                                                                                                       | Access モードで必須                                                   |
| 監査ログ                 | ポリシー変更、管理者・パスキー変更、招待/復旧、ログイン成功・失敗の actor または識別可能な発生源、対象、非機密差分、時刻、結果、request ID。検索/期間絞り込み                                                                                                                                                                                             | 必須                                                                  |
| relying party 設定支援   | 廃止。独立したチェックリスト画面とその記録は削除し、`/providers` は audience 一覧へリダイレクトする。relying party の確認（交換、混合 JWKS、ES256、JWKS キャッシュ上限）は audience ごとに記録する                                                                                                                                                        | 未実装。relying party を自動変更せず、未検証と成功を区別する          |

client は停止後に削除でき、紐づく grant と発行回数制限のデータも削除する。audience は grant が残っている間は削除できず、停止中を含む対象ワークロードを画面に表示する。削除前の設定と互換性の確認記録は監査履歴に残す。削除 API、エラー、操作手順は[運用ガイド](../guides/operations.md)を参照する。

管理画面は JWT 本文、issuer 秘密鍵、クラウド一時資格情報を表示・ダウンロードしない。「生成」を押しても、ブラウザーへ返すのは公開鍵と進捗だけであり、秘密鍵の生成とアップロードは Rotation Controller がサーバー側で行う。[Rotation Controller](./rotation-controller.md) を参照する。管理 API は管理画面と同じ認証・認可を必須にし、外部向けの汎用管理 API としては公開しない。将来機械管理 API が必要になれば、人間の認証とは別の明示的な認証方式・権限を設計する。

## 5. データと更新の規則

[`migrations/`](https://github.com/akita0724/workers-workload-identity/tree/main/migrations) のマイグレーションは次のテーブルを作る。

| データベース    | テーブル                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin DB        | `operators`、`operator_identities`、`passkey_credentials`、`webauthn_challenges`、`auth_rate_limits`、`admin_sessions`、`bootstrap_invites`、`admin_audit_events`、`access_step_up_challenges`、`health_checks` |
| Policy DB       | `clients`、`audiences`、`client_audience_grants`、`policy_audit_events`、`issuance_rate_limits`、`issuance_metrics`、`issuance_audit_events`                                                                    |
| Key Registry DB | `signing_keys`、`issuance_reservations`、`rotation_runs`、`rotation_evidence`、`rotation_schedules`、`rotation_proposals`、`rotation_actions`                                                                   |

Access モードではパスキー専用テーブルを使わない。発行鍵の private material はいずれの D1 にも入れない。

管理 API のすべての入力と実行時設定は Zod のスキーマで検証し、`z.strictObject(...)` 等で未知フィールドを拒否する。DB から読み出した行も信頼せず、発行ポリシーに変換する境界で Zod 検証する。TypeScript の型はスキーマから推論し、画面側のバリデーションは補助とする。[Zod 基本操作](https://zod.dev/basics)

client/audience/grant の変更は optimistic concurrency 用 `version` を持ち、更新と監査イベントの追記を Policy DB の同じ D1 transaction で確定する。条件付き更新が 0 行なら監査イベントも書き込まないよう SQL と transaction を構成し、競合は 409 として差分再確認を促す。管理者・パスキー変更の監査は Admin DB で同様に確定し、監査画面では両 DB のイベントを統合表示する。無効化のような権限縮小も issuer の次の発行要求から効くよう、issuer は Policy DB を発行ごとに読み、認可結果を跨リクエストでキャッシュしない。認証・認可・D1・監査書き込みのいずれかが失敗した変更は適用しない。Admin DB と Policy DB の間に分散 transaction はないため、管理者状態とポリシー変更を一括で変更する操作は設けない。

管理 API は cookie 認証に伴う CSRF を考慮し、状態変更メソッドで固定 origin の厳密な検査と CSRF token を使う。Hono の CSRF middleware は `Origin` と `Sec-Fetch-Site` を確認するが、適用対象の content type に制限があるため、JSON API を含む全変更経路は追加の検査で覆う。[Hono CSRF middleware](https://hono.dev/docs/middleware/builtin/csrf)

## 6. 管理画面の受け入れ基準

- 両認証モードで、未認証・認証失敗・未登録・停止済み operator は管理画面と管理 API の全経路を使えない。
- passkey challenge の再利用、誤った origin/RP ID、user verification 不足、別 credential の署名を拒否する。
- Access JWT は署名、`iss`、`aud`、期限、非空の人間 `sub` を検証し、別 Access application の JWT と service token を拒否する。
- Access モードの 9 つの高影響操作は、それぞれ step-up application の MFA を通った2分以内の操作別・operator別challengeがなければ拒否する。通常AUDでの完了、古いstep-up JWT、別のAccess主体・operator・操作への転用、期限切れ、再利用も拒否する。
- viewer/operator/security-admin の権限境界、最後の security-admin 保護、自己昇格防止がサーバー側で成立する。
- 停止した client は次の発行で拒否される。競合更新は失敗し、監査イベントは対応する更新と同じ transaction に残る。
- Policy DB と Admin DB の監査を管理画面で検索でき、各変更の監査書き込み失敗時には対象の変更が確定しない。
- 認証前 allowlist 以外の管理 API に認証・CSRF 保護があり、管理画面に秘密鍵・JWT 本文が出ない。passkey の静的 shell/asset から管理データを得られない。認証前経路にはレート制限と使い捨て challenge/招待を適用する。
- Admin Worker を Access 保護外の別 URL から呼んでも Access モードではアプリ内 JWT 検証が失敗する。
- 鍵生成ボタンから実行ジョブを開始できるが、秘密鍵や Cloudflare API token はブラウザー・Admin Worker・D1 に出ない。失敗したゲートを飛ばして切り替えられず、自動化は検証済み対象だけに有効化できる。

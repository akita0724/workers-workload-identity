---
sidebar:
  label: 管理画面のフロントエンド
---

# 管理画面のフロントエンド技術選定

**状態:** 実装済み。`apps/admin-ui` の管理画面はこの選定に従う。Admin Worker と issuer Worker の分離は維持する。

## 結論

管理画面は **React と Vite の SPA** とし、ナビゲーションに **TanStack Router**、API データとジョブ進捗に **TanStack Query** を使う。部品は **Cloudflare Kumo**、スタイルは **Tailwind CSS v4**、英語・日本語の文言は **i18next**（`react-i18next`）、発行のグラフは **ECharts** を使う。フォームライブラリは使わず、Zod のサーバー側検証を正本にする。**Hono は Admin Worker の JSON API と認証 middleware に残す。** Hono JSX による全画面 SSR は選定から外す。

## 比較

| 案                                           | 合う点                                                                                    | この製品での負担                                                                                                               | 判断                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Hono JSX の SSR + 少量 JS                    | 少数のフォームと一覧なら軽い。API と同じ Worker で完結                                    | grant の影響差分、監査検索、鍵ローテーションの非同期進捗、複数の確認画面を個別のブラウザー JS と状態同期で組み立てる必要がある | 管理画面が小さい場合の代替案                 |
| React SPA + TanStack Router/Query + Hono API | 状態の多い管理画面、一覧、ジョブ進捗に合う。API の信頼境界を明示できる                    | SPA build、クライアント状態、認証失効時のキャッシュ破棄を設計する                                                              | **採用**                                     |
| TanStack Start                               | Router に SSR、server functions、server routes を加え、Workers への公式デプロイ手順がある | 非公開の管理画面に SSR/SEO の利点が小さい。Hono API と server functions の二重境界を作りやすい                                 | SSR やサーバー関数が必要になった場合に再評価 |
| Astro shell + React SPA                      | 既存のコンテンツサイトに管理画面を組み込む場合に合う                                      | この独立した issuer には統合するサイトがなく、Astro の役割が薄い                                                               | 採用しない                                   |

TanStack Start は現在安定版で Cloudflare Workers への公式ガイドがあるため、互換性がないという理由で外すわけではない。TanStack 自身も SSR 等が不要なら Router 単体を選択肢としている。初期版では Hono API を認証・認可の唯一のサーバー境界にする。[TanStack Start の選択基準](https://tanstack.com/start/latest/docs/framework/react/overview)、[Cloudflare Workers ガイド](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)

## 採用構成

```text
apps/
  admin-worker/  Hono JSON API、パスキー/Access アダプタ、RBAC、D1、Rotation Controller RPC
  admin-ui/      React + Vite、TanStack Router/Query、Kumo、Tailwind CSS、i18next、ECharts
packages/
  contracts/     ブラウザーへ公開可能な Zod schema と管理 API 契約
  domain-*/      Worker が使う業務規則。UI は直接参照しない
```

- UI と API は同じ Admin Worker の origin で配信し、credential を伴う API request の CORS 設定を増やさない。Workers Static Assets の SPA fallback を使う。`assets.run_worker_first` と route の順序を明示して、API が HTML fallback を返さず、保護すべき navigation が Worker の認証 middleware を通ることを統合テストで確認する。[Workers SPA 配信](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- 静的 JS/CSS に秘密、operator 情報、ポリシーデータを埋め込まない。パスキーモードのログイン shell と静的 asset は認証前でも配信可能とし、保護データは認証済み API からだけ取得する。Access モードでは公開ホストの管理パス全体を Access application で保護する。いずれも API 側は各 request で認証と RBAC を検証する。
- TanStack Query はクライアントの表示用キャッシュであり、権限判定の正本ではない。caller 停止や鍵状態変更の mutation 後は関連 query を無効化する。ログアウト、operator 停止、認証方式変更、401/403 応答時は全管理キャッシュを破棄する。高影響操作は保存前にサーバーから最新 version と差分を取得する。
- TanStack Router の loader/search params は画面の URL と検索状態を扱う。認証が必要な route のクライアント guard は表示改善であり、API の認可を代替しない。
- caller・audience・監査の一覧では、ページング・検索・権限付き列の正本を API とする。全件をブラウザーへ渡さない。
- Zod schema は API request/response の境界で共有可能なものを `contracts` に置く。ブラウザー側の Zod は入力補助であり、Admin Worker は独立に再検証する。秘密値や内部 DB 行を UI bundle に import しない。

## 受け入れ基準

1. Passkey の登録/認証フローと Access JWT 検証が、SPA navigation、ページ再読込、API fetch、静的 asset の各経路で成立する。
2. 未認証者が SPA shell を受け取れても、caller/鍵/監査データを API、初期 HTML、build asset から得られない。Access モードでは代替 URL からも管理データへ到達できない。
3. 管理操作後の query invalidation、別タブでの operator 停止、ログアウト時のキャッシュ消去、ジョブ進捗の再接続が動作する。
4. `/api/*` への navigation と fetch が SPA fallback に飲まれず JSON/適切な認証エラーを返す。UI deep link の再読込は正しい shell を返す。

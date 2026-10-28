---
sidebar:
  label: リポジトリ構成
---

# リポジトリ構成と依存境界

**状態:** 実装済み。各 Worker のコード、D1 schema、サンプルデプロイ設定、管理画面、caller SDK がある。本番の受け入れとプロバイダーとの互換性の実機検証は未完了である。

## ワークスペース

| Workspace                   | Clean Architecture 上の位置 | 責務                                                                                   |
| --------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `packages/domain-identity`  | Domain                      | caller、subject、audience、grant、発行可否。外部ライブラリなし                         |
| `packages/domain-keys`      | Domain                      | 署名アルゴリズム、鍵状態、JWKS 可視性、現用鍵の一意性。外部ライブラリなし              |
| `packages/domain-operators` | Domain                      | operator、役割、認証モード。外部ライブラリなし                                         |
| `packages/contracts`        | Interface contract          | ブラウザーへ公開可能な Zod DTO。secret、DB 行、Cloudflare binding 型を export しない   |
| `apps/issuer-worker`        | Application + adapters      | 発行ユースケースと port、Service Binding RPC、Hono 公開ルート、D1、JOSE、Worker secret |
| `packages/client`           | Caller SDK                  | 共有契約による RPC クライアントと、デプロイ時の Binding 設定ヘルパー                   |
| `apps/admin-worker`         | Application + adapters      | 管理 API（Hono）、パスキー/Access 認証、RBAC、D1、SPA 配信                             |
| `apps/rotation-worker`      | Application + adapters      | 鍵生成・切替、Cloudflare API、Workflows、Key Registry D1                               |
| `apps/admin-ui`             | Presentation                | React 管理画面。`contracts` のみを workspace 依存に持つ                                |
| `apps/smoke-worker`         | Test application            | 発行 caller とステージング検査 API                                                     |
| `apps/smoke-receiver`       | Test application            | 発行 JWT を検証する独立した relying party の Worker                                    |
| `apps/docs`                 | Documentation               | Blume の設定と依存。本文はルート `docs/`                                               |

`src/application`（ユースケースと port）と `src/adapters`（D1 と署名の実装）に分けているのは `apps/issuer-worker` だけである。issuer の発行ユースケースは port を介して policy、鍵、署名、時刻、ID 生成へ依存する。`apps/admin-worker` と `apps/rotation-worker` はソースファイルを `src/` 直下に平坦に置く。Domain パッケージは Worker のコードを import しない。Worker 間は TypeScript import で結合せず、宣言済み Service Binding RPC 契約を介する。`contracts` は環境依存の内部設定を含めず、管理画面へ安全に bundle できる範囲に限る。

```text
client ──→ contracts
admin-ui ──→ contracts
issuer-worker ──→ domain-identity, domain-keys, contracts
issuer-worker (dev) ──→ client
admin-worker ──→ domain-identity, domain-keys, domain-operators, contracts
rotation-worker ──→ domain-identity, domain-keys, contracts
smoke-worker ──→ client
domain-* ──→ 外部 package なし
```

Turborepo の `boundaries` は未宣言の workspace import と package 外への相対 import を検査し、`domain`・`contract`・`adapter`・`client`・`ui`・`docs` のタグで依存方向を制限する。これは実験的機能なので、型検査とレビューも必要である。pnpm の `workspace:*` は明示した依存だけをリンクする。

## 開発ツール

- Turborepo は package 間のタスク順序とローカルキャッシュを管理する。リモートキャッシュは設定しない。
- Vitest は純粋な domain の単体テストに使う。issuer の runtime 統合テストは `@cloudflare/vitest-plugin` と workerd で実行する。SDK の単体テストと型の拒否条件も検査する。`vitest.workspace` は使わず、複数設定が必要なら現行の `test.projects` を用いる。
- Oxc は Oxlint と Oxfmt を使用する。Oxc の変換器を実行時の認証・署名実装には入れない。型の検査は TypeScript、Workers の動作は workerd が担う。
- 直接依存の大半は、2026-10-24 に registry の `latest` を確認した正確なバージョンで固定している。`apps/admin-ui` は UI ライブラリ（Kumo、Tailwind CSS、i18next、ECharts など）とテストツールにキャレット（`^`）範囲を使い、インストールされるバージョンは `pnpm-lock.yaml` で固定される。ベータ版の前に依存ライセンス、脆弱性、runtime 互換性を再評価する。

実行例: `pnpm boundaries`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm docs:validate`、`pnpm docs:build`。

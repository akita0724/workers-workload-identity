---
title: 公開ホストとルートパス
description: issuer、管理画面、ドキュメントのホストとパス境界を設定する
sidebar:
  order: 12
---

**状態:** パスキーモードで実装済み。単一ホストでの Cloudflare Access の step-up は未実装である。

issuer とパスキーモードの管理画面は同じホストで配信する。issuer は `ISSUER_URL`、管理画面はその URL に `/admin/` を追加した場所に置く。発行 RPC と Rotation Controller の責務は分離する。

ステージングの設定時に公開 URL を指定する。例: `pnpm staging:configure --account-id <id> --workers-subdomain <subdomain> --public-url https://identity.example.com/team`。末尾スラッシュは付けない。独自ホストには Cloudflare の active zone が必要である。指定しない場合は issuer の workers.dev ホストを使う。

この例では discovery は `/team/.well-known/openid-configuration`、JWKS は `/team/jwks.json`、管理画面は `/team/admin/` になる。relying party にはパスを含む issuer URL 全体を登録する。既存の issuer URL を変更するには、relying party の信頼設定の移行が必要である。

issuer は、origin が `ISSUER_URL` の origin と異なるリクエストと、issuer URL のパスの外にあるパスへのリクエストに 404 を返す。

ドキュメントは GitHub Pages にだけ公開する。実行環境に `/docs` の配信先や文書 asset を追加しない。

Cloudflare Access モードの step-up は引き続き別 origin を必要とする。単一ホストでの Access step-up は未実装であり、ステージングの自動デプロイはパスキーモードを使う。

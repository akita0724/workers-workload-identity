import { t, useLocale, locale } from "../i18n";
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightIcon as ArrowRight,
  CheckIcon as Check,
  ArrowsClockwiseIcon as RefreshCw,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { api, date, queryClient, useMe } from "../api";
import { Button } from "@cloudflare/kumo/components/button";
import { Empty, Loading, Notice, Page, Panel, Status, useTask } from "../components/console";

const IssuanceChart = lazy(() => import("../components/issuance-chart"));

type Metric = { minute_bucket: number; outcome: string; count: number };
export type Overview = {
  issuer: string | null;
  counts: { clients: number; enabledClients: number; audiences: number; grants: number };
  health: {
    name: string;
    healthy: number;
    checked_at: number;
    latency_ms: number;
    detail: string;
  }[];
  outcomes: Record<string, number>;
  metrics: Metric[];
  availability: number | null;
  sloTarget: number;
  since: number;
};
export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/overview"),
    refetchInterval: 60_000,
  });
}
export function OverviewPage() {
  useLocale();
  const query = useOverview(),
    me = useMe(),
    task = useTask(),
    data = query.data;
  const activity = useQuery({
    queryKey: ["recent-audit"],
    queryFn: () =>
      api<{ events: { event_id: string; action: string; target: string; occurred_at: number }[] }>(
        "/audit?limit=5",
      ),
  });
  const keys = useQuery({
    queryKey: ["keys"],
    queryFn: () =>
      api<{
        keys: {
          keys: { kid: string; algorithm: string; state: string }[];
          runs: { id: string; state: string }[];
        };
      }>("/keys"),
  });
  const success = data?.outcomes.success ?? 0;
  return (
    <Page
      title={t("概要")}
      action={
        me.data?.role !== "viewer" && (
          <Button
            variant="outline"
            disabled={task.busy}
            onClick={() =>
              void task.run(async () => {
                await api("/health/check", { method: "POST" });
                await queryClient.invalidateQueries({ queryKey: ["overview"] });
              }, t("最新の情報に更新しました"))
            }
          >
            <RefreshCw size={16} className={task.busy ? "spin" : ""} />
            {t("接続を確認")}
          </Button>
        )
      }
      aside={
        data && (
          <>
            <div className="overview-summary" aria-label={t("稼働状況")}>
              <div>
                <span>{t("24時間の発行成功")}</span>
                <strong>
                  {success.toLocaleString(locale())} <small>{t("件", { count: success })}</small>
                </strong>
              </div>
              <div>
                <span>{t("24時間の可用性")}</span>
                <strong>
                  {data.availability === null ? "—" : `${data.availability.toFixed(2)}%`}
                </strong>
              </div>
            </div>
            <Panel title={t("最後の監視結果")}>
              <div className="health-list">
                {["discovery", "jwks"].map((name) => {
                  const h = data.health.find((v) => v.name === name),
                    fresh = !!h && Date.now() - h.checked_at < 15 * 60_000;
                  return (
                    <div className="health-item" key={name}>
                      <div>
                        <h3>{name === "discovery" ? "OpenID metadata" : t("公開鍵 / JWKS")}</h3>
                        <p>
                          {h
                            ? t("{{value1}} ・ {{value2}} ms", {
                                value1: date(h.checked_at),
                                value2: h.latency_ms,
                              })
                            : t("まだ監視結果がありません")}
                        </p>
                      </div>
                      <Status tone={!fresh ? "neutral" : h?.healthy ? "good" : "danger"}>
                        {!fresh
                          ? h
                            ? t("監視結果が古い")
                            : t("未観測")
                          : h?.healthy
                            ? t("正常")
                            : t("要確認")}
                      </Status>
                    </div>
                  );
                })}
              </div>
            </Panel>
            {keys.data &&
              (data.counts.audiences === 0 ||
                data.counts.enabledClients === 0 ||
                data.counts.grants === 0 ||
                !keys.data.keys.keys.some((k) => k.state === "active")) && (
                <Panel title={t("セットアップ")}>
                  <div className="checklist">
                    {[
                      {
                        done: data.counts.audiences > 0,
                        title: t("Audience を登録"),
                        description: t("Audience と署名方式を設定"),
                        to: "/audiences" as const,
                      },
                      {
                        done: !!keys.data?.keys.keys.some((k) => k.state === "active"),
                        title: t("署名鍵を準備"),
                        description: t("公開鍵を配信し、発行鍵を有効化"),
                        to: "/keys" as const,
                      },
                      {
                        done: data.counts.enabledClients > 0 && data.counts.grants > 0,
                        title: t("サービスを接続"),
                        description: t("Service Binding と発行許可を設定"),
                        to: "/clients" as const,
                      },
                    ].map((item) => (
                      <Link className="checklist-item" to={item.to} key={item.title}>
                        <span className={item.done ? "check-step complete" : "check-step"}>
                          {item.done ? <Check size={15} /> : <ArrowRight size={15} />}
                        </span>
                        <div>
                          <strong>{item.title}</strong>
                          <p>{item.description}</p>
                        </div>
                      </Link>
                    ))}
                  </div>
                </Panel>
              )}
          </>
        )
      }
    >
      <Notice error={query.error ?? task.error ?? keys.error} />
      {query.isPending ? (
        <Loading />
      ) : (
        data && (
          <>
            <Panel title={t("発行リクエスト")} description={t("直近24時間・1時間ごと")}>
              <Suspense fallback={<Loading />}>
                <IssuanceChart metrics={data.metrics} since={data.since} />
              </Suspense>
            </Panel>
            <Panel
              title={t("最近の変更")}
              action={
                <Link to="/audit" className="text-link">
                  {t("すべて見る")}
                  <ArrowRight size={14} />
                </Link>
              }
            >
              <Notice error={activity.error} />
              {activity.isPending ? (
                <Loading />
              ) : activity.error ? null : activity.data?.events.length ? (
                <div className="activity-list">
                  {activity.data.events.map((item) => (
                    <div className="activity-item" key={item.event_id}>
                      <div>
                        <strong>{actionName(item.action)}</strong>
                        <p className="breakable">{item.target}</p>
                      </div>
                      <time>{date(item.occurred_at)}</time>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title={t("変更履歴はまだありません")} />
              )}
            </Panel>
          </>
        )
      )}
    </Page>
  );
}
export function actionName(action: string) {
  if (action === "issuance.success") return t("トークンを発行");
  if (action === "issuance.issuance-unavailable") return t("トークン発行に失敗");
  if (action.startsWith("issuance.")) return t("トークン発行を拒否");
  const labels: Record<string, string> = {
    "client.create": t("ワークロードを登録"),
    "client.update": t("ワークロードを更新"),
    "audience.create": t("Audience を登録"),
    "audience.update": t("Audience を更新"),
    "operator.create": t("管理者を招待"),
    "operator.update": t("管理者の権限を更新"),
    "operator.delete": t("管理者を削除"),
    "operator.recover": t("パスキーの復旧を開始"),
    "operator.unlink": t("Access 連携を解除"),
    "passkey.add": t("パスキーを追加"),
    "passkey.delete": t("パスキーを削除"),
    "provider.update": t("relying party の確認記録を更新"),
    "auth.login": t("パスキーでログイン"),
  };
  return labels[action] ?? action;
}

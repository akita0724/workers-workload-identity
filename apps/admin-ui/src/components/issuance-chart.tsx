import { t, useLocale, locale } from "../i18n";
import { useMemo } from "react";
import { TimeseriesChart, type TimeseriesData } from "@cloudflare/kumo/components/chart";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { Table } from "@cloudflare/kumo/components/table";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import {
  AriaComponent,
  BrushComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { Empty, TableScroll } from "./console";

echarts.use([
  BarChart,
  AriaComponent,
  BrushComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
]);
const hour = 3_600_000;
const series = [
  {
    key: "good",
    get name() {
      return t("成功");
    },
    color: "--chart-success",
  },
  {
    key: "denied",
    get name() {
      return t("認可・入力・レート制限の拒否");
    },
    color: "--chart-denied",
  },
  {
    key: "error",
    get name() {
      return t("基盤エラー");
    },
    color: "--chart-error",
  },
] as const;

export default function IssuanceChart({
  metrics,
  since,
}: {
  metrics: { minute_bucket: number; outcome: string; count: number }[];
  since: number;
}) {
  const displayLocale = useLocale();
  const time = new Intl.DateTimeFormat(displayLocale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const bins = useMemo(() => {
    const end = since + 24 * hour;
    const values = Array.from({ length: 24 }, (_, i) => ({
      end: since + (i + 1) * hour,
      good: 0,
      denied: 0,
      error: 0,
    }));
    for (const row of metrics) {
      const index = 23 - Math.floor((end - row.minute_bucket * 60_000) / hour);
      if (index >= 0 && index < values.length) {
        const key =
          row.outcome === "success"
            ? "good"
            : row.outcome === "issuance-unavailable"
              ? "error"
              : "denied";
        values[index][key] += row.count;
      }
    }
    return values;
  }, [metrics, since]);
  const data = useMemo<TimeseriesData[]>(
    () =>
      series.map((s) => ({
        name: s.name,
        color: getComputedStyle(document.documentElement).getPropertyValue(s.color).trim(),
        data: bins.map((b) => [b.end, b[s.key]]),
      })),
    [bins, displayLocale],
  );
  if (!metrics.length)
    return (
      <div className="chart-empty">
        <Empty
          title={t("発行データはまだありません")}
          description={t(
            "ワークロードからの発行リクエストを受け付けると、ここに集計を表示します。",
          )}
        />
      </div>
    );
  return (
    <>
      <div className="chart">
        <TimeseriesChart
          echarts={echarts}
          type="bar"
          data={data}
          height={230}
          yAxisName={t("件数")}
          yAxisMinInterval={1}
          yAxisTickCount={3}
          xAxisTickCount={3}
          xAxisTickFormat={(value) => time.format(value)}
          yAxisTickFormat={(value) => value.toLocaleString(locale())}
          tooltipValueFormat={(value) => t("リクエスト数：{{count}}", { count: value })}
          tooltipTimestampFormat={(value) => `${time.format(value - hour)} / ${time.format(value)}`}
          tooltipFooter={t("1時間ごとの集計")}
          ariaDescription={t(
            "直近24時間の発行成功、拒否、基盤エラーの件数。各時間帯の数値は、下の「集計データを表示」から確認できます。",
          )}
        />
      </div>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.key}>
            <i aria-hidden="true" style={{ background: `var(${s.color})` }} />
            {s.name}
          </span>
        ))}
      </div>
      <Collapsible className="chart-data">
        <Collapsible.DefaultTrigger>{t("集計データを表示")}</Collapsible.DefaultTrigger>
        <Collapsible.Panel>
          <TableScroll>
            <Table className="data-table">
              <caption className="sr-only">{t("発行リクエストの時間別集計")}</caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("時間帯")}</Table.Head>
                  <Table.Head>{t("成功")}</Table.Head>
                  <Table.Head>{t("拒否")}</Table.Head>
                  <Table.Head>{t("基盤エラー")}</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {bins.map((b) => (
                  <Table.Row key={b.end}>
                    <Table.Cell>
                      {time.format(b.end - hour)} / {time.format(b.end)}
                    </Table.Cell>
                    <Table.Cell>{b.good.toLocaleString(locale())}</Table.Cell>
                    <Table.Cell>{b.denied.toLocaleString(locale())}</Table.Cell>
                    <Table.Cell>{b.error.toLocaleString(locale())}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </TableScroll>
        </Collapsible.Panel>
      </Collapsible>
    </>
  );
}

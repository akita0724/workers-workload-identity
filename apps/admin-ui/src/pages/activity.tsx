import { t, useLocale } from "../i18n";
import { Table } from "@cloudflare/kumo/components/table";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
} from "@phosphor-icons/react";
import { api, date } from "../api";
import { Button } from "@cloudflare/kumo/components/button";
import { DateSelect } from "../components/date-select";
import {
  Empty,
  Loading,
  Modal,
  Notice,
  Page,
  Panel,
  SearchBox,
  TableScroll,
} from "../components/console";
import { actionName } from "./overview";

type Audit = {
  event_id: string;
  actor_id: string;
  action: string;
  target: string;
  occurred_at: number;
  source: string;
  before_json: string | null;
  after_json: string | null;
};
type Cursor = { time: number; id: string };
export function AuditLog() {
  useLocale();
  const [search, setSearch] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [cursor, setCursor] = useState<Cursor | null>(null),
    [history, setHistory] = useState<(Cursor | null)[]>([]),
    [selected, setSelected] = useState<Audit | null>(null);
  const params = new URLSearchParams({ q: search, limit: "25" });
  if (from) params.set("from", String(new Date(from).getTime()));
  if (to) params.set("to", String(new Date(to).getTime() + 86_400_000 - 1));
  if (cursor) {
    params.set("cursorTime", String(cursor.time));
    params.set("cursorId", cursor.id);
  }
  const query = useQuery({
    queryKey: ["audit", params.toString()],
    queryFn: () => api<{ events: Audit[]; nextCursor: Cursor | null }>(`/audit?${params}`),
  });
  const reset = () => {
    setCursor(null);
    setHistory([]);
  };
  return (
    <Page title={t("監査ログ")}>
      <Panel>
        <div className="toolbar wrap">
          <SearchBox
            value={search}
            onChange={(v) => {
              setSearch(v);
              reset();
            }}
            placeholder={t("操作・実行者・対象・発行リクエスト ID で検索")}
          />
          <div className="date-filter">
            <span>{t("開始日")}</span>
            <DateSelect
              label={t("開始日")}
              value={from}
              onChange={(value) => {
                setFrom(value);
                reset();
              }}
            />
          </div>
          <div className="date-filter">
            <span>{t("終了日")}</span>
            <DateSelect
              label={t("終了日")}
              value={to}
              onChange={(value) => {
                setTo(value);
                reset();
              }}
            />
          </div>
          {(search || from || to) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setFrom("");
                setTo("");
                reset();
              }}
            >
              {t("条件をクリア")}
            </Button>
          )}
        </div>
        <Notice error={query.error} />
        {query.isPending ? (
          <Loading />
        ) : !query.data?.events.length ? (
          <Empty title={t("該当する記録がありません")} />
        ) : (
          <TableScroll>
            <Table className="data-table">
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("操作")}</Table.Head>
                  <Table.Head>{t("対象")}</Table.Head>
                  <Table.Head>{t("実行者")}</Table.Head>
                  <Table.Head>{t("日時")}</Table.Head>
                  <Table.Head>
                    <span className="sr-only">{t("詳細")}</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {query.data.events.map((item) => (
                  <Table.Row key={item.event_id}>
                    <Table.Cell>
                      <strong>{actionName(item.action)}</strong>
                      <small>
                        {item.source === "issuance"
                          ? t("トークン発行")
                          : item.source === "policy"
                            ? t("ポリシー")
                            : t("管理・認証")}
                      </small>
                    </Table.Cell>
                    <Table.Cell className="breakable">{item.target}</Table.Cell>
                    <Table.Cell className="mono muted">
                      {item.source === "issuance" ? item.actor_id : `${item.actor_id.slice(0, 8)}…`}
                    </Table.Cell>
                    <Table.Cell className="nowrap muted">{date(item.occurred_at)}</Table.Cell>
                    <Table.Cell>
                      <Button size="sm" variant="ghost" onClick={() => setSelected(item)}>
                        {t("詳細")}
                        <ChevronRight size={14} />
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </TableScroll>
        )}
        <div className="pagination">
          <span>{t("{{value1}} ページ", { value1: history.length + 1 })}</span>
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={!history.length}
              onClick={() => {
                setCursor(history.at(-1) ?? null);
                setHistory(history.slice(0, -1));
              }}
            >
              <ChevronLeft size={14} />
              {t("前へ")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!query.data?.nextCursor}
              onClick={() => {
                setHistory([...history, cursor]);
                setCursor(query.data!.nextCursor);
              }}
            >
              {t("次へ")}
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </Panel>
      {selected && (
        <Modal
          open
          title={actionName(selected.action)}
          description={date(selected.occurred_at)}
          onClose={() => setSelected(null)}
        >
          <div className="modal-body">
            <dl className="review-list">
              <dt>{t("対象")}</dt>
              <dd>{selected.target}</dd>
              <dt>{t("実行者")}</dt>
              <dd className="mono">{selected.actor_id}</dd>
              <dt>{t("イベント ID")}</dt>
              <dd className="mono">{selected.event_id}</dd>
            </dl>
            {selected.before_json && (
              <>
                <h3>{t("変更前")}</h3>
                <pre className="code-block">{pretty(selected.before_json)}</pre>
              </>
            )}
            {selected.after_json && (
              <>
                <h3>{t("変更後・記録内容")}</h3>
                <pre className="code-block">{pretty(selected.after_json)}</pre>
              </>
            )}
          </div>
        </Modal>
      )}
    </Page>
  );
}
const pretty = (value: string) => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

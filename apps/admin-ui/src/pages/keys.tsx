import { t, useLocale } from "../i18n";
import { Table } from "@cloudflare/kumo/components/table";
import { Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "../components/select";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAudiences } from "./policies";
import {
  CalendarIcon as CalendarClock,
  CaretRightIcon as ChevronRight,
  KeyIcon as KeyRound,
  PauseIcon as Pause,
  PlayIcon as Play,
  PlusIcon as Plus,
  ArrowCounterClockwiseIcon as RotateCcw,
  ShieldWarningIcon as ShieldAlert,
  ShieldCheckIcon as ShieldCheck,
} from "@phosphor-icons/react";
import { api, date, highImpact, localInput, queryClient, useMe } from "../api";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { DateSelect } from "../components/date-select";
import {
  CopyButton,
  Empty,
  Field,
  Form,
  Info,
  Loading,
  Modal,
  Notice,
  Page,
  Panel,
  SaveBar,
  Status,
  useTask,
  TableScroll,
} from "../components/console";

type Key = {
  kid: string;
  algorithm: string;
  state: string;
  public_jwk_json: string;
  created_at: number;
  published_at: number | null;
  activated_at: number | null;
  remove_not_before: number | null;
};
type Run = {
  id: string;
  algorithm: string;
  state: string;
  new_kid: string | null;
  old_kid: string | null;
  created_at: number;
  updated_at: number;
  error_code: string | null;
  workflowStatus: string;
};
type Schedule = {
  algorithm: "RS256" | "ES256";
  enabled: number;
  interval_days: number;
  next_run_at: number;
  prepublish_seconds: number;
  retirement_grace_seconds: number;
  version: number;
  last_error: string | null;
};
type Proposal = {
  id: string;
  proposed_by: string;
  approved_by: string | null;
  plan_json: string;
  state: string;
  created_at: number;
};
type Evidence = {
  id: string;
  run_id: string;
  kind: string;
  evidence_json: string;
  recorded_at: number;
};
type Action = {
  id: string;
  run_id: string | null;
  action: string;
  detail_json: string;
  occurred_at: number;
  actor_id: string;
};
type KeyData = {
  keys: Key[];
  runs: Run[];
  schedules: Schedule[];
  proposals: Proposal[];
  evidence: Evidence[];
  actions: Action[];
};
const stateNames: Record<string, string> = {
  get prepared() {
    return t("先行公開");
  },
  get active() {
    return t("署名中");
  },
  get verifying() {
    return t("検証用に保持");
  },
  get removed() {
    return t("廃止済み");
  },
  get draft() {
    return t("準備中");
  },
  get "secret-staging"() {
    return t("秘密鍵を登録中");
  },
  get published() {
    return t("先行公開・待機");
  },
  get failed() {
    return t("失敗");
  },
  get proposed() {
    return t("承認待ち");
  },
  get approved() {
    return t("承認済み");
  },
};
const workflowNames: Record<string, string> = {
  get running() {
    return t("実行中");
  },
  get waiting() {
    return t("待機中");
  },
  get paused() {
    return t("一時停止");
  },
  get errored() {
    return t("要確認");
  },
  get terminated() {
    return t("停止済み");
  },
  get complete() {
    return t("完了");
  },
  get queued() {
    return t("開始待ち");
  },
  get unknown() {
    return t("状態未取得");
  },
};
const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["keys"] }),
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
  ]);
export function Keys() {
  useLocale();
  const query = useQuery({
      queryKey: ["keys"],
      queryFn: () => api<{ keys: KeyData }>("/keys"),
      refetchInterval: 15_000,
    }),
    me = useMe(),
    secure = me.data?.role === "security-admin",
    canPropose = me.data?.role !== "viewer",
    [planning, setPlanning] = useState(false),
    [schedule, setSchedule] = useState<Schedule | "RS256" | "ES256" | null>(null),
    [details, setDetails] = useState<string | null>(null),
    [viewKey, setViewKey] = useState<Key | null>(null),
    [control, setControl] = useState<{ run: Run; action: "pause" | "resume" | "retry" } | null>(
      null,
    ),
    [immediate, setImmediate] = useState<Run | null>(null),
    [approve, setApprove] = useState<Proposal | null>(null),
    task = useTask();
  const audiences = useAudiences();
  const data = query.data?.keys,
    selected = data?.runs.find((r) => r.id === details),
    needsConfirmation = audiences.data?.audiences.some((a) => a.jwks_cache_seconds === null);
  return (
    <Page
      title={t("署名鍵とローテーション")}
      description={t("検証側のキャッシュ期間を考慮しつつ、署名鍵をローテーションします。")}
      action={
        canPropose && (
          <Button data-variant="primary" variant="primary" onClick={() => setPlanning(true)}>
            <Plus size={17} />
            {secure ? t("鍵ローテーションを開始") : t("鍵ローテーションを提案")}
          </Button>
        )
      }
    >
      <Notice error={query.error ?? task.error ?? audiences.error} />
      {needsConfirmation && (
        <Info tone="warning">
          {t("キャッシュ上限が未設定の Audience があります。通常の鍵ローテーションは停止します。")}{" "}
          <Link to="/audiences" className="inline-link">
            {t("Audience の設定を確認")}
          </Link>
        </Info>
      )}
      <div className="key-grid">
        {["RS256", "ES256"].map((alg) => {
          const key = data?.keys.find((k) => k.algorithm === alg && k.state === "active");
          return (
            <Panel key={alg}>
              <div className="key-card-heading">
                <span className="key-icon">
                  <KeyRound size={22} />
                </span>
                <span>{alg}</span>
                <Status tone={key ? "good" : "neutral"}>{key ? t("署名中") : t("未設定")}</Status>
              </div>
              {key ? (
                <>
                  <Button variant="ghost" className="key-id mono" onClick={() => setViewKey(key)}>
                    {key.kid}
                    <ChevronRight size={16} />
                  </Button>
                  <p className="muted text-sm">
                    {t("有効化 {{value1}}", { value1: date(key.activated_at) })}
                  </p>
                </>
              ) : (
                <>
                  <h3 className="key-empty-title">{t("署名鍵がありません")}</h3>
                  <p className="muted text-sm">{t("新しい鍵を生成し、先行公開から開始します。")}</p>
                </>
              )}
            </Panel>
          );
        })}
      </div>
      <Panel
        title={t("鍵ローテーションの履歴")}
        description={t("アルゴリズムごとに、同時に実行できるローテーションは1件です。")}
      >
        {query.isPending ? (
          <Loading />
        ) : !data?.runs.length ? (
          <Empty
            title={t("鍵ローテーションはまだありません")}
            description={t("最初の鍵を生成して、アサーションの発行を準備します。")}
          />
        ) : (
          <TableScroll>
            <Table className="data-table">
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("ローテーションタスク")}</Table.Head>
                  <Table.Head>{t("鍵の状態")}</Table.Head>
                  <Table.Head>{t("実行状況")}</Table.Head>
                  <Table.Head>{t("最終更新")}</Table.Head>
                  <Table.Head>
                    <span className="sr-only">{t("操作")}</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.runs.map((run) => (
                  <Table.Row key={run.id}>
                    <Table.Cell>
                      <strong>{run.algorithm}</strong>
                      <small className="mono">{run.id.slice(0, 8)}</small>
                    </Table.Cell>
                    <Table.Cell>
                      <Status
                        tone={
                          run.state === "failed"
                            ? "danger"
                            : run.state === "active" || run.state === "removed"
                              ? "good"
                              : "neutral"
                        }
                      >
                        {stateNames[run.state] ?? run.state}
                      </Status>
                    </Table.Cell>
                    <Table.Cell>
                      <Status tone={run.workflowStatus === "errored" ? "warning" : "neutral"}>
                        {workflowNames[run.workflowStatus] ?? run.workflowStatus}
                      </Status>
                    </Table.Cell>
                    <Table.Cell className="muted nowrap">{date(run.updated_at)}</Table.Cell>
                    <Table.Cell>
                      <div className="row-actions">
                        {secure && !["removed", "failed", "secret-staging"].includes(run.state) && (
                          <>
                            {run.workflowStatus === "paused" ? (
                              <Button
                                size="base"
                                shape="square"
                                variant="ghost"
                                aria-label={t("{{value1}} を再開", { value1: run.id })}
                                title={t("再開")}
                                onClick={() => setControl({ run, action: "resume" })}
                              >
                                <Play size={15} />
                              </Button>
                            ) : ["errored", "terminated", "unknown"].includes(
                                run.workflowStatus,
                              ) ? (
                              <Button
                                size="base"
                                shape="square"
                                variant="ghost"
                                aria-label={t("{{value1}} を再試行", { value1: run.id })}
                                title={t("再試行")}
                                onClick={() => setControl({ run, action: "retry" })}
                              >
                                <RotateCcw size={15} />
                              </Button>
                            ) : (
                              <Button
                                size="base"
                                shape="square"
                                variant="ghost"
                                aria-label={t("{{value1}} を一時停止", { value1: run.id })}
                                title={t("一時停止")}
                                onClick={() => setControl({ run, action: "pause" })}
                              >
                                <Pause size={15} />
                              </Button>
                            )}
                          </>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setDetails(run.id)}>
                          {t("詳細")}
                          <ChevronRight size={14} />
                        </Button>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </TableScroll>
        )}
      </Panel>
      <Panel
        title={t("定期ローテーション")}
        description={t(
          "relying party での確認記録と使用中の鍵がある場合に有効化できます。初期状態は無効です。",
        )}
      >
        <div className="schedule-list">
          {(["RS256", "ES256"] as const).map((alg) => {
            const item = data?.schedules.find((s) => s.algorithm === alg);
            return (
              <div className="schedule-item" key={alg}>
                <span className="resource-icon">
                  <CalendarClock size={20} />
                </span>
                <div>
                  <h3>
                    {alg}{" "}
                    <Status tone={item?.enabled ? "good" : "neutral"}>
                      {item?.enabled ? t("自動化が有効") : t("手動")}
                    </Status>
                  </h3>
                  <p>
                    {item?.enabled
                      ? t("{{value1}} 日ごと ・ 次回 {{value2}}", {
                          value1: item.interval_days,
                          value2: date(item.next_run_at),
                        })
                      : t("定期実行は設定されていません")}
                  </p>
                  {item?.last_error && (
                    <p className="text-danger">
                      {t(
                        "自動ローテーションを停止しました。Audience のキャッシュ上限と有効な署名鍵を確認してください。",
                      )}{" "}
                      <Link to="/audiences" className="inline-link">
                        {t("Audience の設定を確認")}
                      </Link>
                    </p>
                  )}
                </div>
                {secure && (
                  <Button variant="outline" size="sm" onClick={() => setSchedule(item ?? alg)}>
                    {t("設定")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
      {!!data?.proposals.length && (
        <Panel
          title={t("ローテーションの提案")}
          description={t("提案者とは別のセキュリティ管理者が承認します。")}
        >
          <TableScroll>
            <Table className="data-table">
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("提案")}</Table.Head>
                  <Table.Head>{t("提案者")}</Table.Head>
                  <Table.Head>{t("状態")}</Table.Head>
                  <Table.Head>
                    <span className="sr-only">{t("操作")}</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.proposals.map((p) => (
                  <Table.Row key={p.id}>
                    <Table.Cell>
                      <strong>{JSON.parse(p.plan_json).algorithm}</strong>
                      <small>{date(p.created_at)}</small>
                    </Table.Cell>
                    <Table.Cell className="mono">{p.proposed_by.slice(0, 8)}…</Table.Cell>
                    <Table.Cell>
                      <Status tone={p.state === "approved" ? "good" : "warning"}>
                        {stateNames[p.state]}
                      </Status>
                    </Table.Cell>
                    <Table.Cell>
                      {secure && p.state === "proposed" && p.proposed_by !== me.data?.id && (
                        <Button size="sm" variant="outline" onClick={() => setApprove(p)}>
                          {t("内容を確認")}
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </TableScroll>
        </Panel>
      )}
      <Info>
        {t(
          "秘密鍵はサーバー側で生成・登録します。管理画面には公開鍵と進捗だけが返されます。確認が記録されていない relying party があると、通常のローテーションは停止します。",
        )}
      </Info>
      {planning && <PlanEditor secure={secure} onClose={() => setPlanning(false)} />}
      {schedule && (
        <ScheduleEditor
          schedule={typeof schedule === "string" ? null : schedule}
          algorithm={typeof schedule === "string" ? schedule : schedule.algorithm}
          onClose={() => setSchedule(null)}
        />
      )}
      {viewKey && (
        <Modal open onClose={() => setViewKey(null)} title={t("公開鍵の詳細")}>
          <div className="modal-body">
            <dl className="review-list">
              <dt>Key ID</dt>
              <dd className="mono">{viewKey.kid}</dd>
              <dt>{t("状態")}</dt>
              <dd>{stateNames[viewKey.state]}</dd>
              <dt>{t("公開日")}</dt>
              <dd>{date(viewKey.published_at)}</dd>
            </dl>
            <pre className="code-block">
              {JSON.stringify(JSON.parse(viewKey.public_jwk_json), null, 2)}
            </pre>
            <CopyButton value={viewKey.public_jwk_json} label={t("公開 JWK をコピー")} />
          </div>
        </Modal>
      )}
      {selected && (
        <Modal
          open
          wide
          onClose={() => setDetails(null)}
          title={t("{{value1}} の鍵ローテーション", { value1: selected.algorithm })}
          description={selected.id}
        >
          <div className="modal-body">
            <div className="rotation-progress">
              {["draft", "published", "active", "removed"].map((state, index) => {
                const current = ["draft", "published", "active", "removed"].indexOf(selected.state);
                return (
                  <div
                    className={current >= index ? "progress-step reached" : "progress-step"}
                    key={state}
                  >
                    <span>{current >= index ? <ShieldCheck size={16} /> : index + 1}</span>
                    <strong>
                      {
                        [t("生成・登録"), t("先行公開・待機"), t("新鍵で発行"), t("旧鍵を廃止")][
                          index
                        ]
                      }
                    </strong>
                  </div>
                );
              })}
            </div>
            <dl className="review-list">
              <dt>{t("新しい鍵")}</dt>
              <dd className="mono">{selected.new_kid ?? t("準備中")}</dd>
              <dt>{t("以前の鍵")}</dt>
              <dd className="mono">{selected.old_kid ?? t("初回の鍵生成")}</dd>
              <dt>{t("実行状況")}</dt>
              <dd>{workflowNames[selected.workflowStatus] ?? selected.workflowStatus}</dd>
              {selected.error_code && (
                <>
                  <dt>{t("停止理由")}</dt>
                  <dd>{selected.error_code}</dd>
                </>
              )}
            </dl>
            <h3>{t("ゲートの証拠")}</h3>
            {data?.evidence.filter((e) => e.run_id === selected.id).length ? (
              data.evidence
                .filter((e) => e.run_id === selected.id)
                .map((e) => (
                  <div key={e.id}>
                    <p>
                      {t("{{value1}} ・ {{value2}}", {
                        value1: e.kind,
                        value2: date(e.recorded_at),
                      })}
                    </p>
                    <pre className="code-block">
                      {JSON.stringify(JSON.parse(e.evidence_json), null, 2)}
                    </pre>
                  </div>
                ))
            ) : (
              <p className="muted">{t("まだ記録されていません。")}</p>
            )}
            <h3>{t("操作履歴")}</h3>
            {data?.actions
              .filter((a) => a.run_id === selected.id)
              .map((a) => (
                <div className="detail-event" key={a.id}>
                  <strong>{a.action}</strong>
                  <time>{date(a.occurred_at)}</time>
                  <p>{JSON.parse(a.detail_json).reason ?? a.actor_id}</p>
                </div>
              ))}
            {secure && selected.state === "published" && (
              <Button
                variant="destructive"
                onClick={() => {
                  setDetails(null);
                  setImmediate(selected);
                }}
              >
                <ShieldAlert size={16} />
                {t("待機期間を省略して即時ローテーション", { context: "action" })}
              </Button>
            )}
          </div>
        </Modal>
      )}
      {control && (
        <ControlEditor run={control.run} action={control.action} onClose={() => setControl(null)} />
      )}
      {immediate && <ImmediateEditor run={immediate} onClose={() => setImmediate(null)} />}
      {approve && <Approval proposal={approve} onClose={() => setApprove(null)} />}
    </Page>
  );
}
function PlanEditor({ secure, onClose }: { secure: boolean; onClose: () => void }) {
  useLocale();
  const task = useTask(),
    [algorithm, setAlgorithm] = useState("RS256"),
    [publish, setPublish] = useState(7200),
    [grace, setGrace] = useState(600);
  return (
    <Modal
      open
      title={secure ? t("新しい鍵を生成してローテーションを開始") : t("鍵ローテーションを提案")}
      description={t("先行公開・旧鍵保持の期間を確保してから、順に進めます。")}
      onClose={onClose}
    >
      <Form
        onSubmit={() =>
          void task.run(
            async () => {
              const headers = secure ? await highImpact("rotation.plan") : undefined;
              await api(secure ? "/rotations" : "/rotation-proposals", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  algorithm,
                  prepublishSeconds: publish,
                  retirementGraceSeconds: grace,
                }),
              });
              await refresh();
              onClose();
            },
            secure ? t("鍵ローテーションを開始しました") : t("ローテーションの提案を登録しました"),
          )
        }
      >
        <div className="modal-body">
          <Field label={t("署名方式")}>
            <Select value={algorithm} onValueChange={(value) => setAlgorithm(value!)}>
              <Select.Option value="RS256">RS256</Select.Option>
              <Select.Option value="ES256">ES256</Select.Option>
            </Select>
          </Field>
          <Timing publish={publish} setPublish={setPublish} grace={grace} setGrace={setGrace} />
          <Info>
            {t(
              "relying party で確認したキャッシュ時間に60秒を加えた期間以上の先行公開が必要です。",
            )}
          </Info>
          <Notice error={task.error} />
        </div>
        <SaveBar
          busy={task.busy}
          onCancel={onClose}
          label={secure ? t("鍵を生成して開始") : t("承認を依頼")}
        />
      </Form>
    </Modal>
  );
}
function Timing({
  publish,
  setPublish,
  grace,
  setGrace,
}: {
  publish: number;
  setPublish: (v: number) => void;
  grace: number;
  setGrace: (v: number) => void;
}) {
  useLocale();
  return (
    <div className="timing-fields">
      <Field
        label={t("先行公開（秒）")}
        hint={t("relying party の鍵キャッシュが更新されるまで待機")}
      >
        <Input
          type="number"
          min={60}
          max={2592000}
          value={publish}
          onChange={(e) => setPublish(Number(e.target.value))}
          required
        />
      </Field>
      <Field label={t("旧鍵の追加保持（秒）")} hint={t("旧 JWT の最大有効期間に加える猶予")}>
        <Input
          type="number"
          min={300}
          max={2592000}
          value={grace}
          onChange={(e) => setGrace(Number(e.target.value))}
          required
        />
      </Field>
    </div>
  );
}
function ScheduleEditor({
  schedule: s,
  algorithm,
  onClose,
}: {
  schedule: Schedule | null;
  algorithm: "RS256" | "ES256";
  onClose: () => void;
}) {
  useLocale();
  const task = useTask(),
    [enabled, setEnabled] = useState(!!s?.enabled),
    [days, setDays] = useState(s?.interval_days ?? 90),
    [next, setNext] = useState(localInput(Math.max(s?.next_run_at ?? 0, Date.now() + 86_400_000))),
    [publish, setPublish] = useState(s?.prepublish_seconds ?? 7200),
    [grace, setGrace] = useState(s?.retirement_grace_seconds ?? 600);
  return (
    <Modal
      open
      title={t("{{value1}} の定期ローテーション", { value1: algorithm })}
      description={t("実行時にも relying party の確認記録を再確認し、不足があれば停止します。")}
      onClose={onClose}
    >
      <Form
        onSubmit={() =>
          void task.run(async () => {
            const headers = await highImpact("rotation.schedule");
            await api("/rotation-schedules", {
              method: "PUT",
              headers,
              body: JSON.stringify({
                algorithm,
                version: s?.version ?? 0,
                enabled,
                intervalDays: days,
                nextRunAt: new Date(next).getTime(),
                prepublishSeconds: publish,
                retirementGraceSeconds: grace,
              }),
            });
            await refresh();
            onClose();
          }, t("定期ローテーションを保存しました"))
        }
      >
        <div className="modal-body">
          <div className="check-label">
            <Checkbox
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked)}
              label={<>{t("定期ローテーションを有効にする")}</>}
            />
          </div>
          <div className="schedule-fields">
            <Field label={t("実行間隔（日）")}>
              <Input
                type="number"
                min={7}
                max={365}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                required
              />
            </Field>
            <div className="schedule-datetime">
              <Field label={t("次回の準備開始（端末の時刻）")}>
                <DateSelect
                  label={t("次回の準備開始（端末の時刻）")}
                  value={next.slice(0, 10)}
                  onChange={(value) => setNext(`${value}T${next.slice(11) || "00:00"}`)}
                />
              </Field>
              <Field label={t("時刻")}>
                <Input
                  type="time"
                  value={next.slice(11)}
                  onChange={(e) => setNext(`${next.slice(0, 10)}T${e.target.value}`)}
                  required
                />
              </Field>
            </div>
          </div>
          <Timing publish={publish} setPublish={setPublish} grace={grace} setGrace={setGrace} />
          <Info>
            {t(
              "予定日時を過ぎた最初の定期チェックで開始します。進行中のローテーションがある場合は、その完了後まで延期します。",
            )}
          </Info>
          <Notice error={task.error} />
        </div>
        <SaveBar busy={task.busy} onCancel={onClose} />
      </Form>
    </Modal>
  );
}
function ControlEditor({
  run,
  action,
  onClose,
}: {
  run: Run;
  action: "pause" | "resume" | "retry";
  onClose: () => void;
}) {
  useLocale();
  const [reason, setReason] = useState(""),
    task = useTask(),
    label = { pause: t("一時停止", { context: "action" }), resume: t("再開"), retry: t("再試行") }[
      action
    ];
  return (
    <Modal
      open
      title={
        {
          pause: t("鍵ローテーションを一時停止"),
          resume: t("鍵ローテーションを再開"),
          retry: t("鍵ローテーションを再試行"),
        }[action]
      }
      description={t("公開済みの鍵は保持します。検証条件を飛ばして進めることはありません。")}
      onClose={onClose}
    >
      <Form
        onSubmit={() =>
          void task.run(
            async () => {
              const headers = await highImpact("rotation.control");
              await api(`/rotations/${run.id}/control`, {
                method: "POST",
                headers,
                body: JSON.stringify({ action, reason }),
              });
              await refresh();
              onClose();
            },
            {
              pause: t("鍵ローテーションを一時停止しました"),
              resume: t("鍵ローテーションを再開しました"),
              retry: t("鍵ローテーションを再試行しました"),
            }[action],
          )
        }
      >
        <div className="modal-body">
          <Field label={t("理由（監査ログに記録）")}>
            <Textarea
              required
              minLength={8}
              maxLength={1024}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Notice error={task.error} />
        </div>
        <SaveBar busy={task.busy} onCancel={onClose} label={label} />
      </Form>
    </Modal>
  );
}
function ImmediateEditor({ run, onClose }: { run: Run; onClose: () => void }) {
  useLocale();
  const [reason, setReason] = useState(""),
    [kid, setKid] = useState(""),
    [ack, setAck] = useState(false),
    task = useTask();
  return (
    <Modal
      open
      title={t("待機期間を省略して即時ローテーション")}
      description={t("先行公開済みの新鍵に切り替えます。配備と JWKS の整合性検証は省略しません。")}
      onClose={onClose}
    >
      <Form
        onSubmit={() =>
          void task.run(async () => {
            const headers = await highImpact("rotation.immediate");
            await api(`/rotations/${run.id}/immediate`, {
              method: "POST",
              headers,
              body: JSON.stringify({ reason, expectedKid: kid, acknowledgeCacheRisk: ack }),
            });
            await refresh();
            onClose();
          }, t("即時ローテーションを実行しました"))
        }
      >
        <div className="modal-body">
          <Info tone="warning">
            {t(
              "relying party が新しい鍵を取得していないと認証が失敗します。旧鍵の廃止待機は維持されます。漏えいした認証情報の停止は、relying party 側でも別途行ってください。",
            )}
          </Info>
          <p className="mono breakable">{run.new_kid}</p>
          <Field label={t("新しい Key ID を入力して確認")}>
            <Input value={kid} onChange={(e) => setKid(e.target.value)} required />
          </Field>
          <Field label={t("即時ローテーションの理由")}>
            <Textarea
              minLength={8}
              maxLength={1024}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="check-label">
            <Checkbox
              checked={ack}
              onCheckedChange={(checked) => setAck(checked)}
              required
              label={<>{t("relying party への影響と停止手順を確認しました")}</>}
            />
          </div>
          <Notice error={task.error} />
        </div>
        <SaveBar
          busy={task.busy}
          onCancel={onClose}
          disabled={!ack || kid !== run.new_kid}
          label={t("即時ローテーションを実行")}
        />
      </Form>
    </Modal>
  );
}
function Approval({ proposal, onClose }: { proposal: Proposal; onClose: () => void }) {
  useLocale();
  const task = useTask(),
    plan = JSON.parse(proposal.plan_json);
  return (
    <Modal
      open
      title={t("鍵ローテーションの提案を承認")}
      description={t("承認すると鍵の生成・先行公開を開始します。")}
      onClose={onClose}
    >
      <Form
        onSubmit={() =>
          void task.run(async () => {
            const headers = await highImpact("rotation.approve");
            await api(`/rotation-proposals/${proposal.id}/approve`, { method: "POST", headers });
            await refresh();
            onClose();
          }, t("提案を承認してローテーションを開始しました"))
        }
      >
        <div className="modal-body">
          <dl className="review-list">
            <dt>{t("署名方式")}</dt>
            <dd>{plan.algorithm}</dd>
            <dt>{t("先行公開")}</dt>
            <dd>{t("{{value1}} 秒", { value1: plan.prepublishSeconds })}</dd>
            <dt>{t("旧鍵の追加保持")}</dt>
            <dd>{t("{{value1}} 秒", { value1: plan.retirementGraceSeconds })}</dd>
            <dt>{t("提案者")}</dt>
            <dd className="mono">{proposal.proposed_by}</dd>
          </dl>
          <Notice error={task.error} />
        </div>
        <SaveBar busy={task.busy} onCancel={onClose} label={t("承認して開始")} />
      </Form>
    </Modal>
  );
}

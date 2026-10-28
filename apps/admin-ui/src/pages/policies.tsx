import { t, useLocale } from "../i18n";
import { Table } from "@cloudflare/kumo/components/table";
import { Select } from "../components/select";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CodeIcon as Code2,
  PencilSimpleIcon as Pencil,
  PlusIcon as Plus,
  PowerIcon as Power,
} from "@phosphor-icons/react";
import {
  clientCreateSchema,
  clientUpdateSchema,
  audienceCreateSchema,
} from "@workers-workload-identity/contracts";
import { api, queryClient, useMe, date } from "../api";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import {
  Confirm,
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
  SearchBox,
  Status,
  useTask,
  TableScroll,
} from "../components/console";

export type Client = {
  client_id: string;
  subject: string;
  enabled: number;
  version: number;
  updated_at: number;
};
export type Grant = { client_id: string; audience: string };
export type Audience = {
  audience: string;
  algorithm: "RS256" | "ES256";
  token_lifetime_seconds: number;
  description: string;
  verified_for_es256: number;
  exchange_verified: number;
  mixed_jwks_verified: number;
  jwks_cache_seconds: number | null;
  version: number;
  updated_at: number;
};
export const useClients = () =>
  useQuery({
    queryKey: ["clients"],
    queryFn: () => api<{ clients: Client[]; grants: Grant[] }>("/clients"),
  });
export const useAudiences = () =>
  useQuery({
    queryKey: ["audiences"],
    queryFn: () => api<{ audiences: Audience[] }>("/audiences"),
  });
async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["clients"] }),
    queryClient.invalidateQueries({ queryKey: ["audiences"] }),
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
  ]);
}

export function Clients() {
  useLocale();
  const query = useClients(),
    me = useMe(),
    canEdit = me.data?.role !== "viewer",
    [search, setSearch] = useState(""),
    [state, setState] = useState("all"),
    [editing, setEditing] = useState<Client | "new" | null>(null),
    [stopping, setStopping] = useState<Client | null>(null),
    [binding, setBinding] = useState<Client | null>(null);
  const rows =
    query.data?.clients.filter(
      (row) =>
        (state === "all" || (state === "enabled") === (row.enabled === 1)) &&
        `${row.client_id} ${row.subject}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const bindingCode = binding
    ? JSON.stringify(
        {
          services: [
            {
              binding: "OIDC_ISSUER",
              service: "oidc",
              entrypoint: "IssuerRpc",
              props: { clientId: binding.client_id },
            },
          ],
        },
        null,
        2,
      )
    : "";
  return (
    <Page
      title={t("ワークロード")}
      action={
        canEdit && (
          <Button data-variant="primary" variant="primary" onClick={() => setEditing("new")}>
            <Plus size={17} />
            {t("ワークロードを登録")}
          </Button>
        )
      }
    >
      <Panel>
        <div className="toolbar">
          <SearchBox value={search} onChange={setSearch} placeholder={t("名前・Subject で検索")} />
          <Select
            items={{ all: t("すべての状態"), enabled: t("有効"), disabled: t("停止中") }}
            aria-label={t("稼働状態")}
            value={state}
            onValueChange={(value) => setState(value!)}
          >
            <Select.Option value="all">{t("すべての状態")}</Select.Option>
            <Select.Option value="enabled">{t("有効")}</Select.Option>
            <Select.Option value="disabled">{t("停止中")}</Select.Option>
          </Select>
          <span className="result-count">{t("{{value1}} 件", { value1: rows.length })}</span>
        </div>
        <Notice error={query.error} />
        {query.isPending ? (
          <Loading />
        ) : !rows.length ? (
          <Empty
            title={t("ワークロードが見つかりません")}
            description={
              search
                ? undefined
                : t(
                    "ワークロードを登録すると、許可された audience 向けのアサーションを発行できます。",
                  )
            }
          />
        ) : (
          <TableScroll>
            <Table className="data-table">
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("ワークロード")}</Table.Head>
                  <Table.Head>{t("許可した audience")}</Table.Head>
                  <Table.Head>{t("状態")}</Table.Head>
                  <Table.Head>{t("更新日時")}</Table.Head>
                  <Table.Head>
                    <span className="sr-only">{t("操作")}</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row key={row.client_id}>
                    <Table.Cell>
                      <div className="cell-title">
                        <span className="resource-icon">
                          <Code2 size={17} />
                        </span>
                        <div>
                          <strong>{row.client_id}</strong>
                          <small className="mono">{row.subject}</small>
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="tag-list">
                        {query.data?.grants
                          .filter((g) => g.client_id === row.client_id)
                          .map((g) => (
                            <Badge variant="outline" className="tag" key={g.audience}>
                              {g.audience}
                            </Badge>
                          ))}
                        {!query.data?.grants.some((g) => g.client_id === row.client_id) && (
                          <span className="muted">{t("未設定")}</span>
                        )}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Status tone={row.enabled ? "good" : "neutral"}>
                        {row.enabled ? t("有効") : t("停止中")}
                      </Status>
                    </Table.Cell>
                    <Table.Cell className="muted nowrap">{date(row.updated_at)}</Table.Cell>
                    <Table.Cell>
                      <div className="row-actions">
                        <Button
                          size="base"
                          shape="square"
                          variant="ghost"
                          aria-label={t("{{value1}} の接続設定", { value1: row.client_id })}
                          title={t("接続設定")}
                          onClick={() => setBinding(row)}
                        >
                          <Code2 size={16} />
                        </Button>
                        {canEdit && (
                          <>
                            <Button
                              size="base"
                              shape="square"
                              variant="ghost"
                              aria-label={t("{{value1}} を編集", { value1: row.client_id })}
                              title={t("編集")}
                              onClick={() => setEditing(row)}
                            >
                              <Pencil size={16} />
                            </Button>
                            <Button
                              size="base"
                              shape="square"
                              variant="ghost"
                              aria-label={t("{{value1}} を{{value2}}", {
                                value1: row.client_id,
                                value2: row.enabled ? t("停止") : t("再開"),
                              })}
                              title={row.enabled ? t("停止") : t("再開")}
                              onClick={() => setStopping(row)}
                            >
                              <Power size={16} />
                            </Button>
                          </>
                        )}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </TableScroll>
        )}
      </Panel>
      <Info>
        {t(
          "停止・許可の解除は次回の発行要求から反映されます。発行済みの JWT や交換済みの資格情報は、有効期限まで残る場合があります。",
        )}
      </Info>
      {editing && (
        <ClientEditor
          key={editing === "new" ? "new" : editing.client_id}
          client={editing === "new" ? null : editing}
          grants={query.data?.grants ?? []}
          onClose={() => setEditing(null)}
        />
      )}
      {stopping && (
        <Confirm
          title={
            stopping.enabled ? t("ワークロードを停止しますか？") : t("ワークロードを再開しますか？")
          }
          description={t("{{value1}} の新規発行を{{value2}}します。", {
            value1: stopping.client_id,
            value2: stopping.enabled ? t("停止") : t("再開"),
          })}
          label={stopping.enabled ? t("発行を停止") : t("発行を再開")}
          successMessage={
            stopping.enabled
              ? t("ワークロードのトークン発行を停止しました")
              : t("ワークロードのトークン発行を再開しました")
          }
          danger={!!stopping.enabled}
          onClose={() => setStopping(null)}
          onConfirm={async () => {
            await api(`/clients/${encodeURIComponent(stopping.client_id)}`, {
              method: "PATCH",
              body: JSON.stringify({
                version: stopping.version,
                enabled: !stopping.enabled,
                audiences:
                  query.data?.grants
                    .filter((g) => g.client_id === stopping.client_id)
                    .map((g) => g.audience) ?? [],
              }),
            });
            await refresh();
          }}
        />
      )}
      {binding && (
        <Modal
          open
          title={t("Service Binding の設定")}
          description={t(
            "caller 側の Wrangler 設定に追加します。service は配備先の issuer 名に合わせてください。",
          )}
          onClose={() => setBinding(null)}
        >
          <div className="modal-body">
            <pre className="code-block">{bindingCode}</pre>
            <CopyButton value={bindingCode} />
            <Info>
              {t(
                "Binding を編集できる主体は clientId も変更できます。配備権限を持つ人・CI・API token を確認してください。",
              )}
            </Info>
          </div>
        </Modal>
      )}
    </Page>
  );
}
function ClientEditor({
  client,
  grants,
  onClose,
}: {
  client: Client | null;
  grants: Grant[];
  onClose: () => void;
}) {
  useLocale();
  const audiences = useAudiences(),
    task = useTask(),
    [id, setId] = useState(client?.client_id ?? ""),
    [subject, setSubject] = useState(client?.subject ?? ""),
    [enabled, setEnabled] = useState(client?.enabled !== 0),
    [selected, setSelected] = useState(
      grants.filter((g) => g.client_id === client?.client_id).map((g) => g.audience),
    ),
    [review, setReview] = useState(false);
  const old = grants.filter((g) => g.client_id === client?.client_id).map((g) => g.audience);
  const save = () =>
    void task.run(
      async () => {
        const input = client
          ? clientUpdateSchema.parse({ version: client.version, enabled, audiences: selected })
          : clientCreateSchema.parse({ clientId: id, subject, enabled, audiences: selected });
        if (!review) {
          setReview(true);
          return;
        }
        await api(client ? `/clients/${encodeURIComponent(client.client_id)}` : "/clients", {
          method: client ? "PATCH" : "POST",
          body: JSON.stringify(input),
        });
        await refresh();
        onClose();
      },
      review ? t("ワークロードを保存しました") : undefined,
    );
  return (
    <Modal
      open
      onClose={() => {
        if (!task.busy) onClose();
      }}
      title={
        review ? t("変更内容を確認") : client ? t("ワークロードを編集") : t("ワークロードを登録")
      }
      description={t("Client ID と Subject は登録後に変更できません。")}
    >
      <Form onSubmit={save}>
        <div className="modal-body">
          <Notice error={task.error} />
          {review ? (
            <>
              <dl className="review-list">
                <dt>Client ID</dt>
                <dd className="mono">{id}</dd>
                <dt>Subject</dt>
                <dd className="mono">{subject}</dd>
                <dt>{t("状態")}</dt>
                <dd>{enabled ? t("有効") : t("停止")}</dd>
                <dt>{t("追加する audience")}</dt>
                <dd>{selected.filter((v) => !old.includes(v)).join(", ") || t("なし")}</dd>
                <dt>{t("解除する audience")}</dt>
                <dd>{old.filter((v) => !selected.includes(v)).join(", ") || t("なし")}</dd>
              </dl>
              <Info>{t("許可の変更は次の発行から適用されます。")}</Info>
              <Button type="button" variant="outline" onClick={() => setReview(false)}>
                {t("編集に戻る")}
              </Button>
            </>
          ) : (
            <>
              <div className="form-grid">
                <Field label="Client ID" hint={t("英小文字・数字・ハイフン、3〜64文字")}>
                  <Input
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    required
                    disabled={!!client}
                    pattern="[a-z][a-z0-9-]{2,63}"
                    placeholder="billing-worker"
                  />
                </Field>
                <Field label="Subject">
                  <Input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    required
                    disabled={!!client}
                    minLength={3}
                    maxLength={256}
                    placeholder="service:billing"
                  />
                </Field>
              </div>
              <fieldset>
                <legend>{t("許可する audience")}</legend>
                <div className="selection-list">
                  {audiences.data?.audiences.map((a) => (
                    <div className="selection" key={a.audience}>
                      <Checkbox
                        checked={selected.includes(a.audience)}
                        onCheckedChange={(checked) =>
                          setSelected(
                            checked
                              ? [...selected, a.audience]
                              : selected.filter((v) => v !== a.audience),
                          )
                        }
                        label={
                          <>
                            {" "}
                            <span>
                              <strong>{a.audience}</strong>
                              <small>
                                {a.description ||
                                  t("{{value1}} ・ {{value2}} 秒", {
                                    value1: a.algorithm,
                                    value2: a.token_lifetime_seconds,
                                  })}
                              </small>
                            </span>{" "}
                          </>
                        }
                      />
                    </div>
                  ))}
                </div>
                {!audiences.isPending && !audiences.data?.audiences.length && (
                  <p className="muted">
                    {t("Audience が未登録です。登録後に許可を追加できます。")}
                  </p>
                )}
                <Notice error={audiences.error} />
              </fieldset>
              <div className="check-label">
                <Checkbox
                  checked={enabled}
                  onCheckedChange={(checked) => setEnabled(checked)}
                  label={<>{t("アサーションの発行を有効にする")}</>}
                />
              </div>
            </>
          )}
        </div>
        <SaveBar
          busy={task.busy}
          onCancel={onClose}
          label={review ? t("確認して保存") : t("変更内容を確認")}
        />
      </Form>
    </Modal>
  );
}
export function Audiences() {
  useLocale();
  const query = useAudiences(),
    clients = useClients(),
    me = useMe(),
    [search, setSearch] = useState(""),
    [editing, setEditing] = useState<Audience | "new" | null>(null);
  const rows =
    query.data?.audiences.filter((row) =>
      `${row.audience} ${row.description}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <Page
      title={t("Audience")}
      action={
        me.data?.role !== "viewer" && (
          <Button data-variant="primary" variant="primary" onClick={() => setEditing("new")}>
            <Plus size={17} />
            {t("Audience を登録")}
          </Button>
        )
      }
    >
      <Panel>
        <div className="toolbar">
          <SearchBox value={search} onChange={setSearch} placeholder={t("Audience・説明で検索")} />
          <span className="result-count">{t("{{value1}} 件", { value1: rows.length })}</span>
        </div>
        <Notice error={query.error} />
        {query.isPending ? (
          <Loading />
        ) : !rows.length ? (
          <Empty title={t("Audience が見つかりません")} />
        ) : (
          <TableScroll>
            <Table className="data-table">
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("Audience")}</Table.Head>
                  <Table.Head>{t("署名")}</Table.Head>
                  <Table.Head>{t("有効期間")}</Table.Head>
                  <Table.Head>{t("利用サービス")}</Table.Head>
                  <Table.Head>{t("JWKS キャッシュ上限")}</Table.Head>
                  <Table.Head>
                    <span className="sr-only">{t("操作")}</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row key={row.audience}>
                    <Table.Cell>
                      <strong className="breakable">{row.audience}</strong>
                      <small>{row.description || t("説明なし")}</small>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="tag mono">{row.algorithm}</span>
                    </Table.Cell>
                    <Table.Cell>
                      {t("{{value1}} 秒", { value1: row.token_lifetime_seconds })}
                    </Table.Cell>
                    <Table.Cell>
                      {clients.data?.grants.filter((g) => g.audience === row.audience).length ?? 0}
                    </Table.Cell>
                    <Table.Cell>
                      <Status tone={row.jwks_cache_seconds === null ? "warning" : "good"}>
                        {row.jwks_cache_seconds === null
                          ? t("未設定")
                          : t("{{value1}} 秒", { value1: row.jwks_cache_seconds })}
                      </Status>
                    </Table.Cell>
                    <Table.Cell>
                      {me.data?.role !== "viewer" && (
                        <Button
                          variant="ghost"
                          size="base"
                          shape="square"
                          aria-label={t("{{value1}} を編集", { value1: row.audience })}
                          onClick={() => setEditing(row)}
                        >
                          <Pencil size={16} />
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </TableScroll>
        )}
      </Panel>
      <Info>
        {t(
          "Audience は relying party 側の設定と完全に一致させてください。ES256 と鍵の自動ローテーションは、互換性の確認を記録した audience でだけ使えます。",
        )}
      </Info>
      {editing && (
        <AudienceEditor
          audience={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Page>
  );
}
function AudienceEditor({
  audience: a,
  onClose,
}: {
  audience: Audience | null;
  onClose: () => void;
}) {
  useLocale();
  const me = useMe(),
    secure = me.data?.role === "security-admin",
    task = useTask(),
    [name, setName] = useState(a?.audience ?? ""),
    [description, setDescription] = useState(a?.description ?? ""),
    [algorithm, setAlgorithm] = useState(a?.algorithm ?? "RS256"),
    [ttl, setTtl] = useState(a?.token_lifetime_seconds ?? 300),
    [esVerified, setEsVerified] = useState(!!a?.verified_for_es256),
    [exchangeVerified, setExchangeVerified] = useState(!!a?.exchange_verified),
    [mixedJwksVerified, setMixedJwksVerified] = useState(!!a?.mixed_jwks_verified),
    [verified, setVerified] = useState(a?.jwks_cache_seconds != null),
    [cache, setCache] = useState(a?.jwks_cache_seconds?.toString() ?? "");
  return (
    <Modal
      open
      onClose={onClose}
      title={a ? t("Audience を編集") : t("Audience を登録")}
      description={t("署名方式・有効期間の変更は、利用中のサービスの次回発行にも反映されます。")}
    >
      <Form
        onSubmit={() =>
          void task.run(async () => {
            const input = audienceCreateSchema.parse({
              audience: name,
              description,
              algorithm,
              tokenLifetimeSeconds: ttl,
              verifiedForEs256: esVerified,
              exchangeVerified,
              mixedJwksVerified,
              jwksCacheSeconds: verified ? Number(cache) : null,
            });
            await api("/audiences", {
              method: a ? "PATCH" : "POST",
              body: JSON.stringify({ ...input, ...(a ? { version: a.version } : {}) }),
            });
            await refresh();
            onClose();
          }, t("Audience を保存しました"))
        }
      >
        <div className="modal-body">
          <Notice error={task.error} />
          <Field label="Audience">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!!a}
              required
              maxLength={2048}
              placeholder="https://api.example.com"
            />
          </Field>
          <Field label={t("用途・説明")}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1024}
              placeholder={t("本番 API のサービス間認証")}
            />
          </Field>
          <div className="form-grid">
            <Field label={t("署名方式")}>
              <Select
                value={algorithm}
                onValueChange={(value) => {
                  setAlgorithm(value! as "RS256" | "ES256");
                  setEsVerified(false);
                  setExchangeVerified(false);
                  setMixedJwksVerified(false);
                  setVerified(false);
                }}
              >
                <Select.Option value="RS256">RS256</Select.Option>
                <Select.Option value="ES256">ES256</Select.Option>
              </Select>
            </Field>
            <Field label={t("有効期間（秒）")}>
              <Input
                type="number"
                min={1}
                max={300}
                value={ttl}
                onChange={(e) => setTtl(Number(e.target.value))}
                required
              />
            </Field>
          </div>
          {(algorithm === "ES256" || esVerified) && (
            <div className="check-label">
              <Checkbox
                disabled={!secure}
                checked={esVerified}
                onCheckedChange={setEsVerified}
                label={t("relying party で ES256 と新旧の公開鍵の混在を確認しました")}
              />
            </div>
          )}
          <fieldset className="verification-fields">
            <legend>{t("鍵ローテーション")}</legend>
            <div className="check-label">
              <Checkbox
                disabled={!secure}
                checked={exchangeVerified}
                onCheckedChange={setExchangeVerified}
                label={t("この署名方式で relying party での認証が成功することを確認しました")}
              />
            </div>
            <div className="check-label">
              <Checkbox
                disabled={!secure}
                checked={mixedJwksVerified}
                onCheckedChange={setMixedJwksVerified}
                label={t(
                  "新旧の公開鍵を同時に掲載しても relying party が受理することを確認しました",
                )}
              />
            </div>
            <p>{t("relying party の公開鍵キャッシュを確認してから設定してください。")}</p>
            <div className="check-label">
              <Checkbox
                disabled={!secure}
                checked={verified}
                onCheckedChange={setVerified}
                label={t("relying party の鍵更新とキャッシュ時間を確認しました")}
              />
            </div>
            {verified && (
              <>
                <Field label={t("確認したキャッシュ上限（秒）")}>
                  <Input
                    type="number"
                    min={0}
                    max={2592000}
                    disabled={!secure}
                    value={cache}
                    onChange={(e) => setCache(e.target.value)}
                    required
                  />
                </Field>
              </>
            )}
            {!secure && <small>{t("確認項目はセキュリティ管理者が変更できます。")}</small>}
          </fieldset>
          {a && (
            <Info>
              {t("この変更は同じ Audience を許可されたすべてのワークロードに適用されます。")}
            </Info>
          )}
        </div>
        <SaveBar busy={task.busy} onCancel={onClose} />
      </Form>
    </Modal>
  );
}

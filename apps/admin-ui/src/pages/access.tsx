import { t, useLocale } from "../i18n";
import { Table } from "@cloudflare/kumo/components/table";
import { Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "../components/select";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import {
  KeyIcon as KeyRound,
  LinkIcon as Link2,
  LinkBreakIcon as Link2Off,
  PencilSimpleIcon as Pencil,
  PlusIcon as Plus,
  ArrowCounterClockwiseIcon as RotateCcw,
  TrashIcon as Trash2,
  UserIcon as UserRound,
} from "@phosphor-icons/react";
import { api, date, highImpact, queryClient, recentAuthentication, roles, useMe } from "../api";
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
  Status,
  useTask,
  TableScroll,
} from "../components/console";

type Operator = {
  id: string;
  role: keyof typeof roles;
  enabled: number;
  version: number;
  created_at: number;
  provider_subject?: string | null;
};
export function Operators() {
  useLocale();
  const me = useMe(),
    query = useQuery({
      queryKey: ["operators"],
      queryFn: () => api<{ operators: Operator[] }>("/operators"),
    }),
    [editing, setEditing] = useState<Operator | "new" | null>(null),
    [removing, setRemoving] = useState<Operator | null>(null),
    [recovering, setRecovering] = useState<Operator | null>(null),
    [linking, setLinking] = useState<Operator | null>(null),
    [unlinking, setUnlinking] = useState<Operator | null>(null),
    [invitation, setInvitation] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["operators"] });
  if (me.data?.role !== "security-admin")
    return (
      <Page title={t("管理者")}>
        <Info>{t("このページにはセキュリティ管理者の権限が必要です。")}</Info>
      </Page>
    );
  return (
    <Page
      title={t("管理者")}
      action={
        <Button data-variant="primary" variant="primary" onClick={() => setEditing("new")}>
          <Plus size={17} />
          {t("管理者を招待")}
        </Button>
      }
    >
      <Panel>
        <Notice error={query.error} />
        {query.isPending ? (
          <Loading />
        ) : (
          <TableScroll>
            <Table className="data-table">
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("管理者")}</Table.Head>
                  <Table.Head>{t("権限")}</Table.Head>
                  <Table.Head>{t("状態")}</Table.Head>
                  <Table.Head>{t("登録日時")}</Table.Head>
                  <Table.Head>
                    <span className="sr-only">{t("操作")}</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {query.data?.operators.map((row) => (
                  <Table.Row key={row.id}>
                    <Table.Cell>
                      <div className="cell-title">
                        <span className="resource-icon">
                          <UserRound size={17} />
                        </span>
                        <div>
                          <strong>
                            {row.id === me.data?.id ? t("あなた") : `${row.id.slice(0, 8)}…`}
                          </strong>
                          <small className="mono">{row.id}</small>
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell>{roles[row.role]}</Table.Cell>
                    <Table.Cell>
                      <Status tone={row.enabled ? "good" : "neutral"}>
                        {row.enabled ? t("有効") : t("停止中")}
                      </Status>
                    </Table.Cell>
                    <Table.Cell className="muted nowrap">{date(row.created_at)}</Table.Cell>
                    <Table.Cell>
                      {row.id !== me.data?.id && (
                        <div className="row-actions">
                          <Button
                            size="base"
                            shape="square"
                            variant="ghost"
                            aria-label={t("{{value1}} の権限を編集", { value1: row.id })}
                            title={t("権限・状態")}
                            onClick={() => setEditing(row)}
                          >
                            <Pencil size={16} />
                          </Button>
                          {me.data?.provider === "passkey" ? (
                            <Button
                              size="base"
                              shape="square"
                              variant="ghost"
                              disabled={!row.enabled}
                              aria-label={t("{{value1}} のパスキーを復旧", { value1: row.id })}
                              title={t("再登録の招待")}
                              onClick={() => setRecovering(row)}
                            >
                              <RotateCcw size={16} />
                            </Button>
                          ) : (
                            <Button
                              size="base"
                              shape="square"
                              variant="ghost"
                              aria-label={t("{{value1}} の Access 連携を解除", { value1: row.id })}
                              title={t("Access 連携を解除")}
                              onClick={() => setUnlinking(row)}
                            >
                              <Link2Off size={16} />
                            </Button>
                          )}
                          {me.data?.provider === "cloudflare-access" && (
                            <Button
                              size="base"
                              shape="square"
                              variant="ghost"
                              aria-label={t("{{value1}} の Access 連携を設定", { value1: row.id })}
                              title={t("Access 連携を設定")}
                              onClick={() => setLinking(row)}
                            >
                              <Link2 size={16} />
                            </Button>
                          )}
                          <Button
                            size="base"
                            shape="square"
                            variant="ghost"
                            aria-label={t("{{value1}} を削除", { value1: row.id })}
                            title={t("管理者を削除")}
                            onClick={() => setRemoving(row)}
                          >
                            <Trash2 size={16} />
                          </Button>
                        </div>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </TableScroll>
        )}
      </Panel>
      <div className="permission-grid">
        {Object.entries(roles).map(([key, title]) => (
          <div key={key}>
            <h3>{title}</h3>
            <p>
              {key === "viewer"
                ? t("状態・設定・監査ログの閲覧。")
                : key === "operator"
                  ? t("ワークロードと audience の設定、鍵ローテーションの提案。")
                  : t("管理者の管理、検証記録、鍵ローテーションと自動化の設定。")}
            </p>
          </div>
        ))}
      </div>
      <Info>
        {t(
          "自分自身の権限変更と、最後の有効なセキュリティ管理者の停止・削除はできません。権限変更時は対象者の既存セッションを失効します。",
        )}
      </Info>
      {editing && (
        <OperatorEditor
          operator={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onInvitation={setInvitation}
        />
      )}
      {recovering && (
        <Recovery
          operator={recovering}
          onClose={() => setRecovering(null)}
          onInvitation={setInvitation}
        />
      )}
      {removing && (
        <Confirm
          title={t("管理者を削除しますか？")}
          description={t(
            "{{value1}} の認証情報・セッション・連携を削除します。操作履歴は保持します。",
            { value1: removing.id },
          )}
          label={t("管理者を削除")}
          successMessage={t("管理者を削除しました")}
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const headers = await highImpact("operator.delete");
            await api(`/operators/${removing.id}`, {
              method: "DELETE",
              headers,
              body: JSON.stringify({ version: removing.version }),
            });
            await refresh();
          }}
        />
      )}
      {linking && <AccessIdentity operator={linking} onClose={() => setLinking(null)} />}
      {unlinking && (
        <Confirm
          title={t("Access の連携を解除しますか？")}
          description={t("対象の管理者を停止し、Access アカウントとの紐付けを解除します。")}
          label={t("連携を解除")}
          successMessage={t("Access 連携を解除し、管理者を停止しました")}
          danger
          onClose={() => setUnlinking(null)}
          onConfirm={async () => {
            const headers = await highImpact("operator.update");
            await api(`/operators/${unlinking.id}/access-identity`, {
              method: "DELETE",
              headers,
              body: JSON.stringify({ version: unlinking.version }),
            });
            await refresh();
          }}
        />
      )}
      {invitation && (
        <Modal
          open
          onClose={() => setInvitation(null)}
          title={t("再登録用の招待を発行しました")}
          description={t(
            "有効期限は15分です。対象の管理者に安全な方法で渡してください。閉じると再表示できません。",
          )}
        >
          <div className="modal-body">
            <div className="secret-value">{invitation}</div>
            <CopyButton value={invitation} label={t("招待をコピー")} />
          </div>
          <div className="modal-footer">
            <Button data-variant="primary" variant="primary" onClick={() => setInvitation(null)}>
              {t("閉じる")}
            </Button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
function OperatorEditor({
  operator,
  onClose,
  onInvitation,
}: {
  operator: Operator | null;
  onClose: () => void;
  onInvitation: (s: string) => void;
}) {
  useLocale();
  const me = useMe(),
    task = useTask(),
    [role, setRole] = useState<keyof typeof roles>(operator?.role ?? "viewer"),
    [enabled, setEnabled] = useState(operator?.enabled !== 0),
    [subject, setSubject] = useState("");
  return (
    <Modal
      open
      title={operator ? t("管理者の権限を編集") : t("管理者を招待")}
      description={
        operator
          ? t("権限・状態の変更は、次のリクエストから適用されます。")
          : t("必要な操作に合わせて、最小限の権限を選んでください。")
      }
      onClose={onClose}
    >
      <Form
        onSubmit={() =>
          void task.run(async () => {
            const headers = await highImpact(operator ? "operator.update" : "operator.create");
            const result = await api<{ invitationToken?: string }>(
              operator ? `/operators/${operator.id}` : "/operators",
              {
                method: operator ? "PATCH" : "POST",
                headers,
                body: JSON.stringify(
                  operator
                    ? { version: operator.version, role, enabled }
                    : {
                        id: crypto.randomUUID(),
                        role,
                        ...(me.data?.provider === "cloudflare-access"
                          ? { providerSubject: subject }
                          : {}),
                      },
                ),
              },
            );
            await queryClient.invalidateQueries({ queryKey: ["operators"] });
            onClose();
            if (result.invitationToken) onInvitation(result.invitationToken);
          }, t("管理者を保存しました"))
        }
      >
        <div className="modal-body">
          <Notice error={task.error} />
          {operator && <p className="mono muted breakable">{operator.id}</p>}
          <Field label={t("権限")}>
            <Select
              items={roles}
              value={role}
              onValueChange={(value) => setRole(value! as keyof typeof roles)}
            >
              {Object.entries(roles).map(([id, label]) => (
                <Select.Option key={id} value={id}>
                  {label}
                </Select.Option>
              ))}
            </Select>
          </Field>
          {operator ? (
            <div className="check-label">
              <Checkbox
                checked={enabled}
                onCheckedChange={(checked) => setEnabled(checked)}
                label={<>{t("管理コンソールへのアクセスを有効にする")}</>}
              />
            </div>
          ) : me.data?.provider === "cloudflare-access" ? (
            <Field
              label={t("Access の Issuer と Subject")}
              hint={t("検証済みの iss と sub を | で区切ります。")}
            >
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="https://team.cloudflareaccess.com|subject"
                required
              />
            </Field>
          ) : (
            <Info>{t("一回限りの招待を発行し、パスキーの登録を案内します。")}</Info>
          )}
        </div>
        <SaveBar
          busy={task.busy}
          onCancel={onClose}
          label={operator ? t("権限を保存") : t("招待を発行")}
        />
      </Form>
    </Modal>
  );
}
function Recovery({
  operator,
  onClose,
  onInvitation,
}: {
  operator: Operator;
  onClose: () => void;
  onInvitation: (s: string) => void;
}) {
  useLocale();
  const [reason, setReason] = useState(""),
    [ack, setAck] = useState(false),
    task = useTask();
  return (
    <Modal
      open
      title={t("パスキーを再登録する")}
      description={t("本人確認を済ませてから、復旧用の招待を発行してください。")}
      onClose={onClose}
    >
      <Form
        onSubmit={() =>
          void task.run(async () => {
            const headers = await highImpact("operator.recover");
            const result = await api<{ invitationToken: string }>(
              `/operators/${operator.id}/recovery`,
              {
                method: "POST",
                headers,
                body: JSON.stringify({ version: operator.version, reason }),
              },
            );
            await queryClient.invalidateQueries({ queryKey: ["operators"] });
            onClose();
            onInvitation(result.invitationToken);
          })
        }
      >
        <div className="modal-body">
          <Info tone="warning">
            {t(
              "対象者の既存パスキーとセッションをすべて失効します。新しいパスキーの登録までログインできません。",
            )}
          </Info>
          <Field label={t("復旧の理由（監査ログに記録）")}>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={8}
              maxLength={1024}
              placeholder={t("本人確認の方法と、復旧が必要な理由")}
            />
          </Field>
          <div className="check-label">
            <Checkbox
              checked={ack}
              onCheckedChange={(checked) => setAck(checked)}
              required
              label={<>{t("対象者の本人確認を済ませました")}</>}
            />
          </div>
          <Notice error={task.error} />
        </div>
        <SaveBar
          busy={task.busy}
          onCancel={onClose}
          disabled={!ack}
          label={t("既存キーを失効して招待を発行")}
        />
      </Form>
    </Modal>
  );
}

type Passkey = {
  credential_id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
};
export function Passkeys() {
  useLocale();
  const query = useQuery({
      queryKey: ["passkeys"],
      queryFn: () => api<{ passkeys: Passkey[] }>("/passkeys"),
    }),
    task = useTask(),
    [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [removing, setRemoving] = useState<Passkey | null>(null);
  return (
    <Page
      title={t("自分のパスキー")}
      action={
        <Button data-variant="primary" variant="primary" onClick={() => setAdding(true)}>
          <Plus size={17} />
          {t("パスキーを追加")}
        </Button>
      }
    >
      <Notice error={task.error ?? query.error} />
      <Panel>
        {query.isPending ? (
          <Loading />
        ) : !query.data?.passkeys.length ? (
          <Empty title={t("パスキーがありません")} />
        ) : (
          <div className="credential-list">
            {query.data.passkeys.map((key) => (
              <div className="credential" key={key.credential_id}>
                <div className="credential-icon">
                  <KeyRound size={22} />
                </div>
                <div>
                  <h3>{key.name}</h3>
                  <p>
                    {t("登録 {{value1}} 最終利用 {{value2}}", {
                      value1: date(key.created_at),
                      value2: date(key.last_used_at),
                    })}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="base"
                  shape="square"
                  aria-label={t("{{value1}} を削除", { value1: key.name })}
                  disabled={query.data.passkeys.length <= 1}
                  onClick={() => setRemoving(key)}
                >
                  <Trash2 size={17} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <Info>
        {t(
          "予備のパスキーを登録しておくと、デバイスを失った場合にもログインできます。最後のパスキーは削除できません。",
        )}
      </Info>
      {adding && (
        <Modal
          open
          title={t("パスキーを追加")}
          description={t("デバイスを識別しやすい名前を付けてください。")}
          onClose={() => setAdding(false)}
        >
          <Form
            onSubmit={() =>
              void task.run(async () => {
                await recentAuthentication();
                const start = await api<{
                  challengeId: string;
                  options: Parameters<typeof startRegistration>[0]["optionsJSON"];
                }>("/passkeys/options", { method: "POST" });
                const response = await startRegistration({ optionsJSON: start.options });
                await api("/passkeys/verify", {
                  method: "POST",
                  body: JSON.stringify({ challengeId: start.challengeId, response, name }),
                });
                await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
                setAdding(false);
                setName("");
              }, t("パスキーを追加しました"))
            }
          >
            <div className="modal-body">
              <Field label={t("パスキーの名前")}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("仕事用のセキュリティキー")}
                  required
                  maxLength={80}
                />
              </Field>
              <Notice error={task.error} />
            </div>
            <SaveBar
              busy={task.busy}
              onCancel={() => setAdding(false)}
              label={t("デバイスに登録")}
            />
          </Form>
        </Modal>
      )}
      {removing && (
        <Confirm
          title={t("パスキーを削除しますか？")}
          description={t(
            "{{value1}} を削除し、既存セッションを失効します。残ったパスキーで再度ログインしてください。",
            { value1: removing.name },
          )}
          label={t("削除してログアウト")}
          successMessage={t("パスキーを削除しました")}
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await recentAuthentication();
            await api(`/passkeys/${encodeURIComponent(removing.credential_id)}`, {
              method: "DELETE",
            });
            queryClient.clear();
            window.location.assign(window.location.pathname);
          }}
        />
      )}
    </Page>
  );
}

function AccessIdentity({ operator, onClose }: { operator: Operator; onClose: () => void }) {
  useLocale();
  const [subject, setSubject] = useState(operator.provider_subject ?? ""),
    task = useTask();
  return (
    <Modal
      open
      title={t("Access アカウントを連携")}
      description={t(
        "対象の管理者を有効化し、登録した Access 主体だけがログインできるようにします。",
      )}
      onClose={onClose}
    >
      <Form
        onSubmit={() =>
          void task.run(async () => {
            const headers = await highImpact("operator.update");
            await api(`/operators/${operator.id}/access-identity`, {
              method: "PUT",
              headers,
              body: JSON.stringify({ version: operator.version, providerSubject: subject }),
            });
            await queryClient.invalidateQueries({ queryKey: ["operators"] });
            onClose();
          }, t("Access アカウントを連携しました"))
        }
      >
        <div className="modal-body">
          <Field label={t("Access の Issuer と Subject")}>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="https://team.cloudflareaccess.com|subject"
              required
              maxLength={512}
            />
          </Field>
          <Info>
            {t(
              "現在の連携は置き換わります。設定済みの Access team の Issuer と、本人確認済みの Subject を指定してください。",
            )}
          </Info>
          <Notice error={task.error} />
        </div>
        <SaveBar busy={task.busy} onCancel={onClose} label={t("連携して有効化")} />
      </Form>
    </Modal>
  );
}

import { t, locale } from "./i18n";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { startAuthentication } from "@simplewebauthn/browser";

export type Me = {
  id: string;
  role: "viewer" | "operator" | "security-admin";
  provider: "passkey" | "cloudflare-access";
  authenticatedAt: number;
  csrfToken: string;
};
export type StepUpAction =
  | "operator.create"
  | "operator.update"
  | "operator.delete"
  | "operator.recover"
  | "rotation.plan"
  | "rotation.approve"
  | "rotation.control"
  | "rotation.schedule"
  | "rotation.immediate";
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 15_000 }, mutations: { retry: false } },
});
const mounted = window.location.pathname.match(/^(.*?\/admin)(?:\/|$)/)?.[1];
export const basePath = mounted ?? "";
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const me = queryClient.getQueryData<Me>(["me"]);
  const response = await fetch(`${basePath}/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.method && init.method !== "GET" && me ? { "X-CSRF-Token": me.csrfToken } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me") });
}
export async function signIn() {
  const start = await api<{
    challengeId: string;
    options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
  }>("/auth/passkey/options");
  const response = await startAuthentication({ optionsJSON: start.options });
  await api("/auth/passkey/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId: start.challengeId, response }),
  });
  queryClient.setQueryData(["me"], await api<Me>("/me"));
}
export async function recentAuthentication() {
  const me = queryClient.getQueryData<Me>(["me"]);
  if (me?.provider === "passkey" && Date.now() - me.authenticatedAt >= 240_000) await signIn();
}
export async function highImpact(action: StepUpAction): Promise<HeadersInit | undefined> {
  const me = queryClient.getQueryData<Me>(["me"]);
  if (me?.provider === "passkey") {
    await recentAuthentication();
    return;
  }
  if (me?.provider !== "cloudflare-access") throw new Error("unauthorized");
  const popup = window.open("about:blank", "_blank", "popup,width=520,height=720");
  if (!popup) throw new Error("popup-blocked");
  popup.document.body.textContent = t("追加認証を開いています…");
  try {
    queryClient.setQueryData(["me"], await api<Me>("/me"));
    const proof = await api<{ challengeId: string; url: string }>("/access-step-up/challenges", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    const url = new URL(proof.url);
    if (url.protocol !== "https:" || url.origin === window.location.origin)
      throw new Error("invalid-step-up-url");
    popup.location.replace(url.href);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      const status = await api<{ completed: boolean }>(
        `/access-step-up/challenges/${proof.challengeId}`,
      );
      if (status.completed) {
        queryClient.setQueryData(["me"], await api<Me>("/me"));
        return { "X-Step-Up-Challenge": proof.challengeId };
      }
      if (popup.closed) break;
    }
    throw new Error("reauth-required");
  } finally {
    popup.close();
  }
}
export const messages: Record<string, string> = {
  get unauthorized() {
    return t("セッションが切れました。再度ログインしてください。");
  },
  get forbidden() {
    return t("この操作には管理権限が必要です。");
  },
  get "version-conflict"() {
    return t("ほかの管理者が更新しました。画面を更新し、最新の内容を確認してください。");
  },
  get "invalid-input"() {
    return t("入力内容を確認してください。");
  },
  get "invalid-request"() {
    return t("認証情報を更新してから、もう一度操作してください。");
  },
  get "reauth-required"() {
    return t("追加認証が必要です。もう一度操作してください。");
  },
  get "popup-blocked"() {
    return t("追加認証のポップアップを許可してください。");
  },
  get "last-security-admin"() {
    return t("最後の有効なセキュリティ管理者は停止・削除できません。");
  },
  get "last-passkey"() {
    return t("最後のパスキーは削除できません。別のパスキーを追加してください。");
  },
  get "self-change-forbidden"() {
    return t("自分自身の権限やアカウントは変更できません。別の管理者に依頼してください。");
  },
  get unavailable() {
    return t("サービスに接続できません。時間を置いてもう一度お試しください。");
  },
  get "es256-not-verified"() {
    return t("ES256 の互換性確認をセキュリティ管理者が記録してください。");
  },
  get "automatic-rotation-not-verified"() {
    return t("有効な署名鍵と、relying party での互換性とキャッシュの確認記録が必要です。");
  },
  get "rotation-unavailable"() {
    return t("Rotation Controller に接続できません。");
  },
  get "rate-limited"() {
    return t("サインインの試行回数が多すぎます。1分ほど待ってからもう一度お試しください。");
  },
  get "passkey-disabled"() {
    return t("この管理画面ではパスキー認証を使用していません。");
  },
  get "invalid-passkey"() {
    return t("パスキーを確認できませんでした。もう一度お試しください。");
  },
  get "invalid-invitation"() {
    return t(
      "招待・復旧用トークンが無効か期限切れです。管理者に新しいトークンを依頼してください。",
    );
  },
  get "operator-disabled"() {
    return t("この管理者アカウントは停止されています。");
  },
  get "challenge-used"() {
    return t("この認証要求は期限切れか使用済みです。もう一度お試しください。");
  },
  get "passkey-limit"() {
    return t("登録できるパスキーは10個までです。不要なパスキーを削除してから登録してください。");
  },
  get "schedule-date-invalid"() {
    return t("次回の実行日時は1分以上先に設定してください。");
  },
  get "proposal-approval-denied"() {
    return t("この提案は承認できません。提案者本人は承認できず、処理済みの提案も承認できません。");
  },
  get "rotation-control-denied"() {
    return t("現在のローテーションの状態では、この操作を実行できません。画面を更新してください。");
  },
  get "rotation-not-ready"() {
    return t(
      "新しい鍵が issuer にまだ完全にデプロイされていないか、公開 JWKS に掲載されていません。少し待ってからもう一度お試しください。",
    );
  },
  get "not-found"() {
    return t("対象が見つかりません。画面を更新してください。");
  },
};
export function errorText(error: unknown) {
  if (error instanceof Error)
    return (
      messages[error.message] ??
      (error.name === "NotAllowedError"
        ? t("パスキー操作がキャンセルされました。")
        : t("操作を完了できませんでした。入力と接続状態を確認してください。"))
    );
  return t("操作を完了できませんでした。");
}
export const date = (value: number | null | undefined) =>
  value
    ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(value)
    : t("未記録");
export const localInput = (value: number) => {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export const roles = {
  get viewer() {
    return t("閲覧者");
  },
  get operator() {
    return t("運用担当");
  },
  get "security-admin"() {
    return t("セキュリティ管理者");
  },
};

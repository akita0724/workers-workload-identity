import { t, useLocale } from "./i18n";
import { forwardRef, lazy, Suspense, useEffect, useState, type AnchorHTMLAttributes } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Navigate,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { startRegistration } from "@simplewebauthn/browser";
import {
  PulseIcon as Activity,
  ArrowRightIcon as ArrowRight,
  CaretRightIcon as ChevronRight,
  CodeIcon as Code2,
  GlobeIcon as Globe2,
  KeyIcon as KeyRound,
  SquaresFourIcon as LayoutDashboard,
  SignOutIcon as LogOut,
  ArrowsClockwiseIcon as RefreshCw,
  ShieldCheckIcon as ShieldCheck,
  UsersIcon as Users,
  XIcon,
} from "@phosphor-icons/react";
import { api, basePath, queryClient, roles, signIn, useMe } from "./api";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Feedback, Field, Loading, Notice, useTask } from "./components/console";
const Clients = lazy(() => import("./pages/policies").then((m) => ({ default: m.Clients })));
const Audiences = lazy(() => import("./pages/policies").then((m) => ({ default: m.Audiences })));
const OverviewPage = lazy(() =>
  import("./pages/overview").then((m) => ({ default: m.OverviewPage })),
);
const Operators = lazy(() => import("./pages/access").then((m) => ({ default: m.Operators })));
const Passkeys = lazy(() => import("./pages/access").then((m) => ({ default: m.Passkeys })));
const AuditLog = lazy(() => import("./pages/activity").then((m) => ({ default: m.AuditLog })));
const Keys = lazy(() => import("./pages/keys").then((m) => ({ default: m.Keys })));
import { Sidebar, useSidebar } from "@cloudflare/kumo/components/sidebar";

import { LinkProvider } from "@cloudflare/kumo/utils";

import { LanguageSelect } from "./components/language-select";
import "./style.css";

const AppLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  ({ href, ...props }, ref) =>
    href?.startsWith("/") ? (
      <Link to={href} {...props} ref={ref} />
    ) : (
      <a href={href} {...props} ref={ref} />
    ),
);

const navigation = [
  {
    to: "/",
    get label() {
      return t("概要");
    },
    icon: LayoutDashboard,
    get group() {
      return t("ワークロード認証");
    },
  },
  {
    to: "/clients",
    get label() {
      return t("ワークロード");
    },
    icon: Code2,
    get group() {
      return t("ワークロード認証");
    },
  },
  {
    to: "/audiences",
    get label() {
      return t("Audience");
    },
    icon: Globe2,
    get group() {
      return t("ワークロード認証");
    },
  },
  {
    to: "/keys",
    get label() {
      return t("署名鍵");
    },
    icon: KeyRound,
    get group() {
      return t("ワークロード認証");
    },
  },
  {
    to: "/audit",
    get label() {
      return t("監査ログ");
    },
    icon: Activity,
    get group() {
      return t("ワークロード認証");
    },
  },
  {
    to: "/operators",
    get label() {
      return t("管理者");
    },
    icon: Users,
    get group() {
      return t("アクセス管理");
    },
    admin: true,
  },
  {
    to: "/passkeys",
    get label() {
      return t("自分のパスキー");
    },
    icon: KeyRound,
    get group() {
      return t("アクセス管理");
    },
    passkey: true,
  },
] as const;
function Login() {
  const displayLocale = useLocale();
  useEffect(() => {
    document.title = `${t("管理コンソールにログイン")} | Workload Identity`;
  }, [displayLocale]);
  const [registering, setRegistering] = useState(false),
    [token, setToken] = useState(""),
    task = useTask();
  return (
    <main className="auth-page">
      <div className="auth-identity">
        <div className="brand">
          <span className="brand-symbol">
            <ShieldCheck size={23} />
          </span>
          <span>Workload Identity</span>
        </div>
      </div>
      <div className="auth-form">
        <div className="auth-box">
          <div className="auth-language">
            <LanguageSelect />
          </div>
          <span className="resource-icon">
            <KeyRound size={24} />
          </span>
          <h2>{registering ? t("パスキーを登録") : t("管理コンソールにログイン")}</h2>
          {registering && (
            <p>{t("招待・復旧用トークンを入力して、新しいパスキーを登録します。")}</p>
          )}
          <Notice error={task.error} />
          {registering ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void task.run(async () => {
                  const start = await api<{
                    challengeId: string;
                    options: Parameters<typeof startRegistration>[0]["optionsJSON"];
                  }>("/auth/passkey/register/options", {
                    method: "POST",
                    body: JSON.stringify({ invitationToken: token }),
                  });
                  const response = await startRegistration({ optionsJSON: start.options });
                  await api("/auth/passkey/register/verify", {
                    method: "POST",
                    body: JSON.stringify({
                      challengeId: start.challengeId,
                      invitationToken: token,
                      response,
                    }),
                  });
                  setToken("");
                  await queryClient.invalidateQueries({ queryKey: ["me"] });
                });
              }}
            >
              <Field label={t("招待・復旧用トークン")}>
                <Input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                  minLength={32}
                />
              </Field>
              <Button
                data-variant="primary"
                variant="primary"
                type="submit"
                className="full-width"
                disabled={task.busy}
              >
                {task.busy ? t("登録しています…") : t("パスキーを登録")}
                <ArrowRight size={16} />
              </Button>
            </form>
          ) : (
            <Button
              data-variant="primary"
              variant="primary"
              className="full-width"
              disabled={task.busy}
              onClick={() =>
                void task.run(async () => {
                  await signIn();
                  await queryClient.invalidateQueries({ queryKey: ["me"] });
                })
              }
            >
              <KeyRound size={18} />
              {task.busy ? t("本人確認しています…") : t("パスキーでログイン")}
            </Button>
          )}
          <Button
            variant="ghost"
            className="auth-alternative"
            onClick={() => {
              setRegistering(!registering);
              setToken("");
              task.clear();
            }}
          >
            {registering ? t("ログインに戻る") : t("招待・復旧から登録")}
            <ChevronRight size={15} />
          </Button>
        </div>
      </div>
    </main>
  );
}
function Shell() {
  useLocale();
  const me = useMe();
  if (me.isPending)
    return (
      <div className="boot">
        <ShieldCheck size={32} />
        <Loading />
      </div>
    );
  if (!me.data) return <Login />;
  return (
    <LinkProvider component={AppLink}>
      <Sidebar.Provider
        defaultOpen
        mobileBreakpoint={960}
        collapsible="offcanvas"
        className="console-layout"
        style={{ "--sidebar-width": "208px" } as React.CSSProperties}
      >
        <Dashboard />
      </Sidebar.Provider>
    </LinkProvider>
  );
}
function Dashboard() {
  useLocale();
  const me = useMe().data!,
    path = useRouterState({ select: (s) => s.location.pathname }),
    { setOpenMobile } = useSidebar(),
    task = useTask();
  const current =
    navigation.find((n) => `${basePath}${n.to}`.replace(/\/$/, "") === path.replace(/\/$/, "")) ??
    navigation[0];
  const nav = navigation.filter(
    (n) =>
      (!("admin" in n) || me.role === "security-admin") &&
      (!("passkey" in n) || me.provider === "passkey"),
  );
  useEffect(() => {
    document.title = `${current.label} | Workload Identity`;
  }, [current.label]);
  return (
    <>
      <a href="#main" className="skip-link">
        {t("本文へ移動")}
      </a>
      <header className="global-header">
        <div className="header-brand">
          <Sidebar.Trigger className="mobile-menu" aria-label={t("ナビゲーションを開く")} />
          <Link to="/" className="brand" aria-label="Workload Identity">
            <ShieldCheck size={28} weight="duotone" />
            <span className="brand-full">Workload Identity</span>
            <span className="brand-short" aria-hidden="true">
              Workload ID
            </span>
          </Link>
        </div>
        <div className="header-links">
          <LanguageSelect />

          <div className="session-profile">
            <span>{roles[me.role]}</span>
          </div>
          <Button
            variant="ghost"
            shape="square"
            aria-label={t("ログアウト")}
            title={t("ログアウト")}
            disabled={task.busy}
            onClick={() =>
              void task.run(async () => {
                await api("/logout", { method: "POST" });
                queryClient.clear();
                if (me.provider === "cloudflare-access")
                  window.location.assign("/cdn-cgi/access/logout");
                else window.location.reload();
              })
            }
          >
            <LogOut size={18} />
          </Button>
        </div>
      </header>
      <Sidebar
        className="console-sidebar"
        contentClassName="sidebar-content"
        aria-label={t("コンソールナビゲーション")}
      >
        <Sidebar.Header className="workspace-heading">
          <Button
            variant="ghost"
            shape="square"
            className="mobile-close"
            aria-label={t("ナビゲーションを閉じる")}
            onClick={() => setOpenMobile(false)}
          >
            <XIcon size={18} />
          </Button>
        </Sidebar.Header>
        <Sidebar.Content>
          <nav aria-label={t("メインナビゲーション")}>
            {[t("ワークロード認証"), t("アクセス管理")].map((group) => (
              <Sidebar.Group key={group}>
                <Sidebar.GroupLabel>{group}</Sidebar.GroupLabel>
                <Sidebar.Menu>
                  {nav
                    .filter((n) => n.group === group)
                    .map((item) => (
                      <Sidebar.MenuButton
                        key={item.to}
                        href={item.to}
                        active={current.to === item.to}
                        aria-current={current.to === item.to ? "page" : undefined}
                        icon={<item.icon size={16} />}
                        onClick={() => setOpenMobile(false)}
                        className="nav-link"
                      >
                        {item.label}
                      </Sidebar.MenuButton>
                    ))}
                </Sidebar.Menu>
              </Sidebar.Group>
            ))}
          </nav>
        </Sidebar.Content>
        <Sidebar.Footer className="sidebar-footer">
          <div className="security-note">
            <ShieldCheck size={18} />
            <span>
              {me.provider === "passkey" ? t("パスキーで保護") : t("Cloudflare Access で保護")}
            </span>
          </div>
        </Sidebar.Footer>
      </Sidebar>
      <div className="workspace">
        <div className="context-bar">
          <div className="breadcrumb">
            <span>Workload Identity</span>
            <ChevronRight size={14} />
            <strong>{current.label}</strong>
          </div>
          <div className="topbar-actions">
            <Button
              variant="ghost"
              shape="square"
              aria-label={t("最新の情報に更新")}
              title={t("最新の情報に更新")}
              loading={task.busy}
              onClick={() =>
                void task.run(async () => {
                  await queryClient.invalidateQueries();
                }, t("最新の情報に更新しました"))
              }
            >
              <RefreshCw size={17} />
            </Button>
          </div>
        </div>
        <main id="main" className="main-content" tabIndex={-1}>
          <Notice error={task.error} />
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </>
  );
}
function NotFound() {
  useLocale();
  return (
    <div className="empty">
      <h1>{t("ページが見つかりません")}</h1>
      <Link to="/">{t("概要へ戻る")}</Link>
    </div>
  );
}
const rootRoute = createRootRoute({ component: Shell });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/clients", component: Clients }),
  createRoute({ getParentRoute: () => rootRoute, path: "/audiences", component: Audiences }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/providers",
    component: () => <Navigate to="/audiences" replace />,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/keys", component: Keys }),
  createRoute({ getParentRoute: () => rootRoute, path: "/audit", component: AuditLog }),
  createRoute({ getParentRoute: () => rootRoute, path: "/operators", component: Operators }),
  createRoute({ getParentRoute: () => rootRoute, path: "/passkeys", component: Passkeys }),
]);
const router = createRouter({
  routeTree,
  basepath: basePath || "/",
  defaultNotFoundComponent: NotFound,
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Feedback>
      <RouterProvider router={router} />
    </Feedback>
  </QueryClientProvider>,
);

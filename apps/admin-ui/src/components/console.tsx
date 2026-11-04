import { t, useLocale } from "../i18n";
import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Empty as KumoEmpty } from "@cloudflare/kumo/components/empty";
import { Field as KumoField } from "@cloudflare/kumo/components/field";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import {
  CheckIcon as Check,
  CopyIcon as Copy,
  CircleNotchIcon as LoaderCircle,
  MagnifyingGlassIcon as Search,
  ShieldIcon as Shield,
  XIcon as X,
} from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { errorText } from "../api";

export function TableScroll({ children }: { children: ReactNode }) {
  useLocale();
  const container = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [children]);
  return (
    <div className="table-region">
      <div ref={container} className="data-scroll" tabIndex={overflowing ? 0 : undefined}>
        {children}
      </div>
    </div>
  );
}

export function Feedback({ children }: { children: ReactNode }) {
  useLocale();
  return <Toasty>{children}</Toasty>;
}
export function useTask() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    toasts = useKumoToastManager(),
    running = useRef(false);
  return {
    busy,
    error,
    clear: () => setError(null),
    async run(action: () => Promise<void>, message?: string) {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      try {
        await action();
        if (message) toasts.add({ title: message, variant: "success" });
      } catch (e) {
        setError(e);
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
  };
}
export function Page({
  title,
  description,
  action,
  aside,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  useLocale();
  return (
    <section className="page-layout">
      <div className="page">
        <div className="page-heading">
          <div>
            <h1>{title}</h1>
            {description && <p>{description}</p>}
          </div>
          {action && <div className="heading-actions">{action}</div>}
        </div>
        {children}
      </div>
      {aside && <aside className="page-aside">{aside}</aside>}
    </section>
  );
}
export function Panel({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  useLocale();
  return (
    <LayerCard className={`panel ${className}`}>
      {title && (
        <div className="panel-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </LayerCard>
  );
}
export function Notice({ error }: { error: unknown }) {
  useLocale();
  return error ? (
    <Banner variant="error" role="alert" className="notice" description={errorText(error)} />
  ) : null;
}
export function Info({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning";
}) {
  useLocale();
  return (
    <Banner
      variant={tone === "warning" ? "alert" : "default"}
      className="notice"
      description={children}
    />
  );
}
export function Status({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "good" | "warning" | "danger" | "neutral";
}) {
  useLocale();
  const variants = {
    good: "success",
    warning: "warning",
    danger: "error",
    neutral: "secondary",
  } as const;
  return (
    <Badge variant={variants[tone]} className={`status ${tone}`}>
      {children}
    </Badge>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  useLocale();
  return (
    <KumoEmpty
      icon={<Shield size={28} />}
      title={title}
      description={description}
      contents={action}
      className="empty"
    />
  );
}
export function Loading() {
  useLocale();
  return (
    <div className="loading" role="status">
      <Loader />
      {t("読み込んでいます")}
    </div>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = t("検索"),
}: {
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
}) {
  useLocale();
  return (
    <div className="search-box">
      <Search size={17} />
      <Input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  useLocale();
  return (
    <div className="field">
      <KumoField label={label} description={hint}>
        {isValidElement<{ "aria-label"?: string }>(children)
          ? cloneElement(children, { "aria-label": children.props["aria-label"] ?? label })
          : children}
      </KumoField>
    </div>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useLocale();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value, details) => {
        // Editing is dismissed explicitly or with Escape, never by a stray backdrop click.
        if (details.reason === "outside-press") return;
        if (!value) onClose();
      }}
    >
      <Dialog size={wide ? "xl" : "lg"} className="modal">
        <div className="modal-heading">
          <div>
            <Dialog.Title>{title}</Dialog.Title>
            {description && <Dialog.Description>{description}</Dialog.Description>}
          </div>
          <Button variant="ghost" shape="square" aria-label={t("閉じる")} onClick={onClose}>
            <X size={20} />
          </Button>
        </div>
        {children}
      </Dialog>
    </Dialog.Root>
  );
}
export function Form({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  useLocale();
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
export function SaveBar({
  busy,
  onCancel,
  label = t("変更を保存"),
  disabled = false,
}: {
  busy: boolean;
  onCancel: () => void;
  label?: string;
  disabled?: boolean;
}) {
  useLocale();
  return (
    <div className="modal-footer">
      <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
        {t("キャンセル")}
      </Button>
      <Button data-variant="primary" variant="primary" type="submit" disabled={busy || disabled}>
        {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{" "}
        {busy ? t("処理しています…") : label}
      </Button>
    </div>
  );
}
export function CopyButton({ value, label = t("コピー") }: { value: string; label?: string }) {
  useLocale();
  const [copied, setCopied] = useState(false),
    task = useTask();
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          void task.run(async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }, t("コピーしました"))
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t("コピー済み") : label}
      </Button>
      <Notice error={task.error} />
    </>
  );
}
export function Confirm({
  title,
  description,
  label = t("実行する"),
  successMessage,
  onClose,
  onConfirm,
  danger = false,
  disabled = false,
  children,
}: {
  title: string;
  description: string;
  label?: string;
  successMessage: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  danger?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  useLocale();
  const task = useTask();
  return (
    <Modal
      open
      onClose={() => {
        if (!task.busy) onClose();
      }}
      title={title}
      description={description}
    >
      <Form
        onSubmit={() => {
          if (disabled) return;
          void task.run(async () => {
            await onConfirm();
            onClose();
          }, successMessage);
        }}
      >
        <div className="modal-body">
          {children}
          <Notice error={task.error} />
        </div>
        <div className="modal-footer">
          <Button type="button" variant="outline" disabled={task.busy} onClick={onClose}>
            {t("キャンセル")}
          </Button>
          <Button
            type="submit"
            data-variant={danger ? "destructive" : "primary"}
            variant={danger ? "destructive" : "primary"}
            disabled={task.busy || disabled}
          >
            {task.busy ? t("処理しています…") : label}
          </Button>
        </div>
      </Form>
    </Modal>
  );
}

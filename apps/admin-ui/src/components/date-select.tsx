import { useState } from "react";
import { CalendarBlankIcon } from "@phosphor-icons/react";
import { DatePicker } from "@cloudflare/kumo/components/date-picker";
import { Popover } from "@cloudflare/kumo/components/popover";
import { Button } from "@cloudflare/kumo/components/button";
import { enUS, ja } from "date-fns/locale";
import { language, locale, t, useLocale } from "../i18n";

export function DateSelect({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const selected = value ? new Date(`${value}T12:00:00`) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={<Button variant="outline" className="date-select" aria-label={label} />}
      >
        <CalendarBlankIcon size={16} aria-hidden="true" />
        {selected
          ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(selected)
          : t("日付を選択")}
      </Popover.Trigger>
      <Popover.Content align="start" className="date-picker-popover">
        <DatePicker
          mode="single"
          showOutsideDays={false}
          selected={selected}
          defaultMonth={selected}
          locale={language() === "ja" ? ja : enUS}
          onChange={(date) => {
            if (!date) return;
            const local = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            onChange(local);
            setOpen(false);
          }}
        />
      </Popover.Content>
    </Popover>
  );
}

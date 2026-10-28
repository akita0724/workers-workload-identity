import { Select as KumoSelect } from "@cloudflare/kumo/components/select";
import type { ComponentProps, ReactNode } from "react";

// The console uses string-valued single selections. Keep Kumo's keyboard and
// form behavior while applying the same trigger and option treatment everywhere.
type SelectProps = Omit<
  ComponentProps<typeof KumoSelect<string>>,
  "value" | "onValueChange" | "multiple" | "items"
> & {
  items?: Record<string, ReactNode>;
  value: string;
  onValueChange: (value: string | null) => void;
};
function ConsoleSelect(props: SelectProps) {
  return <KumoSelect<string> {...props} />;
}
export const Select = Object.assign(ConsoleSelect, { Option: KumoSelect.Option });

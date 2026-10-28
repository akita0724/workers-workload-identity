import { GlobeIcon } from "@phosphor-icons/react";
import { Select } from "./select";
import { language, setLanguage, useLocale, t } from "../i18n";

export function LanguageSelect() {
  useLocale();
  return (
    <span className="language-control">
      <GlobeIcon size={16} aria-hidden="true" />
      <Select
        className="language-select"
        aria-label={t("表示言語")}
        value={language()}
        items={{ ja: "日本語", en: "English" }}
        align="end"
        onValueChange={(value) => {
          if (value === "ja" || value === "en") void setLanguage(value);
        }}
      >
        <Select.Option value="ja">
          <span lang="ja">日本語</span>
        </Select.Option>
        <Select.Option value="en">
          <span lang="en">English</span>
        </Select.Option>
      </Select>
    </span>
  );
}

import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import ja from "./locales/ja.json";
import en from "./locales/en.json";

export type Language = "ja" | "en";
export type MessageKey = keyof typeof ja;
export const languageStorageKey = "workload-identity.language";

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(languageStorageKey);
    if (saved === "ja" || saved === "en") return saved;
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  for (const preference of navigator.languages ?? [navigator.language]) {
    const language = preference.split("-")[0];
    if (language === "ja" || language === "en") return language;
  }
  return "ja";
}

void i18n.use(initReactI18next).init({
  resources: { ja: { translation: ja }, en: { translation: en } },
  lng: initialLanguage(),
  fallbackLng: "ja",
  supportedLngs: ["ja", "en"],
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false }, // React escapes rendered text.
  initAsync: false,
});

function applyLanguage(language: string) {
  document.documentElement.lang = language;
  try {
    localStorage.setItem(languageStorageKey, language);
  } catch {
    // The language still changes for this session when persistence is blocked.
  }
}
i18n.on("languageChanged", applyLanguage);
applyLanguage(i18n.language);

export const locale = () => (i18n.language === "en" ? "en-US" : "ja-JP");
export const language = (): Language => (i18n.language === "en" ? "en" : "ja");
export const setLanguage = (value: Language) => i18n.changeLanguage(value);
export const t = (key: MessageKey, values?: Record<string, unknown>): string => i18n.t(key, values);

/** Subscribe at component boundaries without remounting forms or clearing queries. */
export function useLocale() {
  useTranslation();
  return locale();
}

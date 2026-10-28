import { defineConfig } from "blume";

const repository = process.env.GITHUB_REPOSITORY ?? "akita0724/workers-workload-identity";
const [owner, name] = repository.split("/");
const origin = process.env.DOCS_SITE_ORIGIN ?? `https://${owner}.github.io`;

export default defineConfig({
  title: "workers-workload-identity",
  description: "Short-lived workload identity assertions for Cloudflare Workers",
  content: { root: "../../docs" },
  i18n: {
    defaultLocale: "en",
    fallbackLocale: null,
    locales: [
      {
        code: "en",
        label: "English",
        style:
          "Concise technical English. Preserve product names, API identifiers, and normative keywords. Use the terms defined in the glossary.",
      },
      {
        code: "ja",
        label: "日本語",
        style:
          "簡潔で自然な技術日本語。workload assertion、issuer、caller、relying party、audience などの製品用語は用語集の定義に従う。",
      },
    ],
  },
  seo: { og: { enabled: false } },
  deployment: {
    site: origin,
    ...(name.endsWith(".github.io") ? {} : { base: `/${name}` }),
  },
});

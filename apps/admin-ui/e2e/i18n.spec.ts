import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures";

const routes = [
  ["/", "Overview"],
  ["/clients", "Workloads"],
  ["/audiences", "Audiences"],
  ["/keys", "Signing key management and rotation"],
  ["/audit", "Audit log"],
  ["/operators", "Administrators"],
  ["/passkeys", "Registered passkeys"],
] as const;

async function switchLanguage(page: import("@playwright/test").Page, to: "English" | "日本語") {
  await page.getByRole("combobox", { name: /表示言語|Display language/ }).click();
  await page.getByRole("option", { name: to, exact: true }).click();
}

for (const width of [1440, 390, 320]) {
  test(`English pages are accessible and fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1040 });
    await mockApi(page);
    await page.goto("/");
    await switchLanguage(page, "English");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const [route, title] of routes) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: title, level: 1, exact: true })).toBeVisible();
      await expect(page.getByText("Loading", { exact: true })).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page).toHaveTitle(/Workload Identity/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const signOut = await page
        .getByRole("button", { name: "Sign out", exact: true })
        .boundingBox();
      expect(signOut!.x + signOut!.width).toBeLessThanOrEqual(width);
      const audit = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        audit.violations,
        `${route}: ${JSON.stringify(audit.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.html) })))}`,
      ).toEqual([]);
      // Descriptions and evidence are user data and must remain in their original language.
      const japanese = await page.locator("h1, h2, th, button, .nav-link").allTextContents();
      expect(japanese.filter((value) => /[\u3040-\u30ff\u3400-\u9fff]/.test(value))).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}

test("language changes preserve filters, update labels and dates, and persist", async ({
  page,
}) => {
  const { fixtures, mutations } = await mockApi(page);
  await page.goto("/clients");
  await page.getByRole("textbox", { name: "クライアント ID / Subject で検索" }).fill("billing");
  await switchLanguage(page, "English");
  await expect(page.getByRole("textbox", { name: "Search by client ID or subject" })).toHaveValue(
    "billing",
  );
  await expect(page.getByRole("combobox", { name: "Issuance status" })).toContainText(
    "All statuses",
  );
  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(fixtures["/clients"].clients[0].updated_at);
  await expect(page.getByRole("cell", { name: formatted, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Workloads", exact: true })).toBeVisible();
  await switchLanguage(page, "日本語");
  await expect(page.getByRole("heading", { name: "ワークロード", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  expect(mutations).toEqual([]);
});

test("English creation uses unchanged API fields and translated confirmation", async ({ page }) => {
  const { mutations } = await mockApi(page);
  await page.goto("/clients");
  await switchLanguage(page, "English");
  await page.getByRole("button", { name: "Add a workload", exact: true }).click();
  const dialog = page.locator('.modal[role="dialog"]');
  await dialog.getByLabel("Client ID", { exact: true }).fill("english-worker");
  await dialog.getByLabel("Subject", { exact: true }).fill("service:english");
  await dialog.getByRole("checkbox", { name: /https:\/\/api.example.com/ }).check();
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("Audiences to add", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Review and save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mutations[0]).toEqual({
    path: "/clients",
    method: "POST",
    body: {
      clientId: "english-worker",
      subject: "service:english",
      enabled: true,
      audiences: ["https://api.example.com"],
    },
    csrf: "browser-test-csrf",
  });
  await expect(page.getByText("Workload saved", { exact: true })).toBeVisible();
});

test("English authentication and API errors are localized", async ({ page }) => {
  await mockApi(page, { signedOut: true });
  await page.goto("/");
  await switchLanguage(page, "English");
  await expect(page.getByRole("heading", { name: "Sign in to the console" })).toBeVisible();
  await page
    .getByRole("button", { name: "Register with an invitation or recovery code", exact: true })
    .click();
  await expect(page.getByLabel("Invitation or recovery code", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await page.unrouteAll();
  await mockApi(page, { fail: "/clients" });
  await page.goto("/clients");
  await expect(page.getByRole("alert")).toContainText("Unable to connect to the service");
});

test("browser language is used when no preference is saved", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-GB" });
  const page = await context.newPage();
  await mockApi(page);
  await page.goto("http://127.0.0.1:5195/");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await context.close();
});

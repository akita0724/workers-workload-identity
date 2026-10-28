import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures";

const routes = [
  ["/", "概要"],
  ["/clients", "ワークロード"],
  ["/audiences", "Audience"],
  ["/keys", "署名鍵管理・ローテーション"],
  ["/audit", "監査ログ"],
  ["/operators", "管理者"],
  ["/passkeys", "登録済みパスキー"],
] as const;
for (const width of [1440, 390]) {
  test(`all pages are accessible and contained at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1040 });
    await mockApi(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const [path, title] of routes) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: title, level: 1, exact: true })).toBeVisible();
      await expect(page.getByText("読み込んでいます", { exact: true })).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const audit = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        audit.violations,
        `${path}: ${JSON.stringify(audit.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.html) })))}`,
      ).toEqual([]);
    }
    expect(errors).toEqual([]);
  });
}

test("workload creation reviews permissions before saving with CSRF", async ({ page }) => {
  const { mutations } = await mockApi(page);
  await page.goto("/clients");
  await page.getByRole("button", { name: "ワークロードを登録", exact: true }).click();
  const dialog = page.locator('.modal[role="dialog"]');
  await dialog.getByLabel("Client ID", { exact: true }).fill("new-worker");
  await dialog.getByLabel("Subject", { exact: true }).fill("service:new");
  await dialog.getByRole("checkbox", { name: /https:\/\/api.example.com/ }).check();
  await dialog.getByRole("button", { name: "変更内容を確認", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "変更内容を確認" })).toBeVisible();
  expect(mutations).toEqual([]);
  await dialog.getByRole("button", { name: "確認して保存" }).click();
  await expect(dialog).toHaveCount(0);
  expect(mutations).toEqual([
    {
      path: "/clients",
      method: "POST",
      body: {
        clientId: "new-worker",
        subject: "service:new",
        enabled: true,
        audiences: ["https://api.example.com"],
      },
      csrf: "browser-test-csrf",
    },
  ]);
  await expect(page.getByText("ワークロードを保存しました", { exact: true })).toBeVisible();
});

test("filters use keyboard-accessible Kumo selects", async ({ page }) => {
  await mockApi(page);
  await page.goto("/clients");
  const state = page.getByRole("combobox", { name: "発行の状態" });
  await expect(state).toContainText("すべての状態");
  await state.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "停止中", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "legacy-sync" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "billing-worker" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "クライアント ID / Subject で検索" }).fill("absent");
  await expect(page.getByText("該当するワークロードがありません")).toBeVisible();
});

test("dialog labels, select, focus containment and focus restoration", async ({ page }) => {
  await mockApi(page);
  await page.goto("/keys");
  const trigger = page.getByRole("button", { name: "鍵ローテーションを開始", exact: true });
  await trigger.click();
  const dialog = page.locator('.modal[role="dialog"]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "署名方式" }).click();
  await page.getByRole("option", { name: "ES256", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "署名方式" })).toContainText("ES256");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    await expect
      .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("mobile navigation traps focus, closes with Escape, and navigates", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "メニューを開く" });
  await trigger.click();
  await expect(page.getByRole("navigation", { name: "メインメニュー" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("link", { name: "ワークロード", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ワークロード", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "メインメニュー" })).not.toBeVisible();
});

test("viewer stays read-only and Access hides passkey navigation", async ({ page }) => {
  const { mutations } = await mockApi(page, { role: "viewer", provider: "cloudflare-access" });
  await page.goto("/clients");
  await expect(page.getByRole("button", { name: "ワークロードを登録" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "billing-worker を編集" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "管理者", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "登録済みパスキー" })).toHaveCount(0);
  await page.goto("/keys");
  await expect(page.getByRole("button", { name: "鍵ローテーションを開始" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "設定", exact: true })).toHaveCount(0);
  await page.goto("/operators");
  await expect(page.getByText("このページにはセキュリティ管理者の権限が必要です。")).toBeVisible();
  expect(mutations).toEqual([]);
});

test("login, invitation and error states are accessible", async ({ page }) => {
  await mockApi(page, { signedOut: true });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "コンソールにログイン" })).toBeVisible();
  await page.getByRole("button", { name: "招待・復旧コードで登録" }).click();
  await expect(page.getByLabel("招待・復旧コード")).toHaveAttribute("type", "password");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
});

test("network failures are visible and empty charts do not fabricate data", async ({ page }) => {
  await mockApi(page, { fail: "/clients", empty: true });
  await page.goto("/clients");
  await expect(page.getByRole("alert")).toContainText("サービスに接続できません");
  await page.goto("/");
  await expect(page.getByText("発行データがありません", { exact: true })).toBeVisible();
  await expect(page.locator(".chart svg")).toHaveCount(0);
});

test("mounted /admin routes remain within their deployment base", async ({ page }) => {
  await mockApi(page, { basePath: "/admin" });
  await page.goto("/admin/");
  await page.getByRole("link", { name: "ワークロード", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/clients$/);
  await expect(page.getByRole("heading", { name: "ワークロード", level: 1 })).toBeVisible();
});

test("audience settings retain safety checks without notes or verification records", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/audiences");
  await page.getByRole("button", { name: "sts.amazonaws.com を編集" }).click();
  const dialog = page.locator('.modal[role="dialog"]');
  await expect(dialog.getByText("互換性の検証記録", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("試験メモ（任意）")).toHaveCount(0);
  await expect(dialog.getByLabel("資料リンク（任意）")).toHaveCount(0);
  await expect(
    dialog.getByRole("checkbox", { name: "relying party の鍵更新とキャッシュ時間を確認しました" }),
  ).toBeChecked();
  await expect(dialog.getByLabel("確認したキャッシュ上限（秒）")).toHaveValue("60");
  await expect(dialog.getByLabel("確認日")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "再検証日を今日に更新" })).toHaveCount(0);
  for (const name of [
    "この署名方式で relying party での認証が成功することを確認しました",
    "新旧の公開鍵を同時に掲載しても relying party が受理することを確認しました",
  ]) {
    await expect(dialog.getByRole("checkbox", { name })).toBeChecked();
  }
  await dialog.getByRole("combobox", { name: "署名方式" }).click();
  await page.getByRole("option", { name: "ES256", exact: true }).click();
  await expect(
    dialog.getByRole("checkbox", {
      name: "relying party で ES256 と新旧の公開鍵の混在を確認しました",
    }),
  ).toBeVisible();
  for (const name of [
    "この署名方式で relying party での認証が成功することを確認しました",
    "新旧の公開鍵を同時に掲載しても relying party が受理することを確認しました",
    "relying party の鍵更新とキャッシュ時間を確認しました",
  ]) {
    await expect(dialog.getByRole("checkbox", { name })).not.toBeChecked();
  }
});

test("relying-party cache limit must be entered explicitly", async ({ page }) => {
  const { mutations } = await mockApi(page);
  await page.goto("/audiences");
  await page.getByRole("button", { name: "Audience を登録", exact: true }).click();
  const dialog = page.locator('.modal[role="dialog"]');
  await dialog.getByLabel("Audience", { exact: true }).fill("urn:cache-limit");
  await dialog
    .getByRole("checkbox", { name: "relying party の鍵更新とキャッシュ時間を確認しました" })
    .check();
  await expect(dialog.getByLabel("確認したキャッシュ上限（秒）")).toHaveValue("");
  await expect(dialog.getByLabel("確認日")).toHaveCount(0);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  expect(mutations).toEqual([]);
  await dialog.getByLabel("確認したキャッシュ上限（秒）").fill("120");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mutations[0].body).toMatchObject({ jwksCacheSeconds: 120 });
  expect(mutations[0].body).not.toHaveProperty("rotationVerifiedAt");
});

test("favicon assets are valid and resolve under the admin base path", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  for (const [selector, suffix] of [
    ['link[rel="icon"][type="image/svg+xml"]', "favicon.svg"],
    ['link[rel="icon"][sizes="any"]', "favicon.ico"],
  ] as const) {
    const href = await page.locator(selector).getAttribute("href");
    expect(new URL(href!, "https://example.test/admin/").pathname).toBe(`/admin/${suffix}`);
    const icon = await page.request.get(new URL(href!, page.url()).toString());
    expect(icon.status()).toBe(200);
    if (suffix.endsWith("svg")) expect(icon.headers()["content-type"]).toContain("image/svg+xml");
    else expect((await icon.body()).subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
  }
});

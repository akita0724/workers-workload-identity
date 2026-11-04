import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures";
import ja from "../src/locales/ja.json" with { type: "json" };

for (const language of ["ja", "en"] as const) {
  for (const width of [1440, 390]) {
    test(`${language} ${width}px: policy deletion requires confirmation and refreshes lists`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1040 });
      await page.addInitScript(
        (value) => localStorage.setItem("workload-identity.language", value),
        language,
      );
      const { fixtures, mutations } = await mockApi(page);
      const specialAudience = "https://api.example.com/path%2Fpart?scope=read#target";
      const unused = fixtures["/audiences"].audiences[2];
      unused.audience = specialAudience;
      unused.version = 7;
      fixtures["/clients"].clients[3].version = 4;
      fixtures["/clients"].grants.push({
        client_id: "legacy-sync",
        audience: "https://api.example.com",
      });
      const ja = language === "ja";
      const remove = (id: string) =>
        page.getByRole("button", { name: ja ? `${id} を削除` : `Delete ${id}`, exact: true });
      const dialog = page.locator('.modal[role="dialog"]');
      const confirm = () =>
        dialog.getByRole("button", { name: ja ? "削除" : "Delete", exact: true });
      const cancel = () =>
        dialog.getByRole("button", { name: ja ? "キャンセル" : "Cancel", exact: true });

      await page.goto("/clients");
      await expect(remove("billing-worker")).toBeDisabled();
      await remove("legacy-sync").click();
      await expect(dialog).toContainText("legacy-sync");
      await expect(dialog).toContainText(ja ? "監査履歴は残ります" : "Audit history is retained");
      expect(
        (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
          .violations,
      ).toEqual([]);
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await cancel().click();
      expect(mutations).toEqual([]);
      await expect(remove("legacy-sync")).toBeVisible();
      await remove("legacy-sync").click();
      await confirm().click();
      await expect(dialog).toHaveCount(0);
      await expect(remove("legacy-sync")).toHaveCount(0);
      expect(mutations).toEqual([
        {
          path: "/clients/legacy-sync",
          method: "DELETE",
          body: { version: 4 },
          csrf: "browser-test-csrf",
        },
      ]);
      expect(fixtures["/clients"].grants.some((grant) => grant.client_id === "legacy-sync")).toBe(
        false,
      );

      await page.goto("/audiences");
      await remove("https://api.example.com").click();
      await expect(dialog).toContainText("billing-worker");
      await expect(dialog).toContainText("edge-api");
      await expect(confirm()).toBeDisabled();
      await dialog.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
      await expect(dialog).toBeVisible();
      expect(mutations).toHaveLength(1);
      await cancel().click();

      await remove(specialAudience).click();
      await expect(dialog).toContainText(specialAudience);
      await expect(confirm()).toBeEnabled();
      await expect(dialog).toContainText(ja ? "発行済みの JWT" : "issued JWTs");
      expect(
        (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
          .violations,
      ).toEqual([]);
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await cancel().click();
      expect(mutations).toHaveLength(1);
      await remove(specialAudience).click();
      await confirm().click();
      await expect(dialog).toHaveCount(0);
      await expect(remove(specialAudience)).toHaveCount(0);
      expect(mutations[1]).toEqual({
        path: "/audiences",
        method: "DELETE",
        body: { audience: specialAudience, version: 7 },
        csrf: "browser-test-csrf",
      });
    });
  }
}

for (const role of ["viewer", "operator"]) {
  test(`${role} sees only permitted deletion actions`, async ({ page }) => {
    await mockApi(page, { role });
    for (const path of ["/clients", "/audiences"]) {
      await page.goto(path);
      const buttons = page.getByRole("button", { name: / を削除$/ });
      if (role === "viewer") await expect(buttons).toHaveCount(0);
      else await expect(buttons.first()).toBeVisible();
    }
  });
}

test("a disabled workload's grant still blocks audience deletion", async ({ page }) => {
  const { fixtures, mutations } = await mockApi(page);
  fixtures["/clients"].grants = [{ client_id: "legacy-sync", audience: "https://api.example.com" }];
  await page.goto("/audiences");
  await page.getByRole("button", { name: "https://api.example.com を削除", exact: true }).click();
  const dialog = page.locator('.modal[role="dialog"]');
  await expect(dialog).toContainText("legacy-sync");
  await expect(dialog.getByRole("button", { name: "削除", exact: true })).toBeDisabled();
  expect(mutations).toEqual([]);
});

for (const path of ["/clients", "/audiences"]) {
  test(`${path}: stale deletion remains open with a useful error and no success notification`, async ({
    page,
  }) => {
    const { mutations } = await mockApi(page);
    await page.route("**/api/**", async (route) => {
      if (route.request().method() === "DELETE")
        return route.fulfill({ status: 409, json: { error: "version-conflict" } });
      return route.fallback();
    });
    await page.goto(path);
    await page
      .getByRole("button", {
        name: path === "/clients" ? "legacy-sync を削除" : "sts.amazonaws.com を削除",
        exact: true,
      })
      .click();
    const dialog = page.locator('.modal[role="dialog"]');
    await dialog.getByRole("button", { name: "削除", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      ja["ほかの管理者が更新しました。画面を更新し、最新の内容を確認してください。"],
    );
    await expect(page.getByText(/^(ワークロード|Audience) を削除しました$/)).toHaveCount(0);
    expect(mutations).toEqual([]);
  });
}

test("audience deletion fails closed when workload references cannot be loaded", async ({
  page,
}) => {
  const { mutations } = await mockApi(page, { fail: "/clients" });
  await page.goto("/audiences");
  await page.getByRole("button", { name: "sts.amazonaws.com を削除", exact: true }).click();
  const dialog = page.locator('.modal[role="dialog"]');
  await expect(dialog).toContainText("サービスに接続できません");
  await expect(dialog.getByRole("button", { name: "削除", exact: true })).toBeDisabled();
  expect(mutations).toEqual([]);
});

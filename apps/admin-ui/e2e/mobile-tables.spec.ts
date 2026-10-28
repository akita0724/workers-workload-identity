import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

for (const width of [320, 390]) {
  test(`mobile actions and long table values remain readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { fixtures } = await mockApi(page);
    fixtures["/me"].id = "6163c7ff-64dc-453d-9efe-cf7c81324c32";
    fixtures["/operators"].operators[0].id = fixtures["/me"].id;
    fixtures["/clients"].clients[0].subject = `service:${"long-identity-".repeat(12)}`;
    await page.goto("/operators");
    const action = page.getByRole("button", { name: "管理者を招待", exact: true });
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThan(width * 0.8);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    const row = page.getByRole("row").filter({ hasText: "セキュリティ管理者" });
    const role = row.getByRole("cell").nth(1);
    await expect(role).toHaveText("セキュリティ管理者");
    expect(
      await role.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects().length;
      }),
    ).toBe(1);
    const scroll = page.locator(".data-scroll").filter({ has: row });
    await expect(scroll).toBeVisible();
    expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(scroll).toHaveAttribute("tabindex", "0");
    await scroll.focus();
    await expect(scroll).toBeFocused();
    await page.goto("/clients");
    const client = page.getByRole("row").filter({ hasText: "billing-worker" });
    await expect(client).toContainText("long-identity-");
    expect(await client.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const [path, label] of [
      ["/clients", "ワークロードを登録"],
      ["/audiences", "Audience を登録"],
      ["/keys", "鍵ローテーションを開始"],
      ["/passkeys", "新しいパスキーを登録"],
    ] as const) {
      await page.goto(path);
      const button = page.getByRole("button", { name: label, exact: true });
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox();
      expect(bounds!.width).toBeLessThan(width * 0.8);
    }
  });
}

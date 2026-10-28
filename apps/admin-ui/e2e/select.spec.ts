import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures";

for (const width of [320, 1440]) {
  test(`selection menus share clean options and keyboard behavior at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page);
    await page.goto("/clients");
    async function inspect(name: string, option: string) {
      const control = page.getByRole("combobox", { name, exact: true });
      await control.focus();
      await page.keyboard.press("Enter");
      const selected = page.getByRole("option", { name: option, exact: true });
      await expect(selected).toBeVisible();
      const style = await selected.evaluate((element) => {
        const css = getComputedStyle(element);
        return { border: css.borderTopWidth, height: element.getBoundingClientRect().height };
      });
      expect(style.border).toBe("0px");
      expect(style.height).toBeGreaterThanOrEqual(40);
      expect(
        (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
          .violations,
      ).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(control).toBeFocused();
    }
    await inspect("表示言語", "English");
    await inspect("発行の状態", "停止中");
    await page.goto("/operators");
    await page.getByRole("button", { name: "管理者を招待" }).click();
    await inspect("権限", "セキュリティ管理者");
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await page.goto("/keys");
    await page.getByRole("button", { name: "鍵ローテーションを開始" }).click();
    await inspect("署名方式", "ES256");
  });
}

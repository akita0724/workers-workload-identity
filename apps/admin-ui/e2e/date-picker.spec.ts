import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures";

for (const width of [1440, 320]) {
  test(`calendar filters and scheduled rotation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page);
    await page.goto("/audit");
    const start = page.getByRole("button", { name: "開始日", exact: true });
    await start.click();
    const calendar = page.getByRole("dialog");
    await expect(calendar).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
        .violations,
    ).toEqual([]);
    await calendar.getByRole("gridcell").getByRole("button", { name: /15/ }).first().click();
    await expect(start).not.toContainText("日付を選択");
    await page.getByRole("button", { name: "条件をクリア" }).click();
    await expect(start).toContainText("日付を選択");
    await page.goto("/keys");
    await page.getByRole("button", { name: "設定", exact: true }).first().click();
    const modal = page.locator('.modal[role="dialog"]');
    const date = modal.getByRole("button", { name: "次回の準備開始（端末のタイムゾーン）" });
    await date.click();
    const picker = page.getByRole("dialog").filter({ has: page.getByRole("grid") });
    await expect(picker).toBeVisible();
    await picker.getByRole("gridcell").getByRole("button", { name: /15/ }).first().click();
    await expect(date).toContainText("15");
    await modal.getByLabel("時刻", { exact: true }).fill("14:30");
    await expect(modal.getByLabel("時刻", { exact: true })).toHaveValue("14:30");
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
}

for (const width of [1440, 320]) {
  test(`English rotation schedule fields fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem("workload-identity.language", "en"));
    await mockApi(page);
    await page.goto("/keys");
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    const modal = page.locator('.modal[role="dialog"]');
    await expect(modal).toBeVisible();
    const interval = modal.getByLabel("Interval (days)");
    const date = modal.getByRole("button", { name: "Next preparation start (device time)" });
    const prepublish = modal.getByLabel("Prepublication (seconds)");
    const grace = modal.getByLabel("Old-key retention (grace period / seconds)");
    for (const control of [interval, date, prepublish, grace]) await expect(control).toBeVisible();
    const [intervalBox, prepublishBox, graceBox] = await Promise.all(
      [interval, prepublish, grace].map((control) => control.boundingBox()),
    );
    expect(prepublishBox!.x).toBeCloseTo(graceBox!.x, 0);
    expect(prepublishBox!.width).toBeCloseTo(graceBox!.width, 0);
    expect(intervalBox!.width).toBeCloseTo(prepublishBox!.width, 0);
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
}

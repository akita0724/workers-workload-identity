import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockApi } from "./fixtures";
import ja from "../src/locales/ja.json" with { type: "json" };
import en from "../src/locales/en.json" with { type: "json" };

for (const width of [1440, 390]) {
  for (const language of ["ja", "en"] as const) {
    test(`${language} ${width}px: forms and destructive confirmations are accessible`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 1040 });
      const { fixtures, mutations } = await mockApi(page);
      fixtures["/passkeys"].passkeys.push({
        ...fixtures["/passkeys"].passkeys[0],
        credential_id: "backup",
        name: "Backup key",
      });
      fixtures["/keys"].keys.runs[0].state = "published";
      fixtures["/keys"].keys.runs[0].workflowStatus = "running";
      Object.assign(fixtures["/keys"].keys, {
        proposals: [
          {
            id: "proposal-review",
            proposed_by: "ops@example.com",
            approved_by: null,
            plan_json: JSON.stringify({
              algorithm: "RS256",
              prepublishSeconds: 120,
              retirementGraceSeconds: 60,
            }),
            state: "proposed",
            created_at: Date.now(),
          },
        ],
      });
      await page.addInitScript(
        (value) => localStorage.setItem("workload-identity.language", value),
        language,
      );
      const messages = language === "ja" ? ja : en;
      const label = (key: keyof typeof ja) => messages[key];

      async function inspect(trigger: ReturnType<Page["getByRole"]>) {
        await trigger.click();
        const dialog = page.locator('.modal[role="dialog"]');
        await expect(dialog).toBeVisible();
        expect(
          await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
        await expect(dialog.getByRole("heading", { level: 2 })).toBeVisible();
        expect(
          (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
            .violations,
        ).toEqual([]);
        if (language === "en") {
          const content = await dialog
            .locator("h2, label:not(.selection label), legend, button, dt")
            .allTextContents();
          expect(content.filter((text) => /[\u3040-\u30ff\u3400-\u9fff]/.test(text))).toEqual([]);
        }
        await dialog.getByRole("button", { name: label("閉じる"), exact: true }).click();
        await expect(dialog).toHaveCount(0);
      }

      await page.goto("/clients");
      await inspect(page.getByRole("button", { name: label("ワークロードを登録"), exact: true }));
      await inspect(
        page.getByRole("button", {
          name:
            language === "ja"
              ? "billing-worker の接続設定"
              : "Connection settings for billing-worker",
          exact: true,
        }),
      );
      await inspect(
        page.getByRole("button", {
          name: language === "ja" ? "billing-worker を停止" : "Disable billing-worker",
          exact: true,
        }),
      );
      await page.goto("/audiences");
      await inspect(page.getByRole("button", { name: label("Audience を登録"), exact: true }));
      await page.goto("/keys");
      await inspect(
        page.getByRole("button", { name: label("鍵ローテーションを開始"), exact: true }),
      );
      await inspect(page.getByRole("button", { name: label("設定"), exact: true }).first());
      await inspect(page.getByRole("button", { name: /rs256-202610-prod-a4f82c/ }));
      await inspect(page.getByRole("button", { name: label("内容を確認"), exact: true }));
      await inspect(
        page.getByRole("button", {
          name:
            language === "ja"
              ? "rotation-202610-a4f82c を一時停止"
              : "Pause rotation-202610-a4f82c",
          exact: true,
        }),
      );
      await page
        .getByRole("button", { name: label("詳細"), exact: true })
        .first()
        .click();
      await inspect(
        page.getByRole("button", {
          name: label("待機期間を省略して即時ローテーション_action"),
          exact: true,
        }),
      );
      await page.goto("/operators");
      await inspect(page.getByRole("button", { name: label("管理者を招待"), exact: true }));
      await inspect(
        page.getByRole("button", {
          name:
            language === "ja"
              ? "ops@example.com の権限を編集"
              : "Edit permissions for ops@example.com",
          exact: true,
        }),
      );
      await inspect(
        page.getByRole("button", {
          name:
            language === "ja"
              ? "ops@example.com のパスキーを復旧"
              : "Recover passkeys for ops@example.com",
          exact: true,
        }),
      );
      await inspect(
        page.getByRole("button", {
          name: language === "ja" ? "ops@example.com を削除" : "Delete ops@example.com",
          exact: true,
        }),
      );
      await page.goto("/passkeys");
      await inspect(page.getByRole("button", { name: label("パスキーを追加"), exact: true }));
      await inspect(
        page.getByRole("button", {
          name: language === "ja" ? "MacBook Pro を削除" : "Delete MacBook Pro",
          exact: true,
        }),
      );
      await page.goto("/audit");
      await inspect(page.getByRole("button", { name: label("詳細"), exact: true }).first());
      expect(mutations).toEqual([]);
    });

    test(`${language} ${width}px: Access linking and unlinking dialogs are localized`, async ({
      page,
    }) => {
      const { mutations } = await mockApi(page, { provider: "cloudflare-access" });
      await page.addInitScript(
        (value) => localStorage.setItem("workload-identity.language", value),
        language,
      );
      await page.goto("/operators");
      for (const action of ["link", "unlink"]) {
        const name =
          action === "link"
            ? language === "ja"
              ? "ops@example.com の Access 連携を設定"
              : "Link an Access account to ops@example.com"
            : language === "ja"
              ? "ops@example.com の Access 連携を解除"
              : "Unlink the Access account for ops@example.com";
        await page.getByRole("button", { name, exact: true }).click();
        const dialog = page.locator('.modal[role="dialog"]');
        await expect(dialog).toBeVisible();
        expect(
          await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
        expect(
          (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
            .violations,
        ).toEqual([]);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      }
      expect(mutations).toEqual([]);
    });
  }
}

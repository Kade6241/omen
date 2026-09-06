import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { gotoDashboardRoute } from "./helpers/dashboardAuth";

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 768, 1440]) {
    test(`Quick Start remains readable and actionable at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      await page.route("**/api/settings/appearance", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          json: { ...(await response.json()), showQuickStartOnHome: true },
        });
      });
      await gotoDashboardRoute(page, "/home");

      const heading = page.getByRole("heading", { name: "Quick Start", exact: true });
      await expect(heading).toBeVisible();
      const panel = heading.locator("xpath=../../..");
      const docs = panel.getByRole("link", { name: "Full Docs" });
      await expect(docs).toBeVisible();
      await expect(docs).toHaveAttribute("href", "/docs");
      expect((await docs.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await docs.focus();
      await expect(docs).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(panel.getByRole("link", { name: "API Keys", exact: true })).toBeFocused();

      const steps = panel.locator("li");
      await expect(steps).toHaveCount(4);
      for (const step of await steps.all()) {
        expect(await step.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true
        );
      }
      // A self-hosted endpoint can be much longer than localhost. Exercise its
      // unbroken URL without depending on DNS or a particular test-server host.
      await steps
        .nth(2)
        .locator("p")
        .evaluate((element) => {
          element.textContent = `Set base URL to https://${"gateway".repeat(12)}.example.com/v1 in your IDE or API client.`;
        });
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true
      );
      expect(
        await steps.nth(2).evaluate((element) => element.scrollWidth <= element.clientWidth)
      ).toBe(true);

      await panel.evaluate((element) => element.setAttribute("data-quick-start-a11y", ""));
      const accessibility = await new AxeBuilder({ page })
        .include("[data-quick-start-a11y]")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    });
  }
}

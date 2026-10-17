/**
 * The core path in a real browser: a Carbon signs in, makes a doc, types in it (the service keeps every change), and
 * comments by selecting text.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { accountsFile, statePath } from "./support";

test.use({ storageState: statePath("carbon") });

test("write a doc and comment on it", async ({ page }) => {
  const accounts = JSON.parse(readFileSync(accountsFile, "utf8")) as Record<string, { email: string; id: string }>;
  void accounts;
  await page.goto("/library");
  // Continue as the Carbon on the hosted pages if the kit asks.
  if (!page.url().includes("/library")) {
    await page.getByRole("button", { name: /^Continue as / }).click();
    await page.waitForURL(/\/library$/);
  }
  await expect(page.getByRole("heading", { name: "My docs" })).toBeVisible();
  await page.getByRole("button", { name: "New doc" }).click();
  await page.waitForURL(/\/d\/d_/);
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible();
  await expect(page.getByText("Every change saved")).toBeVisible({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("Plan for the launch");
  await page.keyboard.press("Enter");
  await page.keyboard.type("The quick brown fox jumps over the lazy dog.");
  const docId = page.url().split("/d/")[1];
  // The service has it.
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/docs/${docId}/markdown`)).json()).markdown as string, { timeout: 15_000 })
    .toContain("The quick brown fox");
  // Viewing mode: selecting text opens the comment box straight away.
  await page.getByRole("button", { name: "Viewing", exact: true }).click();
  const sentence = editor.getByText("The quick brown fox jumps over the lazy dog.");
  await sentence.selectText();
  const box = page.getByRole("dialog", { name: "New comment" });
  await expect(box).toBeVisible();
  await page.keyboard.type("Is this the right sentence?");
  await page.keyboard.press("Enter");
  await expect(box).toBeHidden();
  await expect(page.locator("[data-thread-card]")).toHaveCount(1);
  await expect(page.locator(".comment-anchor")).toHaveCount(1);
  await page.screenshot({ path: "test-results/smoke-doc.png", fullPage: false });
});

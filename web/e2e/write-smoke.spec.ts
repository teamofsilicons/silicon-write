/**
 * The core path in a real browser: a Carbon signs in, makes a doc, types in it (the service keeps every change), and
 * comments by selecting text.
 */
import { expect, test } from "@playwright/test";
import { accountsSession, runAccounts, signIn } from "./support";
import { chooseDocMode, docSyncState } from "./doc-support";

test("write a doc and comment on it", async ({ browser }) => {
  const context = await accountsSession(browser, "carbon");
  try {
    const page = await context.newPage();
    await signIn(page, runAccounts().carbon.email, "/library");
    await expect(page.getByRole("heading", { name: "My docs" })).toBeVisible();
    await page.getByRole("button", { name: "New doc", exact: true }).first().click();
    await page.waitForURL(/\/d\/d_/);
    const editor = page.locator(".ProseMirror");
    await expect(editor).toBeVisible();
    await expect(docSyncState(page)).toHaveAccessibleName("Connected and synced", { timeout: 20_000 });
    await editor.click();
    await page.keyboard.type("Plan for the launch");
    await page.keyboard.press("Enter");
    await page.keyboard.type("The quick brown fox jumps over the lazy dog.");
    const docId = page.url().split("/d/")[1];
    // The service has it.
    await expect
      .poll(async () => (await (await page.request.get(`/api/v1/docs/${docId}/markdown`)).json()).markdown as string, { timeout: 15_000 })
      .toContain("The quick brown fox");
    // Reading mode: selecting text opens the comment box straight away.
    await chooseDocMode(page, "Reading");
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
  } finally {
    await context.close();
  }
});

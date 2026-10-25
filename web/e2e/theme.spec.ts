import { expect, test } from "@playwright/test";
import { accountsSession, runAccounts, sameOrigin, signIn } from "./support";
import { chooseDocMode, docSyncState, openComments } from "./doc-support";

test('saved appearance carries from the account menu into editing, comments, suggestions and share', async ({ browser }) => {
  const context = await accountsSession(browser, 'carbon', { reducedMotion: 'reduce' });
  const page = await context.newPage();
  await signIn(page, runAccounts().carbon.email, '/library');
  await page.getByRole('button', { name: /^Account menu, / }).click();
  await page.getByRole('group', { name: 'Theme' }).getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  const made = await page.request.post('/api/v1/docs', { headers: sameOrigin(), data: { title: 'Appearance check', markdown: 'A quiet place to write.' } });
  const { id } = await made.json();
  try {
    await page.goto(`/d/${id}`);
    await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await chooseDocMode(page, 'Suggesting');
    const editor = page.locator('.ProseMirror');
    await editor.click(); await page.keyboard.press('End'); await page.keyboard.type(' A new thought.');
    await openComments(page);
    await expect(page.getByRole('complementary', { name: 'All comments', exact: true })).toBeVisible();
    await page.screenshot({ path: '../.dev/production/dark-editor-local-20261026.png', fullPage: true });
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Share', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Appearance', exact: true }).hover();
    await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(editor).toContainText('A new thought.');
  } finally {
    await page.request.delete(`/api/v1/docs/${id}`, { headers: sameOrigin() });
    await context.close();
  }
});

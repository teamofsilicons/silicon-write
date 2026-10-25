import { expect, test, type Page } from "@playwright/test";
import { accountsSession, runAccounts, sameOrigin, signIn } from "./support";
import { chooseDocMode, docSyncState } from "./doc-support";

async function select(page: Page, text: string, end: boolean | "start" = false) {
  await page.locator('.ProseMirror').focus();
  const place = () => page.evaluate(({ text, end }) => {
    const root = document.querySelector('.ProseMirror')!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node.parentElement?.checkVisibility())) continue;
      const at = (node.textContent ?? '').indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + (end === true ? text.length : 0)); range.setEnd(node, at + (end === "start" ? 0 : text.length));
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      return;
    }
    throw new Error(`Visible text not found: ${text}`);
  }, { text, end });
  for (let attempt = 0; attempt < 5; attempt++) {
    await place();
    await page.waitForTimeout(150);
    const placed = await page.evaluate(({ text, end }) => {
      const selection = window.getSelection();
      if (!selection?.anchorNode || !selection.focusNode) return false;
      if (end === false) return selection.toString() === text;
      const value = selection.anchorNode.textContent ?? '';
      return selection.isCollapsed && value.includes(text) && selection.anchorOffset === value.indexOf(text) + (end === true ? text.length : 0);
    }, { text, end });
    if (placed) return;
  }
  throw new Error(`The editor did not retain the requested selection: ${text}`);
}
const visible = (page: Page) => page.locator('.ProseMirror').innerText();
async function markdown(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/docs/${id}/markdown`);
  expect(response.ok()).toBeTruthy(); return (await response.json()).markdown as string;
}

test('replacements are clean to type through, one before/after review, and accept or reject correctly', async ({ browser }) => {
  const context = await accountsSession(browser, 'carbon'); const page = await context.newPage();
  await signIn(page, runAccounts().carbon.email, '/library');
  const made = await page.request.post('/api/v1/docs', { headers: sameOrigin(), data: { title: 'Clean suggested writing', markdown: 'The original passage stays here.' } });
  const { id } = await made.json(); await page.goto(`/d/${id}`);
  await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');
  await chooseDocMode(page, 'Suggesting');
  await select(page, 'original passage'); await page.keyboard.insertText('better writing');
  await expect.poll(() => visible(page)).toBe('The better writing stays here.');
  await expect(page.locator('del.suggest-delete')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Review removed text' })).toHaveCount(1);
  // Editing our own proposed words must not create deleted duplicates or move the caret.
  for (let i = 0; i < 7; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('draft');
  await expect.poll(() => visible(page)).toBe('The better draft stays here.');
  await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');
  expect(await markdown(page, id)).toBe('The original passage stays here.\n');
  await page.getByRole('button', { name: 'Review removed text' }).click();
  const review = page.getByRole('dialog', { name: 'Review suggestion' });
  await expect(review).toContainText('Before'); await expect(review).toContainText('original passage');
  await expect(review).toContainText('After'); await expect(review).toContainText('better draft');
  await page.screenshot({ path: '../.dev/production/suggestion-clean-review.png' });
  await review.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect.poll(() => markdown(page, id)).toBe('The better draft stays here.\n');
  await select(page, 'better draft'); await page.keyboard.insertText('different words');
  await expect.poll(() => visible(page)).toBe('The different words stays here.');
  await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');
  await page.getByRole('button', { name: 'Review removed text' }).click();
  await review.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect.poll(() => visible(page)).toBe('The better draft stays here.');
  await page.reload(); await expect.poll(() => visible(page)).toBe('The better draft stays here.');
  await page.request.delete(`/api/v1/docs/${id}`, { headers: sameOrigin() }); await context.close();
});

test('repeated deletions skip hidden originals and paragraph splits retain proposed words', async ({ browser }) => {
  const context = await accountsSession(browser, 'carbon'); const page = await context.newPage();
  await signIn(page, runAccounts().carbon.email, '/library');
  const made = await page.request.post('/api/v1/docs', { headers: sameOrigin(), data: { title: 'Clean suggestion deletion', markdown: 'Hello world' } });
  const { id } = await made.json(); await page.goto(`/d/${id}`);
  await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced'); await chooseDocMode(page, 'Suggesting');
  await select(page, 'Hello', true); await page.keyboard.type(' new'); await page.keyboard.press('Enter');
  await expect.poll(() => visible(page)).toBe('Hello new\n\n world');
  await select(page, ' world', true);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('future');
  await expect.poll(() => visible(page)).toBe('Hello new\n\n future');
  await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');
  expect(await markdown(page, id)).toBe('Hello world\n');
  await page.request.delete(`/api/v1/docs/${id}`, { headers: sameOrigin() }); await context.close();
});

test('a suggester repeatedly deletes visible original characters, and the owner can restore them', async ({ browser }) => {
  const owner = await accountsSession(browser, 'carbon'), guest = await accountsSession(browser, 'friend');
  const page = await owner.newPage(), friend = await guest.newPage();
  await signIn(page, runAccounts().carbon.email, '/library');
  const made = await page.request.post('/api/v1/docs', { headers: sameOrigin(), data: { title: 'Repeated suggested deletions', markdown: 'Hello world' } });
  const { id } = await made.json();
  const shared = await page.request.post(`/api/v1/docs/${id}/sharing`, { headers: sameOrigin(), data: { to: runAccounts().friend.id, role: 'commenter' } });
  expect(shared.ok()).toBeTruthy();
  await signIn(friend, runAccounts().friend.email, `/d/${id}`);
  await expect(docSyncState(friend)).toHaveAccessibleName('Connected and synced');
  await select(friend, 'Hello world', true);
  for (let i = 0; i < 5; i++) await friend.keyboard.press('Backspace');
  await expect.poll(() => visible(friend)).toBe('Hello ');
  await expect(docSyncState(friend)).toHaveAccessibleName('Connected and synced');
  await select(friend, 'Hello', 'start');
  for (let i = 0; i < 2; i++) await friend.keyboard.press('Delete');
  await expect.poll(() => visible(friend)).toBe('llo ');
  await expect(docSyncState(friend)).toHaveAccessibleName('Connected and synced');
  expect(await markdown(page, id)).toBe('Hello world\n');
  const refused = await friend.request.post(`/api/v1/docs/${id}/suggestions/accept-all`, { headers: sameOrigin() });
  expect(refused.status()).toBe(403);
  const rejected = await page.request.post(`/api/v1/docs/${id}/suggestions/reject-all`, { headers: sameOrigin() });
  expect(rejected.ok()).toBeTruthy();
  await expect.poll(() => visible(friend)).toBe('Hello world');
  // The restricted role must also be able to format and split the proposed document.
  await select(friend, 'Hello'); await friend.keyboard.press('ControlOrMeta+b');
  await expect(friend.locator('.ProseMirror strong:visible')).toHaveText('Hello');
  await expect(docSyncState(friend)).toHaveAccessibleName('Connected and synced');
  expect(await markdown(page, id)).toBe('Hello world\n');
  const formatted = await page.request.post(`/api/v1/docs/${id}/suggestions/accept-all`, { headers: sameOrigin() });
  expect(formatted.ok()).toBeTruthy();
  await expect.poll(() => markdown(page, id)).toBe('**Hello** world\n');
  await select(friend, 'Hello', true); await friend.keyboard.press('Enter');
  await expect.poll(() => visible(friend)).toBe('Hello\n\n world');
  await expect(docSyncState(friend)).toHaveAccessibleName('Connected and synced');
  expect(await markdown(page, id)).toBe('**Hello** world\n');
  const joined = await page.request.post(`/api/v1/docs/${id}/suggestions/reject-all`, { headers: sameOrigin() });
  expect(joined.ok()).toBeTruthy();
  await expect.poll(() => visible(friend)).toBe('Hello world');
  await page.request.delete(`/api/v1/docs/${id}`, { headers: sameOrigin() }); await owner.close(); await guest.close();
});

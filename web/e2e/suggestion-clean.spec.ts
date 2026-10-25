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

/** Exercise browser dragging instead of installing a selection programmatically. */
async function dragPassage(page: Page, start: string, end = start, backwards = false) {
  const points = await page.locator('.ProseMirror').evaluate((root, { start, end }) => {
    const point = (text: string, last: boolean) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.checkVisibility()) continue;
        const at = node.textContent!.indexOf(text);
        if (at < 0) continue;
        const range = document.createRange();
        const offset = at + (last ? text.length - 1 : 0);
        range.setStart(node, offset); range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        return { x: last ? rect.right - .5 : rect.left + .5, y: rect.top + rect.height / 2 };
      }
      throw new Error(`Missing visible passage: ${text}`);
    };
    return [point(start, false), point(end, true)];
  }, { start, end });
  const [from, to] = backwards ? points.reverse() : points;
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 20 }); await page.mouse.up();
  await page.waitForTimeout(400);
}

test('mouse selection can overwrite passages and existing proposals without losing focus', async ({ browser }) => {
  const context = await accountsSession(browser, 'carbon'); const page = await context.newPage();
  await signIn(page, runAccounts().carbon.email, '/library');
  const made = await page.request.post('/api/v1/docs', { headers: sameOrigin(), data: { title: 'Mouse selection regression', markdown: 'The original passage stays here.\n\nAnother paragraph ends here.' } });
  const { id } = await made.json(); await page.goto(`/d/${id}`);
  await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');
  await chooseDocMode(page, 'Suggesting');
  const selected = () => page.evaluate(() => window.getSelection()?.toString());
  await dragPassage(page, 'original passage');
  await expect.poll(selected).toBe('original passage');
  await page.keyboard.type('better writing');
  await expect.poll(() => visible(page)).toBe('The better writing stays here.\n\nAnother paragraph ends here.');
  await dragPassage(page, 'better writing', 'better writing', true);
  await expect.poll(selected).toBe('better writing');
  await expect(page.locator('.ProseMirror')).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Review suggestion' })).toBeHidden();
  await page.keyboard.type('new draft');
  await expect.poll(() => visible(page)).toBe('The new draft stays here.\n\nAnother paragraph ends here.');
  await dragPassage(page, 'new draft', 'Another paragraph');
  await expect.poll(selected).toContain('Another paragraph');
  await expect(page.locator('.ProseMirror')).toBeFocused();
  await page.keyboard.type('joined');
  await expect.poll(() => visible(page)).toBe('The joined ends here.');
  await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');
  expect(await markdown(page, id)).toBe('The original passage stays here.\n\nAnother paragraph ends here.\n');
  const rejected = await page.request.post(`/api/v1/docs/${id}/suggestions/reject-all`, { headers: sameOrigin() });
  expect(rejected.ok()).toBeTruthy();
  await expect.poll(() => visible(page)).toBe('The original passage stays here.\n\nAnother paragraph ends here.');
  await page.request.delete(`/api/v1/docs/${id}`, { headers: sameOrigin() }); await context.close();
});

test('double-click selects a word for replacement in editing and suggesting; keyboard context menu still works', async ({ browser }) => {
  const context = await accountsSession(browser, 'carbon'); const page = await context.newPage();
  await signIn(page, runAccounts().carbon.email, '/library');
  const made = await page.request.post('/api/v1/docs', { headers: sameOrigin(), data: { title: 'Double-click word selection', markdown: 'Alpha beta gamma.' } });
  const { id } = await made.json();
  try {
    await page.goto(`/d/${id}`);
    await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');
    const editor = page.locator('.ProseMirror');
    const menu = page.getByRole('menu', { name: 'Text actions' });
    const replaceWord = async (word: string, replacement: string) => {
      await editor.locator('p').first().dblclick({ position: { x: 25, y: 12 } });
      await expect(menu).toBeHidden();
      await expect(page.getByRole('dialog', { name: 'Review suggestion' })).toBeHidden();
      await expect(editor).toBeFocused();
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(word);
      await page.keyboard.type(replacement);
      await expect.poll(() => visible(page)).toBe(`${replacement} beta gamma.`);
      await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');
    };
    await replaceWord('Alpha', 'Delta');
    await chooseDocMode(page, 'Suggesting');
    await replaceWord('Delta', 'Better');
    await replaceWord('Better', 'Clear');
    expect(await markdown(page, id)).toBe('Delta beta gamma.\n');
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor).toBeFocused();
  } finally {
    await page.request.delete(`/api/v1/docs/${id}`, { headers: sameOrigin() }); await context.close();
  }
});

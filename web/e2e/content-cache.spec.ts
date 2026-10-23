import { expect, test, type Browser, type Page } from "@playwright/test";
import { accountsSession, runAccounts, sameOrigin, signIn } from "./support";
import { docSyncState } from "./doc-support";
const KEY = "silicon-write:content-cache:v1";
async function openCachedDoc(browser: Browser) {
  const context = await accountsSession(browser, "carbon");
  const page = await context.newPage();
  await signIn(page, runAccounts().carbon.email, "/library");
  const response = await page.request.post("/api/v1/docs", { headers: sameOrigin(), data: { title: `Cached doc ${Date.now()}`, markdown: "# Saved heading\n\nRead **these words** immediately." } });
  expect(response.ok()).toBeTruthy();
  const doc = await response.json() as { id: string };
  await page.goto(`/d/${doc.id}`);
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText("Read these words immediately.");
  await expect(docSyncState(page)).toHaveAttribute("aria-label", "Connected and synced");
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), KEY)).toContain("Read ");
  return { context, page, doc };
}
async function preview(page: Page) {
  const preview = page.locator('[data-cached-content="true"]');
  await expect(preview).toContainText("Read these words immediately.");
  await expect(preview.locator("strong")).toHaveText("these words");
  await expect(preview.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toHaveCount(0);
  return preview;
}

test("reopening shows formatted cached text before the ticket arrives, then reconciles concurrent writing", async ({ browser }) => {
  const { context, page, doc } = await openCachedDoc(browser);
  const peer = await context.newPage();
  await peer.goto(`/d/${doc.id}`);
  await expect(peer.locator('.ProseMirror[contenteditable="true"]')).toContainText("these words");
  // Pause the new ticket without holding metadata or initial page authorization.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/docs/${doc.id}/live`, async route => { await gate; await route.continue(); });
  await page.reload();
  await preview(page);
  await page.screenshot({ path: "../.dev/production/content-cache-preview.png", fullPage: true });
  const peerEditor = peer.locator('.ProseMirror[contenteditable="true"]');
  await peerEditor.click(); await peerEditor.press("ControlOrMeta+End");
  await peerEditor.press("Enter"); await peerEditor.pressSequentially("A newer sentence from another writer.");
  await expect(docSyncState(peer)).toHaveAttribute("aria-label", "Connected and synced");
  release();
  await expect(page.locator('[data-cached-content="true"]')).toHaveCount(0);
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await expect(editor).toContainText("A newer sentence from another writer.");
  const markdown = await page.request.get(`/api/v1/docs/${doc.id}/markdown`);
  const text = await markdown.text();
  expect(text.match(/Read \*\*these words\*\* immediately\./g)).toHaveLength(1);
  expect(text).toContain("A newer sentence from another writer.");
  // The next saved preview includes both remote and our own acknowledged edits.
  await editor.click(); await editor.press("ControlOrMeta+End");
  await editor.press("Enter"); await editor.pressSequentially("My saved addition.");
  await expect(docSyncState(page)).toHaveAttribute("aria-label", "Connected and synced");
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), KEY)).toContain("My saved addition.");
  await page.unrouteAll({ behavior: "wait" });
  await page.route(`**/api/v1/docs/${doc.id}/live`, route => route.abort());
  await page.reload();
  await expect(page.locator('[data-cached-content="true"]')).toContainText("My saved addition.");
  await context.close();
});

test("cached content stays visible between the ticket and first WebSocket sync", async ({ browser }) => {
  const { context, page, doc } = await openCachedDoc(browser);
  let release: (() => void) | undefined;
  await page.routeWebSocket(`**/v1/live/${doc.id}**`, ws => {
    const server = ws.connectToServer();
    const queued: (string | Buffer)[] = [];
    let held = true;
    server.onMessage(message => { if (held) queued.push(message); else ws.send(message); });
    release = () => { held = false; for (const message of queued) ws.send(message); };
  });
  await page.reload();
  await preview(page);
  await expect.poll(() => Boolean(release)).toBe(true);
  // This is a fresh Yjs document: no cached snapshot was uploaded to the server.
  release!();
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText("Read these words immediately.");
  await expect(page.locator('[data-cached-content="true"]')).toHaveCount(0);
  await context.close();
});

test("refused live access removes the saved preview and its persisted content", async ({ browser }) => {
  const { context, page, doc } = await openCachedDoc(browser);
  await page.route(`**/api/v1/docs/${doc.id}/live`, route => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden", message: "Access removed" } }) }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "You no longer have access" })).toBeVisible();
  await expect(page.locator('[data-cached-content="true"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(({ key, id }) => {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null");
    return stored?.docs?.find((entry: { doc: { id: string } }) => entry.doc.id === id)?.content ?? null;
  }, { key: KEY, id: doc.id })).toBeNull();
  await context.close();
});


test("signing out clears saved document content", async ({ browser }) => {
  const { context, page } = await openCachedDoc(browser);
  await page.goto("/library");
  await page.getByRole("button", { name: /^Account menu, / }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/sign-in\?signed_out=1/);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBeNull();
  await context.close();
});

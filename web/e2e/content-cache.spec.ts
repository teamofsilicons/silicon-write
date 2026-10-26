import { expect, test, type Browser, type Page } from "@playwright/test";
import { accountsSession, runAccounts, sameOrigin, signIn } from "./support";
import { docSyncState } from "./doc-support";
const KEY = "silicon-write:content-cache:v1";
const passage = "Read these words when the editor is ready.";

async function newDoc(page: Page) {
  const response = await page.request.post("/api/v1/docs", { headers: sameOrigin(), data: { title: `Loading doc ${Date.now()}`, markdown: `# Saved heading\n\n${passage}` } });
  expect(response.ok()).toBeTruthy();
  return await response.json() as { id: string };
}
async function openDoc(browser: Browser) {
  const context = await accountsSession(browser, "carbon");
  const page = await context.newPage();
  await signIn(page, runAccounts().carbon.email, "/library");
  const doc = await newDoc(page);
  await page.goto(`/d/${doc.id}`);
  await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText(passage);
  await expect(docSyncState(page)).toHaveAttribute("aria-label", "Connected and synced");
  return { context, page, doc };
}
async function loading(page: Page) {
  await expect(page.getByRole("status", { name: "Loading content…", exact: true })).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText(passage, { exact: true })).not.toBeVisible();
  await expect(page.locator('[data-cached-content="true"]')).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Format", exact: true })).toBeDisabled();
}
async function ready(page: Page) {
  await expect(page.locator('.ProseMirror[aria-label="Doc"]')).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading content…", exact: true })).toHaveCount(0);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
  await page.locator('.ProseMirror[aria-label="Doc"]').getByText(passage, { exact: true }).click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Text actions" })).toBeVisible();
  await page.keyboard.press("Escape");
}

test("reload prepares live access on the server and keeps content loading until sync and controls are ready", async ({ browser }) => {
  const { context, page, doc } = await openDoc(browser);
  await page.evaluate(({ key, id }) => {
    const value = JSON.parse(localStorage.getItem(key)!);
    value.docs.find((entry: { doc: { id: string } }) => entry.doc.id === id).content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Stale cached body" }] }] };
    localStorage.setItem(key, JSON.stringify(value));
  }, { key: KEY, id: doc.id });
  let ticketRequests = 0;
  await page.route(`**/api/v1/docs/${doc.id}/live`, route => { ticketRequests++; return route.abort(); });
  let release: (() => void) | undefined;
  await page.routeWebSocket(`**/v1/live/${doc.id}**`, ws => {
    const server = ws.connectToServer();
    const queued: (string | Buffer)[] = [];
    let held = true;
    server.onMessage(message => { if (held) queued.push(message); else ws.send(message); });
    release = () => { held = false; for (const message of queued) ws.send(message); };
  });
  await page.reload();
  await loading(page);
  await expect(page.getByText("Stale cached body")).toHaveCount(0);
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.screenshot({ path: "../.dev/production/content-loading-light.png", fullPage: false });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await loading(page);
  await page.screenshot({ path: "../.dev/production/content-loading-dark-mobile.png", fullPage: false });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  release!();
  await ready(page);
  expect(ticketRequests).toBe(0);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).not.toContain("Stale cached body");
  await context.close();
});

test("opening a workspace doc keeps loading through its ticket request and reconciles concurrent writing", async ({ browser }) => {
  const { context, page } = await openDoc(browser);
  const doc = await newDoc(page);
  const peer = await context.newPage();
  await peer.goto(`/d/${doc.id}`);
  await expect(peer.locator('.ProseMirror[contenteditable="true"]')).toContainText(passage);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/docs/${doc.id}/live`, async route => { await gate; await route.continue(); });
  // Workspace tab navigation uses history without a new server page.
  await page.evaluate(id => window.history.pushState(null, "", `/d/${id}`), doc.id);
  await loading(page);
  const editor = peer.locator('.ProseMirror[contenteditable="true"]');
  await editor.click(); await editor.press("ControlOrMeta+End");
  await editor.press("Enter"); await editor.pressSequentially("A newer sentence from another writer.");
  await expect(docSyncState(peer)).toHaveAttribute("aria-label", "Connected and synced");
  release();
  await ready(page);
  await expect(page.locator('.ProseMirror[aria-label="Doc"]')).toContainText("A newer sentence from another writer.");
  const response = await page.request.get(`/api/v1/docs/${doc.id}/markdown`);
  const result = await response.json() as { markdown: string };
  expect(result.markdown.match(/Read these words/g)).toHaveLength(1);
  await context.close();
});

test("a refused workspace ticket ends loading and removes cached metadata", async ({ browser }) => {
  const { context, page } = await openDoc(browser);
  const doc = await newDoc(page);
  await page.route(`**/api/v1/docs/${doc.id}/live`, route => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "forbidden", message: "Access removed" } }) }));
  await page.evaluate(id => window.history.pushState(null, "", `/d/${id}`), doc.id);
  await expect(page.getByRole("heading", { name: "You no longer have access" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading content…", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(({ key, id }) => {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null");
    return stored?.docs?.some((entry: { doc: { id: string } }) => entry.doc.id === id) ?? false;
  }, { key: KEY, id: doc.id })).toBe(false);
  await context.close();
});

test("an expired prepared ticket falls back to a fresh browser request", async ({ browser }) => {
  const { context, page, doc } = await openDoc(browser);
  let requests = 0;
  page.on("request", request => { if (request.url().endsWith(`/api/v1/docs/${doc.id}/live`)) requests++; });
  await page.clock.setFixedTime(Date.now() + 11 * 60_000);
  await page.reload();
  await ready(page);
  expect(requests).toBeGreaterThan(0);
  await context.close();
});

test("signing out clears saved document metadata", async ({ browser }) => {
  const { context, page } = await openDoc(browser);
  await page.goto("/library");
  await page.getByRole("button", { name: /^Account menu, / }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/sign-in\?signed_out=1/);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBeNull();
  await context.close();
});

test("a commenter sees loading until Suggesting and its first context menu are ready", async ({ browser }) => {
  const { context, page, doc } = await openDoc(browser);
  const shared = await page.request.post(`/api/v1/docs/${doc.id}/sharing`, { headers: sameOrigin(), data: { to: runAccounts().friend.id, role: "commenter" } });
  expect(shared.ok()).toBeTruthy();
  const friend = await accountsSession(browser, "friend");
  const reader = await friend.newPage();
  await signIn(reader, runAccounts().friend.email, "/library");
  let release: (() => void) | undefined;
  await reader.routeWebSocket(`**/v1/live/${doc.id}**`, ws => {
    const server = ws.connectToServer();
    const queued: (string | Buffer)[] = [];
    let held = true;
    server.onMessage(message => { if (held) queued.push(message); else ws.send(message); });
    release = () => { held = false; for (const message of queued) ws.send(message); };
  });
  await reader.goto(`/d/${doc.id}`);
  await loading(reader);
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await ready(reader);
  await expect(reader.getByRole("button", { name: "Mode: Suggesting" })).toBeVisible();
  await friend.close();
  await context.close();
});

test("a failed connection ends loading with a retry action", async ({ browser }) => {
  const { context, page } = await openDoc(browser);
  const doc = await newDoc(page);
  await page.route(`**/api/v1/docs/${doc.id}/live`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "The doc could not connect." } }) }));
  await page.evaluate(id => window.history.pushState(null, "", `/d/${id}`), doc.id);
  await expect(page.getByRole("alert").filter({ hasText: "The doc could not connect." })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading content…", exact: true })).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await ready(page);
  await context.close();
});

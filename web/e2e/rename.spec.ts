import { expect, test, type Browser } from "@playwright/test";
import type { Doc } from "../lib/write/types";
import { accountsSession, runAccounts, sameOrigin, signIn } from "./support";
import { docSyncState } from "./doc-support";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

async function openTestDoc(browser: Browser) {
  const context = await accountsSession(browser, "carbon", { reducedMotion: "reduce" });
  const page = await context.newPage();
  await signIn(page, runAccounts().carbon.email, "/library");
  const response = await page.request.post("/api/v1/docs", {
    headers: sameOrigin(),
    data: { title: `Rename ${Date.now()}`, markdown: "Keep this writing.\n" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const doc = await response.json() as Doc;
  await page.goto(`/d/${doc.id}`);
  await expect(docSyncState(page)).toHaveAccessibleName("Connected and synced");
  return { context, page, doc };
}

test("rename finishes on PATCH confirmation while an older metadata read is held", async ({ browser }) => {
  const { context, page, doc } = await openTestDoc(browser);
  const releasePatch = gate(), releaseRead = gate();
  const patchCommitted = gate();
  let reads = 0;
  const endpoint = `/api/v1/docs/${doc.id}`;
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() === "PATCH") {
      // Let the real service persist and broadcast the rename, but hold its reply.
      const response = await route.fetch();
      patchCommitted.open();
      await releasePatch.promise;
      await route.fulfill({ response });
    } else if (route.request().method() === "GET") {
      const read = ++reads;
      const response = read > 1 ? await route.fetch() : null;
      await releaseRead.promise;
      // This represents a read that took its snapshot before the rename landed.
      if (response) await route.fulfill({ response });
      else await route.fulfill({ json: doc });
    } else await route.continue();
  });
  try {
    const title = "A name that saves promptly";
    await page.getByRole("button", { name: `Title: ${doc.title}`, exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
    await page.getByRole("textbox", { name: "Title", exact: true }).press("Enter");
    await patchCommitted.promise;
    await expect.poll(() => reads).toBeGreaterThan(0);
    const heading = page.getByRole("button", { name: `Title: ${title}`, exact: true });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveAttribute("aria-disabled", "true");

    releasePatch.open();
    // No metadata GET can complete yet. Confirmation and tab renaming must use PATCH.
    await expect(heading).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("status").filter({ hasText: "Title saved" })).toBeVisible();
    await expect(page.locator(`[role="tab"][data-doc-id="${doc.id}"]`)).toContainText(title);
    await expect(page).toHaveTitle(`${title} · Silicon Write`);
    await heading.click();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(title);
    await page.getByRole("textbox", { name: "Title", exact: true }).press("Escape");

    const staleReply = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === endpoint);
    releaseRead.open();
    await (await staleReply).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(heading).toBeVisible();
    await expect(page.locator(`[role="tab"][data-doc-id="${doc.id}"]`)).toContainText(title);
    await expect(page.locator(".ProseMirror")).toHaveText("Keep this writing.");
    const persisted = await page.request.get(endpoint);
    expect((await persisted.json() as Doc).title).toBe(title);
  } finally {
    releasePatch.open();
    releaseRead.open();
    await context.close();
  }
});

test("failed rename restores the saved title and keeps the attempted name for retry", async ({ browser }) => {
  const { context, page, doc } = await openTestDoc(browser);
  let fail = true;
  const endpoint = `/api/v1/docs/${doc.id}`;
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() === "PATCH" && fail) {
      fail = false;
      await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "The save is temporarily unavailable." } } });
    } else await route.continue();
  });
  try {
    const title = "Keep my attempted name";
    await page.getByRole("button", { name: `Title: ${doc.title}`, exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
    await page.getByRole("textbox", { name: "Title", exact: true }).press("Enter");
    await expect(page.getByRole("button", { name: `Title: ${doc.title}`, exact: true })).toBeVisible();
    await expect(page.getByText(`Couldn’t save “${title}”, so the last saved title is back.`, { exact: false })).toBeVisible();
    await expect(page.locator(`[role="tab"][data-doc-id="${doc.id}"]`)).toContainText(doc.title);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(title);
    await page.getByRole("textbox", { name: "Title", exact: true }).press("Enter");
    await expect(page.getByRole("button", { name: `Title: ${title}`, exact: true })).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.locator(`[role="tab"][data-doc-id="${doc.id}"]`)).toContainText(title);
    const persisted = await page.request.get(endpoint);
    expect((await persisted.json() as Doc).title).toBe(title);
  } finally {
    await context.close();
  }
});

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { accountsSession, BASE, runAccounts, sameOrigin, signIn } from "./support";

const ORIGINAL = "https://links.example.test/original";
const EDITED = "https://links.example.test/edited";

async function stubTargets(context: BrowserContext) {
  await context.route("https://links.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<p>Link destination</p>" }));
}

async function expectNewPage(page: Page, click: () => Promise<void>, target: string) {
  const current = page.url();
  const [opened] = await Promise.all([page.waitForEvent("popup"), click()]);
  await opened.waitForURL(target);
  expect(page.url()).toBe(current);
  await opened.close();
}

test("links open in a new page and their active chip can open, edit and unlink", async ({ browser }) => {
  const context = await accountsSession(browser, "carbon");
  let reader: BrowserContext | undefined;
  try {
    await stubTargets(context);
    const page = await context.newPage();
    await signIn(page, runAccounts().carbon.email, "/library");
    const created = await page.request.post("/api/v1/docs", {
      headers: sameOrigin(),
      data: { title: "Link interactions", markdown: `Before [destination](${ORIGINAL}) after.\n` },
    });
    expect(created.status()).toBe(201);
    const doc = await created.json() as { id: string };
    await page.goto(`/d/${doc.id}`);
    const editor = page.locator(".ProseMirror");
    const link = editor.getByRole("link", { name: "destination" });
    await expect(link).toBeVisible();

    // Command-click is a direct shortcut; a plain click keeps the document open and exposes the chip.
    await expectNewPage(page, () => link.click({ modifiers: ["Meta"] }), ORIGINAL);
    await link.click();
    const chip = page.getByRole("group", { name: "Link options" });
    await expect(chip).toBeVisible();
    await expectNewPage(page, () => chip.getByRole("link", { name: "Open link" }).click(), ORIGINAL);

    await chip.getByRole("button", { name: "Edit link" }).click();
    const address = page.getByRole("textbox", { name: "Link address" });
    await expect(address).toHaveValue(ORIGINAL);
    await address.fill(EDITED);
    await page.getByRole("button", { name: "Save link" }).click();
    await expect(link).toHaveAttribute("href", EDITED);
    await expect.poll(async () => (await (await page.request.get(`/api/v1/docs/${doc.id}/markdown`)).json() as { markdown: string }).markdown).toContain(`[destination](${EDITED})`);

    // A public reader can open the link without gaining edit or unlink actions.
    const publicAccess = await page.request.put(`/api/v1/docs/${doc.id}/public`, { headers: sameOrigin(), data: { access: "view" } });
    expect(publicAccess.status()).toBe(200);
    reader = await browser.newContext({ baseURL: BASE });
    await stubTargets(reader);
    const readPage = await reader.newPage();
    await readPage.goto(`/d/${doc.id}`);
    const readEditor = readPage.locator(".ProseMirror");
    await expect(readEditor).toHaveAttribute("contenteditable", "false");
    const readLink = readEditor.getByRole("link", { name: "destination" });
    await expect(readLink).toHaveAttribute("href", EDITED);
    await expectNewPage(readPage, () => readLink.click({ modifiers: ["Meta"] }), EDITED);
    await readLink.click();
    const readChip = readPage.getByRole("group", { name: "Link options" });
    await expect(readChip).toBeVisible();
    await expect(readChip.getByRole("button", { name: "Edit link" })).toHaveCount(0);
    await expect(readChip.getByRole("button", { name: "Unlink" })).toHaveCount(0);
    await expectNewPage(readPage, () => readChip.getByRole("link", { name: "Open link" }).click(), EDITED);

    await link.click();
    await chip.getByRole("button", { name: "Unlink" }).click();
    await expect(editor.getByText("destination")).toBeVisible();
    await expect(editor.getByRole("link", { name: "destination" })).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get(`/api/v1/docs/${doc.id}/markdown`)).json() as { markdown: string }).markdown).toContain("Before destination after.");
  } finally {
    await reader?.close();
    await context.close();
  }
});

test("link editing never applies to the wrong text after concurrent changes", async ({ browser }) => {
  const context = await accountsSession(browser, "carbon");
  try {
    const first = await context.newPage();
    await signIn(first, runAccounts().carbon.email, "/library");
    const created = await first.request.post("/api/v1/docs", {
      headers: sameOrigin(),
      data: { title: "Concurrent link editing", markdown: `Before [destination](${ORIGINAL}) after.\n` },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json() as { id: string };
    await first.goto(`/d/${id}`);
    const second = await context.newPage();
    await second.goto(`/d/${id}`);
    const firstEditor = first.locator(".ProseMirror");
    const secondEditor = second.locator(".ProseMirror");
    await expect(firstEditor.getByRole("link", { name: "destination" })).toBeVisible();
    await expect(secondEditor.getByRole("link", { name: "destination" })).toBeVisible();

    await firstEditor.getByRole("link", { name: "destination" }).click();
    await first.getByRole("button", { name: "Edit link" }).click();
    const input = first.getByRole("textbox", { name: "Link address" });
    await input.fill(EDITED);

    // Another tab inserts before the link while the address field has focus.
    await secondEditor.locator("p").first().click();
    await second.keyboard.press("Home");
    await second.keyboard.type("Prefix ");
    await expect(firstEditor).toContainText(/Prefix .*Before destination after\./);
    // If the update cannot be mapped reliably, the chip closes; reopen it on
    // the current link before saving rather than applying a stale selection.
    const save = first.getByRole("button", { name: "Save link" });
    if (!(await save.isVisible())) {
      await firstEditor.getByRole("link", { name: "destination" }).click();
      await first.getByRole("button", { name: "Edit link" }).click();
      await input.fill(EDITED);
    }
    await first.getByRole("button", { name: "Save link" }).click();
    await expect(firstEditor.getByRole("link", { name: "destination" })).toHaveAttribute("href", EDITED);
    await expect.poll(async () => (await (await first.request.get(`/api/v1/docs/${id}/markdown`)).json() as { markdown: string }).markdown).toContain(`Prefix Before [destination](${EDITED}) after.`);

    await firstEditor.getByRole("link", { name: "destination" }).click();
    await first.getByRole("button", { name: "Edit link" }).click();
    await expect(secondEditor.getByRole("link", { name: "destination" })).toHaveAttribute("href", EDITED);
    await secondEditor.getByRole("link", { name: "destination" }).dblclick();
    await second.keyboard.press("Backspace");
    await expect(firstEditor.getByRole("link", { name: "destination" })).toHaveCount(0);
    await expect(first.getByRole("group", { name: "Link options" })).toHaveCount(0);
    await expect.poll(async () => (await (await first.request.get(`/api/v1/docs/${id}/markdown`)).json() as { markdown: string }).markdown).toContain("Prefix Before after.");
  } finally {
    await context.close();
  }
});

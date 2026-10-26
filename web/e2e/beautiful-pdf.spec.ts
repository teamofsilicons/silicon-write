import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { accountsSession, runAccounts, sameOrigin, signIn } from "./support";

const output = "../.dev/beautiful-pdf";
async function exportDialog(page: Page) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Download as", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Beautiful PDF…", exact: true }).click();
  return page.getByRole("dialog", { name: "Beautiful PDF", exact: true });
}

async function pdfText(bytes: Uint8Array) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const pdf = await loading.promise;
  const text: string[] = [];
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index);
    text.push((await page.getTextContent()).items.map(item => "str" in item ? item.str : "").join(" "));
  }
  const pages = pdf.numPages;
  await loading.destroy();
  return { text: text.join(" "), pages };
}

test("Beautiful PDF downloads Write-styled light and dark pages, defaults to the current theme and includes recent edits", async ({ browser }) => {
  mkdirSync(output, { recursive: true });
  const owner = await accountsSession(browser, "carbon");
  const page = await owner.newPage();
  await signIn(page, runAccounts().carbon.email, "/library");
  const made = await page.request.post("/api/v1/docs", { headers: sameOrigin(), data: { title: "A little room to think — Write" } });
  expect(made.ok()).toBeTruthy();
  const { id } = await made.json() as { id: string };
  try {
    const image = await page.request.post(`/api/v1/docs/${id}/assets`, { headers: sameOrigin(), multipart: { file: {
      name: "landscape.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="230" viewBox="0 0 1000 230"><rect width="1000" height="230" fill="#c5d6eb"/><circle cx="820" cy="60" r="32" fill="#f7edca"/><path d="M0 200 L250 45 L520 210 L750 85 L1000 210 V230 H0Z" fill="#748eac"/><path d="M0 210 L380 130 L700 230 H0Z" fill="#3f5675"/></svg>'),
    } } });
    expect(image.ok()).toBeTruthy();
    const { url } = await image.json() as { url: string };
    const markdown = [
      "# Space for the idea", "A page should give an idea room to breathe. **A clear thought**, a quiet margin, and a little space between paragraphs make it easier to read.",
      "> Good writing begins with noticing. The page should help you stay with the thought.",
      `![A quiet landscape](${url})`,
      "## Details that stay with you", "- First, a generous reading rhythm.\n- Then, a useful [reference](https://example.com).\n- Finally, room for the next thought.",
      "| Element | Treatment |\n| --- | --- |\n| Title | Hedvig Letters Serif |\n| Body | BDO Grotesk |\n| Spacing | The same calm rhythm as Write |",
      "- [x] Keep the typography\n- [ ] Choose an appearance",
      "A small equation: $E = mc^2$. A footnote belongs here.[^note]",
      "```javascript\nconst page = { theme: 'light', space: 'generous' };\n// A very long line should wrap inside the page instead of being clipped at the right edge: abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789\n```",
      ...Array.from({ length: 8 }, (_, index) => `## A thought for page ${index + 1}\n\nThe shape of the page is part of the writing. Clear type, quiet colors and generous gaps help each paragraph find its place. This passage continues the document to check how headings, paragraphs and page numbers travel across a page break.\n\nThe export should feel like the document you were reading. Words remain selectable, links remain useful, and every page follows the appearance you chose.`),
      "[^note]: Footnotes and their references travel with the document.",
    ].join("\n\n");
    expect((await page.request.put(`/api/v1/docs/${id}/markdown`, { headers: sameOrigin(), data: { markdown } })).ok()).toBeTruthy();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => localStorage.setItem("write.theme", "system"));
    await page.goto(`/d/${id}`);
    await expect(page.locator(".ProseMirror")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator(".ProseMirror").focus();
    await page.locator(".ProseMirror").evaluate(root => {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("A last-minute thought, saved before the download.");
    const dialog = await exportDialog(page);
    await expect(dialog.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
    await dialog.getByRole("radio", { name: "Light", exact: true }).check();
    await page.screenshot({ path: `${output}/dialog.png` });
    const lightDownload = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download PDF", exact: true }).click();
    const light = await lightDownload;
    expect(light.suggestedFilename()).toBe("A little room to think — Write.pdf");
    await light.saveAs(`${output}/light.pdf`);
    const lightPdf = await pdfText(readFileSync(`${output}/light.pdf`));
    expect(lightPdf.pages).toBeGreaterThan(2);
    expect(lightPdf.text).toContain("A last-minute thought, saved before the download.");
    expect(lightPdf.text).toContain("Footnotes and their references travel");
    expect(lightPdf.text).toContain("Hedvig Letters Serif");
    await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("write.theme"))).toBe("system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const again = await exportDialog(page);
    await expect(again.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
    const darkDownload = page.waitForEvent("download");
    await again.getByRole("button", { name: "Download PDF", exact: true }).click();
    await (await darkDownload).saveAs(`${output}/dark.pdf`);
    const darkPdf = await pdfText(readFileSync(`${output}/dark.pdf`));
    expect(darkPdf.pages).toBe(lightPdf.pages);
    expect(darkPdf.text).toBe(lightPdf.text);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const lightDefault = await exportDialog(page);
    await expect(lightDefault.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/dialog-mobile.png` });
    await expect(lightDefault.getByRole("button", { name: "Download PDF", exact: true })).toBeInViewport();
    await lightDefault.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    await page.request.delete(`/api/v1/docs/${id}`, { headers: sameOrigin() });
    await owner.close();
  }
});

test("Beautiful PDF keeps private docs and email-gated downloads protected", async ({ browser }) => {
  const owner = await accountsSession(browser, "carbon");
  const page = await owner.newPage();
  await signIn(page, runAccounts().carbon.email, "/library");
  const made = await page.request.post("/api/v1/docs", { headers: sameOrigin(), data: { title: "Access-controlled PDF", markdown: "Only an authorized reader can export these words." } });
  const { id } = await made.json() as { id: string };
  const anon = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  const path = `/api/v1/docs/${id}/beautiful-pdf?theme=dark`;
  try {
    expect((await anon.request.get(path)).ok()).toBe(false);
    expect((await owner.request.get(path.replace("dark", "unknown"))).status()).toBe(400);
    expect((await owner.request.put(`/api/v1/docs/${id}/public`, { headers: sameOrigin(), data: { access: "view", require_email: true } })).ok()).toBe(true);
    const denied = await anon.request.get(path);
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error.code).toBe("email_required");
    expect((await anon.request.post(`/api/v1/docs/${id}/visits`, { headers: sameOrigin(), data: { email: "pdf-reader@example.test" } })).ok()).toBe(true);
    const allowed = await anon.request.get(path);
    expect(allowed.status()).toBe(200);
    expect(allowed.headers()["content-type"]).toBe("application/pdf");
    expect(allowed.headers()["cache-control"]).toContain("no-store");
    const bytes = await allowed.body();
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await pdfText(bytes)).text).toContain("Only an authorized reader");
    mkdirSync(output, { recursive: true });
    writeFileSync(`${output}/email-grant.pdf`, bytes);
    expect((await owner.request.put(`/api/v1/docs/${id}/public`, { headers: sameOrigin(), data: { access: "none" } })).ok()).toBe(true);
    expect((await anon.request.get(path)).ok()).toBe(false);
  } finally {
    await page.request.delete(`/api/v1/docs/${id}`, { headers: sameOrigin() });
    await anon.close(); await owner.close();
  }
});

test("Beautiful PDF reports errors and lets a reader cancel or retry without changing appearance", async ({ browser }) => {
  const owner = await accountsSession(browser, "carbon");
  const page = await owner.newPage();
  await signIn(page, runAccounts().carbon.email, "/library");
  const made = await page.request.post("/api/v1/docs", { headers: sameOrigin(), data: { title: "Retry export", markdown: "The document stays intact." } });
  const { id } = await made.json() as { id: string };
  try {
    await page.goto(`/d/${id}`);
    await expect(page.locator(".ProseMirror")).toBeVisible();
    let attempts = 0;
    await page.route("**/beautiful-pdf?*", async route => {
      attempts++;
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "pdf_export_failed", message: "The PDF couldn't be created.", hint: "Try exporting again in a moment." } }) });
    });
    const dialog = await exportDialog(page);
    await dialog.getByRole("button", { name: "Download PDF", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Try exporting again");
    await expect(dialog.getByRole("button", { name: "Download PDF", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Download PDF", exact: true }).click();
    await expect.poll(() => attempts).toBe(2);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.unroute("**/beautiful-pdf?*");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/beautiful-pdf?*", async route => { await held; await route.abort().catch(() => {}); });
    const busy = await exportDialog(page);
    const requested = page.waitForRequest(request => request.url().includes("/beautiful-pdf?"));
    await busy.getByRole("button", { name: "Download PDF", exact: true }).click();
    await requested;
    await expect(busy.getByRole("button", { name: "Creating PDF…", exact: true })).toHaveAttribute("aria-busy", "true");
    await busy.getByRole("button", { name: "Cancel", exact: true }).click();
    release();
    await expect(busy).not.toBeVisible();
    await expect(page.locator(".ProseMirror")).toHaveText("The document stays intact.");
  } finally {
    await page.request.delete(`/api/v1/docs/${id}`, { headers: sameOrigin() });
    await owner.close();
  }
});

import { expect, test, type Page } from "@playwright/test";
import type { Doc } from "../lib/write/types";
import { accountsSession, runAccounts, sameOrigin, signIn } from "./support";
import { docSyncState, openFormatting, chooseDocMode } from "./doc-support";

async function expectMobileTabControls(page: Page, doc: Doc, width: number) {
  const active = page.getByRole("tab", { selected: true });
  await expect(active).toContainText(doc.title);
  await expect(active).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: `Close ${doc.title}`, exact: true })).toBeInViewport({ ratio: 1 });
  for (const name of ["Open a doc"]) {
    const control = page.getByRole("button", { name, exact: true });
    await expect(control).toBeInViewport({ ratio: 1 });
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  }
}

test("previous and next tabs work with shortcuts while writing, without changing text selection shortcuts", async ({ browser }) => {
  const context = await accountsSession(browser, "carbon", { reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await signIn(page, runAccounts().carbon.email, "/library");
    const docs: Doc[] = [];
    for (const name of ["First", "Second", "Third"]) {
      const response = await page.request.post("/api/v1/docs", {
        headers: sameOrigin(),
        data: { title: `${name} tab ${Date.now()}`, markdown: Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of the ${name.toLowerCase()} document.`).join("\n\n") },
      });
      expect(response.status(), await response.text()).toBe(201);
      docs.push(await response.json() as Doc);
    }
    const previous = page.getByRole("button", { name: "Previous tab", exact: true });
    const next = page.getByRole("button", { name: "Next tab", exact: true });
    const editor = page.locator('.ProseMirror[contenteditable="true"]:visible');
    const selected = () => page.getByRole("tab", { selected: true });
    for (const doc of docs) {
      await page.goto(`/d/${doc.id}`);
      await expect(docSyncState(page)).toHaveAccessibleName("Connected and synced");
      await expect(selected()).toContainText(doc.title);
    }
    await expect(previous).toHaveCount(0);
    await expect(next).toHaveCount(0);
    await page.getByRole("tab", { name: docs[0].title, exact: true }).click();

    // The new chord works with the writing surface focused, including at either end.
    await editor.click();
    await editor.press("Alt+PageUp");
    await expect(selected()).toContainText(docs[2].title);
    await expect(editor).toBeFocused();
    await editor.press("Alt+PageDown");
    await expect(selected()).toContainText(docs[0].title);
    await expect(editor).toBeFocused();
    await page.keyboard.type("Continuing here. ");
    await expect(editor).toContainText("Continuing here. ");
    const continuedText = await editor.textContent();
    await editor.press("Alt+Shift+ArrowRight");
    await expect(selected()).toContainText(docs[0].title);
    await expect(editor).toHaveText(continuedText!);

    // A modal keeps its keyboard; changing tabs must not dismiss the picker.
    await page.getByRole("button", { name: "Open a doc", exact: true }).click();
    await page.keyboard.press("Alt+PageDown");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/d/${docs[0].id}$`));
    await page.keyboard.press("Escape");
    await expect(selected()).toContainText(docs[0].title);

    // Overscrolling the content must not carry the tab strip off the window.
    // Leave native bounce enabled; headless wheel input checks the end positions.
    await openFormatting(page);
    const chrome = [selected(), page.getByRole("banner"), page.getByRole("toolbar", { name: "Formatting" })];
    const tops = await Promise.all(chrome.map(async part => (await part.boundingBox())!.y));
    const expectFixedChrome = async () => {
      for (const [i, part] of chrome.entries()) {
        await expect.poll(async () => (await part.boundingBox())!.y).toBe(tops[i]);
        await expect(part).toBeInViewport({ ratio: 1 });
      }
    };
    await page.mouse.move(700, 700);
    await page.mouse.wheel(0, 100_000);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    await expectFixedChrome();
    await page.mouse.wheel(0, 100_000);
    await expectFixedChrome();
    await page.mouse.wheel(0, -100_000);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expectFixedChrome();
    const toolbarBounds = (await chrome[2].boundingBox())!;
    expect((await page.locator("#main").boundingBox())!.y).toBeGreaterThanOrEqual(toolbarBounds.y + toolbarBounds.height);
    await page.screenshot({ path: "test-results/stable-document-chrome.png" });
    await chooseDocMode(page, "Reading");
    await expect(chrome[2]).toBeHidden();
    await chooseDocMode(page, "Editing");
    await expectFixedChrome();

    await page.getByRole("tab", { name: "My docs", exact: true }).click();
    await expect(page.getByRole("link", { name: "Shared with me", exact: true })).toBeVisible();
    const navigation = page.getByRole("banner");
    const navTop = (await navigation.boundingBox())!.y;
    await page.mouse.move(700, 700);
    await page.mouse.wheel(0, 100_000);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect.poll(async () => (await navigation.boundingBox())!.y).toBe(navTop);
    await expect(navigation).toBeInViewport({ ratio: 1 });
    await page.mouse.wheel(0, -100_000);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect.poll(async () => (await navigation.boundingBox())!.y).toBe(navTop);
    await page.screenshot({ path: "test-results/stable-library-chrome.png" });
  } finally {
    await context.close();
  }
});

test("phone tabs keep their title, close control, and navigation visible at 390 and 320 pixels", async ({ browser }) => {
  const context = await accountsSession(browser, "carbon", { reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await signIn(page, runAccounts().carbon.email, "/library");
    const docs: Doc[] = [];
    for (const name of ["First", "Second", "Third"]) {
      const response = await page.request.post("/api/v1/docs", {
        headers: sameOrigin(),
        data: { title: `${name} document with a deliberately long name ${Date.now()}`, markdown: "A phone-sized writing space.\n" },
      });
      expect(response.status(), await response.text()).toBe(201);
      docs.push(await response.json() as Doc);
    }
    await page.goto(`/d/${docs[0].id}`);
    await expect(docSyncState(page)).toHaveAccessibleName("Connected and synced");
    // With one document, even the compact library tab fits beside the full active tab.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.getByRole("tab", { name: "My docs", exact: true })).toBeInViewport({ ratio: 1 });
      await expectMobileTabControls(page, docs[0], width);
    }

    for (const doc of docs.slice(1)) {
      await page.goto(`/d/${doc.id}`);
      await expect(docSyncState(page)).toHaveAccessibleName("Connected and synced");
    }
    // Scroll the complete active tab into view, including its sibling close button.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expectMobileTabControls(page, docs[2], width);
      await page.getByRole("tab", { selected: true }).press("Alt+PageDown");
      await expectMobileTabControls(page, docs[0], width);
      await page.getByRole("tab", { selected: true }).press("Alt+PageUp");
      await expectMobileTabControls(page, docs[2], width);
    }
  } finally {
    await context.close();
  }
});

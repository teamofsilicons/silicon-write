import { expect, test, type Page } from "@playwright/test";
import type { Doc } from "../lib/write/types";
import { accountsSession, runAccounts, sameOrigin, signIn } from "./support";
import { docSyncState } from "./doc-support";

async function expectMobileTabControls(page: Page, doc: Doc, width: number) {
  const active = page.getByRole("tab", { selected: true });
  await expect(active).toContainText(doc.title);
  await expect(active).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: `Close ${doc.title}`, exact: true })).toBeInViewport({ ratio: 1 });
  for (const name of ["Previous tab", "Next tab", "Open a doc"]) {
    const control = page.getByRole("button", { name, exact: true });
    await expect(control).toBeInViewport({ ratio: 1 });
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  }
}

test("previous and next tabs work with buttons and while writing, without changing text selection shortcuts", async ({ browser }) => {
  const context = await accountsSession(browser, "carbon", { reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await signIn(page, runAccounts().carbon.email, "/library");
    const docs: Doc[] = [];
    for (const name of ["First", "Second", "Third"]) {
      const response = await page.request.post("/api/v1/docs", {
        headers: sameOrigin(),
        data: { title: `${name} tab ${Date.now()}`, markdown: `Keep the ${name.toLowerCase()} document unchanged.\n` },
      });
      expect(response.status(), await response.text()).toBe(201);
      docs.push(await response.json() as Doc);
    }
    const previous = page.getByRole("button", { name: "Previous tab", exact: true });
    const next = page.getByRole("button", { name: "Next tab", exact: true });
    const editor = page.locator('.ProseMirror[contenteditable="true"]:visible');
    const selected = () => page.getByRole("tab", { selected: true });
    for (const [index, doc] of docs.entries()) {
      await page.goto(`/d/${doc.id}`);
      await expect(docSyncState(page)).toHaveAccessibleName("Connected and synced");
      await expect(selected()).toContainText(doc.title);
      if (index === 0) {
        await expect(previous).toBeDisabled();
        await expect(next).toBeDisabled();
      }
    }
    await previous.hover();
    await expect(page.getByRole("tooltip")).toContainText(/Previous tab.*(?:Fn ↑|Page Up)/s);
    await previous.click();
    await expect(selected()).toContainText(docs[1].title);
    await next.click();
    await expect(selected()).toContainText(docs[2].title);
    await next.click();
    await expect(selected()).toContainText(docs[0].title);

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
      await page.getByRole("button", { name: "Next tab", exact: true }).click();
      await expectMobileTabControls(page, docs[0], width);
      await page.getByRole("button", { name: "Previous tab", exact: true }).click();
      await expectMobileTabControls(page, docs[2], width);
    }
  } finally {
    await context.close();
  }
});

import { expect, type Page } from "@playwright/test";

/** The live connection state is in the document header; the footer contains word counts. */
export const docSyncState = (page: Page) => page.getByRole("banner").getByRole("status");

export async function chooseDocMode(page: Page, mode: "Editing" | "Suggesting" | "Reading" | "Commenting") {
  await page.getByRole("button", { name: /^Mode: / }).click();
  await page.getByRole("menuitemradio", { name: mode, exact: true }).click();
  await expect(page.getByRole("button", { name: `Mode: ${mode}`, exact: true })).toBeVisible();
}

/** Formatting is available on demand, without changing the document's editing mode. */
export async function openFormatting(page: Page) {
  const toggle = page.getByRole("button", { name: "Format", exact: true });
  await expect(toggle).toBeEnabled();
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
}

/** Existing threads and proposals are opened explicitly; newly posted comments open this panel themselves. */
export async function openComments(page: Page) {
  const toggle = page.getByRole("button", { name: "Comments", exact: true });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await expect(page.getByRole("complementary", { name: "Comments", exact: true })).toBeVisible();
}

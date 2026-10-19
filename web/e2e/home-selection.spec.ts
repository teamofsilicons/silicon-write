import { expect, test, type Browser, type Page } from "@playwright/test";
import type { Doc, Folder } from "../lib/write/types";
import { accountsSession, runAccounts, sameOrigin, signIn, type Who } from "./support";

async function signedIn(browser: Browser, who: Who) {
  const context = await accountsSession(browser, who, { reducedMotion: "reduce" });
  const page = await context.newPage();
  await signIn(page, runAccounts()[who].email, "/library");
  return { context, page };
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(`/api/v1/${path}`, { headers: sameOrigin(), data });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

test("homepage includes shared docs and folders with their permissions and hierarchy", async ({ browser }) => {
  const owner = await signedIn(browser, "friend");
  const reader = await signedIn(browser, "carbon");
  const suffix = Date.now();
  try {
    const own = await post<Doc>(reader.page, "docs", { title: `My home doc ${suffix}` });
    const shared = await post<Doc>(owner.page, "docs", { title: `Shared home doc ${suffix}` });
    const privateDoc = await post<Doc>(owner.page, "docs", { title: `Private home doc ${suffix}` });
    const folder = await post<Folder>(owner.page, "folders", { name: `Shared home folder ${suffix}` });
    const nested = await post<Doc>(owner.page, "docs", { title: `Inside shared folder ${suffix}`, folder_id: folder.id });
    await post(owner.page, `docs/${shared.id}/sharing`, { to: runAccounts().carbon.id, role: "viewer" });
    await post(owner.page, `folders/${folder.id}/sharing`, { to: runAccounts().carbon.id, role: "editor" });

    await reader.page.reload();
    const home = reader.page.getByRole("list", { name: "My docs", exact: true });
    await expect(home.getByRole("link", { name: own.title, exact: true })).toBeVisible();
    await expect(home.getByRole("link", { name: shared.title, exact: true })).toHaveCount(1);
    await expect(home.getByRole("listitem").filter({ hasText: shared.title })).toContainText(`Shared by ${runAccounts().friend.id}`);
    await expect(home.getByRole("link", { name: folder.name, exact: true })).toBeVisible();
    await expect(home.getByRole("link", { name: privateDoc.title, exact: true })).toHaveCount(0);
    await expect(home.getByRole("link", { name: nested.title, exact: true })).toHaveCount(0);

    await home.getByRole("button", { name: `More for ${shared.title}`, exact: true }).click();
    const menu = reader.page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Rename", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Move", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Move to the trash", exact: true })).toHaveCount(0);
    await reader.page.keyboard.press("Escape");
    await home.getByRole("link", { name: folder.name, exact: true }).click();
    const inside = reader.page.getByRole("list", { name: folder.name, exact: true });
    await expect(inside.getByRole("link", { name: nested.title, exact: true })).toBeVisible();
    await expect(inside.getByRole("link", { name: own.title, exact: true })).toHaveCount(0);
    await expect(inside.getByRole("link", { name: shared.title, exact: true })).toHaveCount(0);
    await expect(reader.page.getByRole("button", { name: "Open all docs", exact: true })).toBeVisible();
    await expect(reader.page.getByRole("checkbox", { name: "Select all documents", exact: true })).toHaveCount(0);
  } finally {
    await owner.context.close();
    await reader.context.close();
  }
});

test("selection is contextual, supports ranges and multiple tabs, and remains keyboard and touch accessible", async ({ browser }) => {
  const { context, page } = await signedIn(browser, "carbon");
  const prefix = `Selection ${Date.now()}`;
  try {
    const docs: Doc[] = [];
    for (const label of ["One", "Two", "Three"]) docs.push(await post<Doc>(page, "docs", { title: `${prefix} ${label}` }));
    await page.reload();
    await page.mouse.move(0, 0);
    const home = page.getByRole("list", { name: "My docs", exact: true });
    const rows = home.getByRole("listitem").filter({ has: page.getByRole("link", { name: new RegExp(prefix) }) });
    await expect(rows).toHaveCount(3);
    const first = rows.nth(0), last = rows.nth(2);
    const firstCheck = first.getByRole("checkbox");
    const checkboxOpacity = () => firstCheck.evaluate(input => getComputedStyle(input.parentElement!).opacity);
    await expect.poll(checkboxOpacity).toBe("0");
    await expect(page.getByRole("checkbox", { name: "Select all documents", exact: true })).toHaveCount(0);
    await first.hover();
    await expect.poll(checkboxOpacity).toBe("1");

    await first.getByRole("link").click({ modifiers: ["ControlOrMeta"] });
    await expect(page).toHaveURL(/\/library$/);
    await expect(firstCheck).toBeChecked();
    await last.getByRole("link").click({ modifiers: ["Shift"] });
    await expect(home.locator("[data-selected]")).toHaveCount(3);
    await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Select all documents", exact: true })).toHaveCount(0);

    await firstCheck.check();
    await last.getByRole("checkbox").click({ modifiers: ["Shift"] });
    await expect(home.locator("[data-selected]")).toHaveCount(3);
    await page.getByRole("button", { name: "Clear", exact: true }).click();

    await firstCheck.focus();
    await expect.poll(checkboxOpacity).toBe("1");
    await firstCheck.press("Space");
    await expect(firstCheck).toBeChecked();
    await firstCheck.press("Escape");
    await expect(firstCheck).not.toBeChecked();
    await first.getByRole("link").click({ modifiers: ["ControlOrMeta"] });
    await last.getByRole("link").click({ modifiers: ["ControlOrMeta"] });
    await expect(home.locator("[data-selected]")).toHaveCount(2);
    await page.getByRole("button", { name: "Open selected", exact: true }).click();
    await expect(page).toHaveURL(/\/d\//);
    await expect(page.locator('[role="tab"][data-doc-id]')).toHaveCount(2);

    await page.goto("/library");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: `More for ${docs[0]!.title}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Select", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: `Select ${docs[0]!.title}`, exact: true })).toBeChecked();
    await expect(page.getByRole("button", { name: "Open selected", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await home.getByRole("link", { name: docs[0]!.title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${docs[0]!.id}$`));
  } finally {
    await context.close();
  }
});

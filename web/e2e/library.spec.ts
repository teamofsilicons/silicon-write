/**
 * The library and sharing in a real browser (UNDERSTANDING.md, "Docs and folders" and "Sharing"): My docs, New doc and
 * New folder, folders inside folders and their breadcrumbs, renaming, moving and copying from a row's menu, the trash
 * (restore, Hold to delete forever with the mouse and the keyboard, a folder in the trash left open in another tab),
 * Open files, the share dialog (people and roles, what owners, editors and viewers each get, email invites, what bad
 * input is told, the public link, transfers and an offer whose doc went to the trash), shared folders (as editor and
 * as viewer, the move dialog inside one), Shared with me, Recent, Search, a public doc read signed out and signed in
 * from its Sign in button, dark appearance in a browser that prefers dark, and a pass over every page at 1440×900 and at
 * 390×844 (no sideways scrolling, nothing cut off or squeezed; full-page screenshots in test-results/web-library).
 *
 * The run's two Carbons come from the setup project ("carbon" and "friend", e2e/accounts.setup.ts); each test signs
 * them in with "Continue as" and makes its own docs and folders with names unique to the run, so the tests are
 * independent of each other and can run again.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { Doc, Folder, Library, Member, Sharing, Transfer } from "../lib/write/types";
import { ACCOUNTS, API, BASE, accountsSession, runAccounts, sameOrigin, signIn, signInOnHostedPages, watchErrors, type Who } from "./support";
import { docSyncState, openFormatting } from "./doc-support";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
let made = 0;
/** A name nothing else in this run or any other uses. */
const named = (label: string) => `${label} ${RUN}${(++made).toString(36)}`;
/** One word nothing else uses (for search). */
const word = (label: string) => `${label}${RUN}${(++made).toString(36)}`;

/* ---------------------------------------------------------------------------------------------------------------- */
/* Helpers                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

interface Signed {
  who: Who;
  /** c:id */
  id: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

/** A browser signed in to Silicon Write as one of the run's Carbons (through the hosted pages, "Continue as"). */
async function signedIn(browser: Browser, who: Who, viewport = DESKTOP, options: { colorScheme?: "light" | "dark" } = {}): Promise<Signed> {
  const context = await accountsSession(browser, who, { viewport, reducedMotion: "reduce", ...options });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await signIn(page, runAccounts()[who].email, "/library");
  return { who, id: runAccounts()[who].id, context, page, errors };
}

/** A browser that never signed in to anything. */
async function signedOut(browser: Browser, viewport = DESKTOP, options: { colorScheme?: "light" | "dark" } = {}): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ baseURL: BASE, viewport, reducedMotion: "reduce", ...options });
  const page = await context.newPage();
  return { context, page, errors: watchErrors(page) };
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Calls the service through the site's API proxy, as the page's Carbon (or signed out), the way the pages do. */
async function call<T = unknown>(page: Page, method: Method, path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const response = await page.request.fetch(`${BASE}/api${path}`, {
    method,
    headers: sameOrigin(data === undefined ? {} : { "Content-Type": "application/json" }),
    data: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status(), body: body as T };
}

/**
 * When an answer is the local Accounts stack's limit on account lookups (each app gets 600 a minute, shared by every
 * suite running against the stack at the same time), how long to wait before asking again; otherwise null. Sharing and
 * transferring by c:id or si:id each look an account up. The test gets the time it waits.
 */
function lookupLimitWait(answer: { status: number; body: unknown }): number | null {
  if (answer.status !== 503) return null;
  const match = /Too many account lookups.*?Wait (\d+) seconds?/.exec(JSON.stringify(answer.body ?? ""));
  if (!match) return null;
  const ms = (Number(match[1]) + 1) * 1000;
  test.info().annotations.push({ type: "accounts lookup limit", description: `the shared Accounts stack asked to wait ${match[1]} s` });
  test.info().setTimeout(test.info().timeout + ms);
  return ms;
}

/** A call that has to succeed with `status` (waiting out the Accounts stack's lookup limit, as a Carbon would). */
async function must<T = unknown>(page: Page, method: Method, path: string, data?: unknown, status = 200): Promise<T> {
  let answer = await call<T>(page, method, path, data);
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lookupLimitWait(answer);
    if (wait === null) break;
    await page.waitForTimeout(wait);
    answer = await call<T>(page, method, path, data);
  }
  expect(answer.status, `${method} ${path} → ${answer.status} ${JSON.stringify(answer.body)}`).toBe(status);
  return answer.body;
}

const newDoc = (page: Page, title: string, extra: { markdown?: string; folder_id?: string | null } = {}) => must<Doc>(page, "POST", "/v1/docs", { title, ...extra }, 201);
const newFolder = (page: Page, name: string, parent_id: string | null = null) => must<Folder>(page, "POST", "/v1/folders", { name, parent_id }, 201);
const shareDoc = (page: Page, id: string, to: string, role: string) => must<Member>(page, "POST", `/v1/docs/${id}/sharing`, { to, role }, 201);

/** Waits until the service has indexed a doc's text (search and first-line titles read it). */
async function indexed(page: Page, text: string, id: string): Promise<void> {
  await expect
    .poll(async () => ((await call<{ results: { doc: Doc }[] }>(page, "GET", `/v1/search?q=${encodeURIComponent(text)}`)).body.results ?? []).some(r => r.doc.id === id), { timeout: 20_000, message: `the service indexes “${text}”` })
    .toBe(true);
}

const lastSegment = (page: Page) => new URL(page.url()).pathname.split("/").pop()!;

/** The library list on the page (labelled with the page's heading: "My docs", a folder's name, "Trash"…). */
const list = (page: Page, name: string) => page.getByRole("list", { name, exact: true });
/** One row of that list, by the doc or folder name in it. */
const row = (page: Page, name: string, item: string) => list(page, name).getByRole("listitem").filter({ hasText: item });
/** A row's title link. */
const link = (page: Page, name: string, item: string) => list(page, name).getByRole("link", { name: item, exact: true });

/** Opens a row's "More for …" menu. */
async function rowMenu(page: Page, item: string): Promise<Locator> {
  await page.getByRole("button", { name: `More for ${item}`, exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Picks an option of a Silicon UI select (a Radix select: a combobox and a listbox). */
async function choose(page: Page, select: Locator, option: string): Promise<void> {
  await select.click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** Opens the share dialog of a library row. */
async function shareFromRow(page: Page, item: string): Promise<Locator> {
  await (await rowMenu(page, item)).getByRole("menuitem", { exact: true, name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(item);
  await expect(dialog.getByRole("list", { name: "People with access" }).getByRole("listitem").first()).toContainText("Owner");
  return dialog;
}

/** Presses and holds a hold-to-confirm button with the mouse. */
async function holdDown(page: Page, target: Locator, ms: number): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** Waits for the page's own call to the service (through /api) whose path ends with `path`, and returns its answer. */
async function answerTo(page: Page, method: Method, path: string, act: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname === `/api${path}`, { timeout: 20_000 }),
    act(),
  ]);
  return { status: response.status(), body: await response.json().catch(() => null) };
}

/**
 * Presses a button that has the service look an account up (Share or Transfer with a c:id or si:id typed in) and
 * returns the service's answer. When the Accounts stack's lookup limit answers instead, waits as told and presses
 * again (the dialog keeps what was typed when it fails).
 */
async function pressLookingUp(page: Page, button: Locator, path: string): Promise<{ status: number; body: unknown }> {
  for (let attempt = 1; ; attempt++) {
    const answer = await answerTo(page, "POST", path, () => button.click());
    const wait = lookupLimitWait(answer);
    if (wait === null || attempt > 3) return answer;
    await page.waitForTimeout(wait);
  }
}

/**
 * How light the background behind an element is (relative luminance, 0 black to 1 white): the first background that
 * isn't see-through, from the element up. Colours are read through a canvas, so any CSS colour syntax works.
 */
async function backgroundLuminance(target: Locator): Promise<number> {
  return luminance(target, "background");
}

/** How light an element's text colour is (relative luminance, 0 black to 1 white). */
async function inkLuminance(target: Locator): Promise<number> {
  return luminance(target, "ink");
}

async function luminance(target: Locator, what: "background" | "ink"): Promise<number> {
  return target.evaluate((element, what) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (colour: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data) as [number, number, number, number];
    };
    const linear = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const of = ([r, g, b]: [number, number, number, number]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    if (what === "ink") return of(rgba(getComputedStyle(element).color));
    for (let node: Element | null = element; node; node = node.parentElement) {
      const colour = rgba(getComputedStyle(node).backgroundColor);
      if (colour[3] > 128) return of(colour);
    }
    // Nothing painted: the canvas of a light page is white, of a dark one black.
    return getComputedStyle(document.documentElement).colorScheme.includes("dark") ? 0 : 1;
  }, what);
}

/** Where the screenshots go: web/test-results/web-library. */
function shotsDir(): string {
  const dir = resolve(test.info().project.testDir, "..", "test-results", "web-library");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shotsDir(), `${name}.png`), fullPage });
}

/**
 * What is broken about the layout right now: the page scrolling sideways, or a visible control, heading, row or bit of
 * text reaching past the part of the window it can show in (the window, narrowed by every box around it that clips,
 * such as a dialog or a scrolling list). The formatting bar is a deliberate sideways scroller and doesn't count.
 */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems = new Set<string>();
    const width = document.documentElement.clientWidth;
    const scroll = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (scroll > window.innerWidth) problems.add(`the page scrolls sideways: ${scroll}px of content in a ${window.innerWidth}px window`);
    // The inside of every box that clips (its padding box: borders and scroll bars don't show content).
    const room = (el: Element) => {
      let left = 0;
      let right = width;
      for (let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
        if (getComputedStyle(box).overflowX === "visible") continue;
        const r = box.getBoundingClientRect();
        left = Math.max(left, r.left + box.clientLeft);
        right = Math.min(right, r.left + box.clientLeft + box.clientWidth);
      }
      return { left, right };
    };
    const selector = "a, button, input, textarea, [role=combobox], [role=option], [role=menuitem], h1, h2, h3, li, p, span, label";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (el.closest(".skip-link, [aria-hidden='true'], [hidden], [inert], [role=toolbar]")) continue;
      // A span only when it holds text of its own.
      if (el.tagName === "SPAN" && !Array.from(el.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.opacity === "0") continue;
      const { left, right } = room(el);
      // Text kept for screen readers only (clipped to a pixel) is meant to be invisible.
      if (right - left <= 2) continue;
      if (r.right > right + 1.5 || r.left < left - 1.5) {
        const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
        problems.add(`<${el.tagName.toLowerCase()}> “${label}” is cut off: it spans ${Math.round(r.left)} to ${Math.round(r.right)} px, the room it shows in is ${Math.round(left)} to ${Math.round(right)} px`);
      }
    }
    // Icons keep the size they are drawn at: one squeezed narrower is a flex item that gave way to long text beside it.
    for (const icon of Array.from(document.querySelectorAll<SVGSVGElement>("svg[width]"))) {
      if (icon.closest(".skip-link, [hidden], [inert], [role=toolbar]")) continue;
      const drawn = Number(icon.getAttribute("width"));
      const r = icon.getBoundingClientRect();
      if (!(drawn >= 12) || r.width <= 0 || r.height <= 0 || getComputedStyle(icon).visibility === "hidden") continue;
      if (r.width < drawn * 0.75) {
        const owner = icon.closest("button, a, li, [role=option]");
        const label = ((owner?.getAttribute("aria-label") || owner?.textContent) ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        problems.add(`an icon next to “${label}” is squeezed to ${Math.round(r.width)} px wide (drawn at ${drawn} px)`);
      }
    }
    return [...problems];
  });
}

/** One screen of the pass: a screenshot (the whole page, or the window when a dialog or menu is open) and the check. */
async function screen(page: Page, prefix: string, name: string, problems: string[], fullPage = true): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shotsDir(), `${prefix}-${name}.png`), fullPage });
  for (const problem of await layoutProblems(page)) problems.push(`${name}: ${problem}`);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* My docs: New doc, New folder, folders and breadcrumbs                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

test("New doc opens the editor, and My docs then lists the doc by its first line", async ({ browser }) => {
  const carbon = await signedIn(browser, "carbon");
  const { page } = carbon;
  await expect(page.getByRole("heading", { level: 1, name: "My docs", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New doc" }).first().click();
  await page.waitForURL(/\/d\/d_[A-Za-z0-9]+$/);
  const id = lastSegment(page);
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
  await expect(docSyncState(page)).toHaveAccessibleName("Connected and synced", { timeout: 20_000 });
  const doc = await must<Doc>(page, "GET", `/v1/docs/${id}`);
  expect(doc.role).toBe("owner");
  expect(doc.owner.id).toBe(carbon.id);
  expect(doc.folder_id).toBeNull();

  // It has no title yet: once there's text, it goes by its first line.
  const first = named("Kickoff");
  await editor.click();
  await page.keyboard.type(first);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Agenda and owners.");
  await expect.poll(async () => (await call<{ markdown: string }>(page, "GET", `/v1/docs/${id}/markdown`)).body.markdown, { timeout: 15_000 }).toContain("Agenda and owners.");
  await expect.poll(async () => (await call<Doc>(page, "GET", `/v1/docs/${id}`)).body.title, { timeout: 15_000 }).toBe(first);

  await page.getByRole("link", { name: "Back to My docs" }).click();
  await page.waitForURL(/\/library$/);
  await expect(link(page, "My docs", first)).toHaveAttribute("href", `/d/${id}`);
  await expect(row(page, "My docs", first)).toContainText("edited");
  await shot(page, "desktop-my-docs");
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
});

test("New folder, open it, a folder inside it, and the breadcrumbs lead back up", async ({ browser }) => {
  const carbon = await signedIn(browser, "carbon");
  const { page } = carbon;
  const parent = named("Plans");
  const child = named("Quarter");

  await page.getByRole("button", { name: "New folder" }).click();
  let dialog = page.getByRole("dialog", { name: "New folder" });
  let field = dialog.getByRole("textbox", { name: "Folder name" });
  const make = dialog.getByRole("button", { name: "Make folder" });
  await expect(field).toBeFocused();
  // A folder needs a name: nothing to make while it's empty or blank.
  await expect(make).toBeDisabled();
  await field.fill("   ");
  await expect(make).toBeDisabled();
  // Too long: the service says why, and the dialog stays open to fix it.
  await field.fill("x".repeat(201));
  await make.click();
  await expect(page.getByText("A folder name can be at most 200 characters.")).toBeVisible();
  await expect(dialog).toBeVisible();
  await field.fill(parent);
  await make.click();
  await expect(dialog).toBeHidden();
  await expect(link(page, "My docs", parent)).toBeVisible();

  // Open it.
  await link(page, "My docs", parent).click();
  await page.waitForURL(/\/library\/f_[A-Za-z0-9]+$/);
  const parentId = lastSegment(page);
  await expect(page.getByRole("heading", { level: 1, name: parent, exact: true })).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link")).toHaveText(["My docs"]);
  await expect(crumbs.getByRole("link", { name: "My docs" })).toHaveAttribute("href", "/library");
  await expect(crumbs.locator("[aria-current=page]")).toHaveText(parent);
  await expect(page.getByText("This folder is empty")).toBeVisible();

  // A folder inside it (Enter makes it too).
  await page.getByRole("button", { name: "New folder" }).click();
  dialog = page.getByRole("dialog", { name: "New folder" });
  field = dialog.getByRole("textbox", { name: "Folder name" });
  await field.fill(child);
  await field.press("Enter");
  await expect(dialog).toBeHidden();
  await link(page, parent, child).click();
  await page.waitForURL(url => /\/library\/f_/.test(url.pathname) && !url.pathname.endsWith(parentId));
  const childId = lastSegment(page);
  await expect(page.getByRole("heading", { level: 1, name: child, exact: true })).toBeVisible();
  await expect(crumbs.getByRole("link")).toHaveText(["My docs", parent]);
  await expect(crumbs.getByRole("link", { name: parent })).toHaveAttribute("href", `/library/${parentId}`);
  await expect(crumbs.locator("[aria-current=page]")).toHaveText(child);
  const folder = await must<Folder>(page, "GET", `/v1/folders/${childId}`);
  expect(folder.parent_id).toBe(parentId);
  expect(folder.path).toEqual([{ id: parentId, name: parent }]);
  expect(folder.role).toBe("owner");
  await shot(page, "desktop-folder");

  // A doc made here is in this folder.
  await page.getByRole("button", { name: "New doc" }).first().click();
  await page.waitForURL(/\/d\/d_/);
  const docId = lastSegment(page);
  const doc = await must<Doc>(page, "GET", `/v1/docs/${docId}`);
  expect(doc.folder_id).toBe(childId);
  expect(doc.path.map(part => part.name)).toEqual([parent, child]);
  await page.getByRole("link", { name: "Back to My docs" }).click();
  await page.waitForURL(/\/library$/);
  await page.goto(`/library/${childId}`);
  await expect(link(page, child, "Untitled")).toHaveAttribute("href", `/d/${docId}`);

  // Up through the breadcrumbs.
  await crumbs.getByRole("link", { name: parent }).click();
  await page.waitForURL(new RegExp(`/library/${parentId}$`));
  await expect(link(page, parent, child)).toBeVisible();
  await crumbs.getByRole("link", { name: "My docs" }).click();
  await page.waitForURL(/\/library$/);
  await expect(link(page, "My docs", parent)).toBeVisible();
  await expect(link(page, "My docs", child)).toHaveCount(0);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* A row's menu: rename, move, copy                                                                                 */
/* ---------------------------------------------------------------------------------------------------------------- */

test("rename and move a doc and a folder from their row's menu (the move dialog)", async ({ browser }) => {
  const carbon = await signedIn(browser, "carbon");
  const { page } = carbon;
  const archive = await newFolder(page, named("Archive"));
  const drafts = await newFolder(page, named("Drafts"));
  const inner = await newFolder(page, named("Inner"), drafts.id);
  const memo = await newDoc(page, named("Memo"), { markdown: "Quarterly memo." });
  await page.goto("/library");

  // Rename the doc.
  await (await rowMenu(page, memo.title)).getByRole("menuitem", { exact: true, name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename" });
  const name = rename.getByRole("textbox", { name: "Name" });
  await expect(name).toHaveValue(memo.title);
  await name.fill("  ");
  await expect(rename.getByRole("button", { name: "Rename" })).toBeDisabled();
  const brief = named("Brief");
  await name.fill(brief);
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(rename).toBeHidden();
  await expect(link(page, "My docs", brief)).toBeVisible();
  await expect(link(page, "My docs", memo.title)).toHaveCount(0);
  expect((await must<Doc>(page, "GET", `/v1/docs/${memo.id}`)).title).toBe(brief);

  // Move it into a folder.
  await (await rowMenu(page, brief)).getByRole("menuitem", { exact: true, name: "Move" }).click();
  let move = page.getByRole("dialog", { name: `Move “${brief}”` });
  let places = move.getByRole("listbox", { name: "Where to" });
  await expect(places.getByRole("option", { name: "Top level" })).toHaveAttribute("aria-selected", "true");
  // Where it already is: nothing to do.
  await expect(move.getByRole("button", { name: "Move here" })).toBeDisabled();
  await places.getByRole("option", { name: archive.name, exact: true }).click();
  await expect(places.getByRole("option", { name: archive.name, exact: true })).toHaveAttribute("aria-selected", "true");
  await shot(page, "desktop-move-dialog", false);
  await move.getByRole("button", { name: "Move here" }).click();
  await expect(move).toBeHidden();
  await expect(link(page, "My docs", brief)).toHaveCount(0);
  expect((await must<Doc>(page, "GET", `/v1/docs/${memo.id}`)).folder_id).toBe(archive.id);
  await link(page, "My docs", archive.name).click();
  await page.waitForURL(new RegExp(`/library/${archive.id}$`));
  await expect(link(page, archive.name, brief)).toBeVisible();

  // And back out to the top level.
  await (await rowMenu(page, brief)).getByRole("menuitem", { exact: true, name: "Move" }).click();
  move = page.getByRole("dialog", { name: `Move “${brief}”` });
  places = move.getByRole("listbox", { name: "Where to" });
  await expect(places.getByRole("option", { name: archive.name, exact: true })).toHaveAttribute("aria-selected", "true");
  await places.getByRole("option", { name: "Top level" }).click();
  await move.getByRole("button", { name: "Move here" }).click();
  await expect(move).toBeHidden();
  await expect(link(page, archive.name, brief)).toHaveCount(0);
  expect((await must<Doc>(page, "GET", `/v1/docs/${memo.id}`)).folder_id).toBeNull();

  // A folder moves with everything in it, but never into itself or a folder inside it.
  await page.goto("/library");
  await (await rowMenu(page, drafts.name)).getByRole("menuitem", { exact: true, name: "Move" }).click();
  move = page.getByRole("dialog", { name: `Move “${drafts.name}”` });
  places = move.getByRole("listbox", { name: "Where to" });
  await expect(places.getByRole("option", { name: archive.name, exact: true })).toBeVisible();
  await expect(places.getByRole("option", { name: drafts.name, exact: true })).toHaveCount(0);
  await expect(places.getByRole("option", { name: inner.name, exact: true })).toHaveCount(0);
  await places.getByRole("option", { name: archive.name, exact: true }).click();
  await move.getByRole("button", { name: "Move here" }).click();
  await expect(move).toBeHidden();
  await expect(link(page, "My docs", drafts.name)).toHaveCount(0);
  expect((await must<Folder>(page, "GET", `/v1/folders/${drafts.id}`)).parent_id).toBe(archive.id);
  await page.goto(`/library/${inner.id}`);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link")).toHaveText(["My docs", archive.name, drafts.name]);

  // Rename a folder from its row.
  await page.goto(`/library/${archive.id}`);
  await (await rowMenu(page, drafts.name)).getByRole("menuitem", { exact: true, name: "Rename" }).click();
  const renameFolder = page.getByRole("dialog", { name: "Rename" });
  await expect(renameFolder.getByRole("textbox", { name: "Name" })).toHaveValue(drafts.name);
  const sketches = named("Sketches");
  await renameFolder.getByRole("textbox", { name: "Name" }).fill(sketches);
  await renameFolder.getByRole("button", { name: "Rename" }).click();
  await expect(renameFolder).toBeHidden();
  await expect(link(page, archive.name, sketches)).toHaveAttribute("href", `/library/${drafts.id}`);
  expect((await must<Folder>(page, "GET", `/v1/folders/${drafts.id}`)).name).toBe(sketches);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
});

test("Make a copy from a row's menu makes a new doc with the same text, next to the original", async ({ browser }) => {
  const carbon = await signedIn(browser, "carbon");
  const { page } = carbon;
  const top = await newDoc(page, named("Recipe"), { markdown: "Two eggs, one pan." });
  const folder = await newFolder(page, named("Kitchen"));
  const filed = await newDoc(page, named("Shopping"), { folder_id: folder.id, markdown: "Milk and bread." });

  await page.goto("/library");
  await (await rowMenu(page, top.title)).getByRole("menuitem", { exact: true, name: "Make a copy" }).click();
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  await expect(link(page, "My docs", `Copy of ${top.title}`)).toBeVisible();
  const copies = (await must<{ docs: Doc[] }>(page, "GET", "/v1/docs")).docs.filter(d => d.title === `Copy of ${top.title}`);
  expect(copies).toHaveLength(1);
  expect(copies[0]!.id).not.toBe(top.id);
  expect(copies[0]!.role).toBe("owner");
  expect((await must<{ markdown: string }>(page, "GET", `/v1/docs/${copies[0]!.id}/markdown`)).markdown).toContain("Two eggs, one pan.");

  // A copy made inside a folder shows up in that folder, where it was made.
  await page.goto(`/library/${folder.id}`);
  await (await rowMenu(page, filed.title)).getByRole("menuitem", { exact: true, name: "Make a copy" }).click();
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  const filedCopy = (await must<{ docs: Doc[] }>(page, "GET", "/v1/docs")).docs.find(d => d.title === `Copy of ${filed.title}`);
  expect(filedCopy, "the copy exists").toBeTruthy();
  expect.soft(filedCopy?.folder_id, "the copy of a doc in a folder is made in the same folder").toBe(folder.id);
  await expect.soft(link(page, folder.name, `Copy of ${filed.title}`), "the copy shows in the folder it was made in").toBeVisible();
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* The trash                                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

test("move to the trash, restore, and Hold to delete forever in Trash", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const { page } = carbon;
  const kept = await newDoc(page, named("Old notes"), { markdown: "Notes worth keeping." });
  const scrap = await newDoc(page, named("Scrap"), { markdown: "Throw this away." });
  const box = await newFolder(page, named("Box"));
  const inside = await newDoc(page, named("Inside"), { folder_id: box.id, markdown: "In the box." });
  await shareDoc(page, kept.id, friend.id, "viewer");
  await page.goto("/library");

  // To the trash: gone from My docs, and from everyone it was shared with.
  await (await rowMenu(page, kept.title)).getByRole("menuitem", { exact: true, name: "Move to the trash" }).click();
  await expect(page.getByText(`Moved “${kept.title}” to the trash`)).toBeVisible();
  await expect(link(page, "My docs", kept.title)).toHaveCount(0);
  expect((await call(friend.page, "GET", `/v1/docs/${kept.id}`)).status).toBe(404);
  await friend.page.goto("/shared");
  await expect(friend.page.getByRole("heading", { level: 1, name: "Shared with me" })).toBeVisible();
  await expect(link(friend.page, "Shared with me", kept.title)).toHaveCount(0);

  // In the trash, with when it was deleted; restoring puts it back for everyone.
  await page.getByRole("navigation", { name: "Write", exact: true }).getByRole("link", { name: "Trash" }).click();
  await page.waitForURL(/\/trash$/);
  await expect(page.getByRole("heading", { level: 1, name: "Trash" })).toBeVisible();
  const trashed = row(page, "Trash", kept.title);
  await expect(trashed).toContainText("deleted");
  await expect(trashed.getByRole("button", { name: "Hold to delete forever" })).toBeVisible();
  await shot(page, "desktop-trash");
  await trashed.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText(`Restored “${kept.title}”`)).toBeVisible();
  await expect(trashed).toHaveCount(0);
  expect((await must<Doc>(page, "GET", `/v1/docs/${kept.id}`)).deleted_at).toBeNull();
  await page.goto("/library");
  await expect(link(page, "My docs", kept.title)).toBeVisible();
  await friend.page.reload();
  await expect(link(friend.page, "Shared with me", kept.title)).toBeVisible();

  // A folder goes to the trash with everything in it, and comes back with it.
  await (await rowMenu(page, box.name)).getByRole("menuitem", { exact: true, name: "Move to the trash" }).click();
  await expect(page.getByText(`Moved “${box.name}” to the trash`)).toBeVisible();
  expect((await call<Doc>(page, "GET", `/v1/docs/${inside.id}`)).body.deleted_at).toBeTruthy();
  await page.goto("/trash");
  await expect(row(page, "Trash", box.name)).toBeVisible();
  await expect(row(page, "Trash", inside.title)).toHaveCount(0);
  await row(page, "Trash", box.name).getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText(`Restored “${box.name}”`)).toBeVisible();
  await page.goto(`/library/${box.id}`);
  await expect(link(page, box.name, inside.title)).toBeVisible();

  // Deleting for good asks to confirm by holding: a click does nothing.
  await must(page, "DELETE", `/v1/docs/${scrap.id}`, undefined, 204);
  await page.goto("/trash");
  const doomed = row(page, "Trash", scrap.title);
  const hold = doomed.getByRole("button", { name: "Hold to delete forever" });
  await hold.click();
  await page.waitForTimeout(1_600);
  await expect(doomed).toBeVisible();
  expect((await call(page, "GET", `/v1/docs/${scrap.id}`)).status).toBe(200);
  await holdDown(page, hold, 2_000);
  await expect(page.getByText("Deleted for good")).toBeVisible();
  await expect(doomed).toHaveCount(0);
  expect((await call(page, "GET", `/v1/docs/${scrap.id}`)).status).toBe(404);
  expect((await call(page, "POST", `/v1/docs/${scrap.id}/restore`)).status).toBe(404);

  // A folder deleted for good takes what's in it.
  await must(page, "DELETE", `/v1/folders/${box.id}`, undefined, 204);
  await page.reload();
  await holdDown(page, row(page, "Trash", box.name).getByRole("button", { name: "Hold to delete forever" }), 2_000);
  await expect(row(page, "Trash", box.name)).toHaveCount(0);
  expect((await call(page, "GET", `/v1/folders/${box.id}`)).status).toBe(404);
  expect((await call(page, "GET", `/v1/docs/${inside.id}`)).status).toBe(404);

  // With the keyboard: Enter held on the focused button (a tap of Enter does nothing).
  const keyed = await newDoc(page, named("Keyboard scrap"), { markdown: "Held with Enter." });
  await must(page, "DELETE", `/v1/docs/${keyed.id}`, undefined, 204);
  await page.reload();
  const keyHold = row(page, "Trash", keyed.title).getByRole("button", { name: "Hold to delete forever" });
  await keyHold.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_600);
  expect((await call(page, "GET", `/v1/docs/${keyed.id}`)).status).toBe(200);
  await page.keyboard.down("Enter");
  await page.waitForTimeout(2_000);
  await page.keyboard.up("Enter");
  await expect(row(page, "Trash", keyed.title)).toHaveCount(0);
  expect((await call(page, "GET", `/v1/docs/${keyed.id}`)).status).toBe(404);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("a folder in the trash takes nothing new: a tab left open on it can't make a doc there, and deleting the folder for good never takes a doc that wasn't in the trash", async ({ browser }) => {
  test.setTimeout(180_000);
  const carbon = await signedIn(browser, "carbon");
  const { page } = carbon;
  const folder = await newFolder(page, named("Packing"));
  await page.goto(`/library/${folder.id}`);
  await expect(page.getByText("This folder is empty")).toBeVisible();

  // Another tab puts the folder in the trash; this one still shows it, with New doc.
  await must(page, "DELETE", `/v1/folders/${folder.id}`, undefined, 204);
  const attempt = await answerTo(page, "POST", "/v1/docs", () => page.getByRole("button", { name: "New doc" }).first().click());
  const inside = () => must<Library>(page, "GET", `/v1/library?view=mine&folder=${folder.id}`).then(l => l.docs);
  expect.soft(attempt.status, `New doc inside a folder in the trash is refused (the service answered ${attempt.status} ${JSON.stringify(attempt.body).slice(0, 160)})`).toBeGreaterThanOrEqual(400);
  expect.soft((await inside()).map(d => d.id), "no doc is made inside a folder in the trash").toEqual([]);

  // Opened by its address, a folder in the trash says so, and offers nothing to add to it.
  await page.goto(`/library/${folder.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await shot(page, "desktop-folder-in-the-trash");
  await expect.soft(page.getByText(/in the trash/i).first(), "the page of a folder in the trash says it is in the trash").toBeVisible();
  await expect.soft(page.getByRole("button", { name: "New doc" }), "a folder in the trash doesn't offer New doc").toHaveCount(0);

  // What a doc made there anyway goes through: it is in no list (not My docs, not the trash), and when the folder is
  // deleted for good, from the trash, the doc goes with it although nobody ever put it in the trash.
  const stray = (await inside())[0];
  if (stray) {
    await must(page, "PUT", `/v1/docs/${stray.id}/markdown`, { markdown: "Notes typed into the stale tab." });
    const ids = async (view: string) => (await must<Library>(page, "GET", `/v1/library?view=${view}`)).docs.map(d => d.id);
    expect.soft(await ids("mine"), "a doc made in a folder in the trash isn't in My docs").not.toContain(stray.id);
    expect.soft(await ids("trash"), "nor in the trash").not.toContain(stray.id);
    await page.goto("/trash");
    await holdDown(page, row(page, "Trash", folder.name).getByRole("button", { name: "Hold to delete forever" }), 2_000);
    await expect(row(page, "Trash", folder.name)).toHaveCount(0);
    const after = await call(page, "GET", `/v1/docs/${stray.id}`);
    expect.soft(after.status, `the doc ${stray.id}, never put in the trash, survives its folder being deleted for good (it is ${after.status})`).toBe(200);
  }
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Open files                                                                                                      */
/* ---------------------------------------------------------------------------------------------------------------- */

test("opening files makes a new doc from a .md file, in the folder it was opened in", async ({ browser }) => {
  const carbon = await signedIn(browser, "carbon");
  const { page } = carbon;
  const stem = `launch-notes-${RUN}${(++made).toString(36)}`;
  const heading = named("Launch");
  const markdown = `# ${heading}\n\nWe ship on **Friday**, with _care_.\n\n- Write the notes\n- Tell the Silicons\n`;

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open files" }).click();
  const files = await chooser;
  expect(files.isMultiple()).toBe(true);
  await files.setFiles({ name: `${stem}.md`, mimeType: "text/markdown", buffer: Buffer.from(markdown) });
  await page.getByRole("dialog", { name: "Your files are ready" }).getByRole("button", { name: "Open doc", exact: true }).click();
  await page.waitForURL(/\/d\/d_[A-Za-z0-9]+$/, { timeout: 30_000 });
  const id = lastSegment(page);
  // The doc's title (an editor can rename it in place) is the file's name.
  await expect(page.getByRole("banner").getByRole("heading", { level: 1 })).toHaveText(stem);
  const editor = page.locator(".ProseMirror");
  await expect(editor.getByRole("heading", { name: heading })).toBeVisible();
  await expect(editor.locator("strong")).toHaveText("Friday");
  await expect(editor.locator("em")).toHaveText("care");
  await expect(editor.locator("li")).toHaveText(["Write the notes", "Tell the Silicons"]);
  const md = (await must<{ markdown: string }>(page, "GET", `/v1/docs/${id}/markdown`)).markdown;
  expect(md).toContain(`# ${heading}`);
  expect(md).toContain("**Friday**");
  expect(md).toMatch(/^[-*] Write the notes$/m);
  const doc = await must<Doc>(page, "GET", `/v1/docs/${id}`);
  expect(doc.role).toBe("owner");
  expect(doc.folder_id).toBeNull();
  await page.getByRole("link", { name: "Back to My docs" }).click();
  await page.waitForURL(/\/library$/);
  await expect(link(page, "My docs", stem)).toHaveAttribute("href", `/d/${id}`);

  // Opened inside a folder, the doc is made in that folder.
  const folder = await newFolder(page, named("Imports"));
  await page.goto(`/library/${folder.id}`);
  const inFolder = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open files" }).click();
  const textStem = `inbox-${RUN}${(++made).toString(36)}`;
  await (await inFolder).setFiles({ name: `${textStem}.txt`, mimeType: "text/plain", buffer: Buffer.from("A plain text line.\n") });
  await page.getByRole("dialog", { name: "Your files are ready" }).getByRole("button", { name: "Open doc", exact: true }).click();
  await page.waitForURL(/\/d\/d_[A-Za-z0-9]+$/, { timeout: 30_000 });
  const filed = await must<Doc>(page, "GET", `/v1/docs/${lastSegment(page)}`);
  expect(filed.title).toBe(textStem);
  expect(filed.folder_id).toBe(folder.id);
  await expect(page.locator(".ProseMirror")).toContainText("A plain text line.");

  // A file Silicon Write can't open: it says so, and nothing is made.
  await page.goto("/library");
  const before = (await must<{ docs: Doc[] }>(page, "GET", "/v1/docs")).docs.length;
  const bad = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open files" }).click();
  await (await bad).setFiles({ name: "drawing.xyz", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 4]) });
  const skipped = page.getByRole("dialog", { name: "Open files", exact: true });
  await expect(skipped.getByText("No supported files were selected.")).toBeVisible();
  await skipped.locator("summary").click();
  await expect(skipped.getByText("drawing.xyz", { exact: true })).toBeVisible();
  await expect(skipped.getByText("This file format is not supported.")).toBeVisible();
  await expect(page).toHaveURL(/\/library$/);
  expect((await must<{ docs: Doc[] }>(page, "GET", "/v1/docs")).docs.length).toBe(before);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Sharing                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

test("the share dialog: share with the friend by c:id, they open it from Shared with me, change their role, remove them", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const doc = await newDoc(carbon.page, named("Brief"), { markdown: "The brief, for review." });
  const page = carbon.page;
  await page.goto("/library");
  const dialog = await shareFromRow(page, doc.title);
  const people = dialog.getByRole("list", { name: "People with access" });
  await expect(people.getByRole("listitem")).toHaveCount(1);
  await expect(people.getByRole("listitem").first()).toContainText(carbon.id);

  const who = dialog.getByRole("textbox", { name: "Who to share with" });
  const share = dialog.getByRole("button", { name: "Share", exact: true });
  await expect(who).toBeFocused();
  await expect(share).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "Role", exact: true })).toContainText("Editor");

  // Nobody by that id: the service says so, and nothing is added.
  await who.fill(`c:nobody_${RUN}`);
  expect((await pressLookingUp(page, share, `/v1/docs/${doc.id}/sharing`)).status).toBe(404);
  await expect(page.getByText("Couldn't share").last()).toBeVisible();
  await expect(page.getByText(`c:nobody_${RUN}`).last()).toBeVisible();
  await expect(people.getByRole("listitem")).toHaveCount(1);
  // The owner already has it.
  await who.fill(carbon.id);
  expect((await pressLookingUp(page, share, `/v1/docs/${doc.id}/sharing`)).status).toBe(422);
  await expect(page.getByText("owns this doc already")).toBeVisible();
  await expect(people.getByRole("listitem")).toHaveCount(1);

  // The friend, as a viewer.
  await who.fill(friend.id);
  await choose(page, dialog.getByRole("combobox", { name: "Role", exact: true }), "Viewer");
  expect((await pressLookingUp(page, share, `/v1/docs/${doc.id}/sharing`)).status).toBe(201);
  await expect(page.getByText(`Shared with ${friend.id}`)).toBeVisible();
  await expect(who).toHaveValue("");
  const friendRow = people.getByRole("listitem").filter({ hasText: friend.id });
  await expect(friendRow).toBeVisible();
  const friendRole = dialog.getByRole("combobox", { name: `Role of ${friend.id}` });
  await expect(friendRole).toContainText("Viewer");
  let sharing = await must<Sharing>(page, "GET", `/v1/docs/${doc.id}/sharing`);
  expect(sharing.members.map(m => [m.account?.id, m.role, m.via, m.pending])).toEqual([[friend.id, "viewer", "doc", false]]);
  await shot(page, "desktop-share-dialog", false);

  // The friend finds it under Shared with me and opens it, read only.
  await friend.page.getByRole("navigation", { name: "Write", exact: true }).getByRole("link", { name: "Shared with me" }).click();
  await friend.page.waitForURL(/\/shared$/);
  const shared = row(friend.page, "Shared with me", doc.title);
  await expect(shared).toContainText(carbon.id);
  await shot(friend.page, "desktop-shared-with-me");
  await shared.getByRole("link", { name: doc.title }).click();
  await friend.page.waitForURL(new RegExp(`/d/${doc.id}$`));
  const editor = friend.page.locator(".ProseMirror");
  await expect(editor).toContainText("The brief, for review.");
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(friend.page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);
  await expect(friend.page.getByRole("link", { name: "Back to My docs" })).toHaveAttribute("href", "/library");
  expect((await must<Doc>(friend.page, "GET", `/v1/docs/${doc.id}`)).role).toBe("viewer");

  // Made an editor, they can edit.
  await choose(page, friendRole, "Editor");
  await expect(friendRole).toContainText("Editor");
  await expect.poll(async () => (await must<Doc>(friend.page, "GET", `/v1/docs/${doc.id}`)).role).toBe("editor");
  await friend.page.reload();
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await openFormatting(friend.page);
  await expect(friend.page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();

  // Then a commenter.
  await choose(page, friendRole, "Suggester");
  await expect(friendRole).toContainText("Suggester");
  sharing = await must<Sharing>(page, "GET", `/v1/docs/${doc.id}/sharing`);
  expect(sharing.members.map(m => m.role)).toEqual(["commenter"]);
  expect((await must<Doc>(friend.page, "GET", `/v1/docs/${doc.id}`)).role).toBe("commenter");

  // Removed: the doc closes for them (it was open) and leaves their lists.
  await dialog.getByRole("button", { name: `Remove ${friend.id}` }).click();
  await expect(friendRow).toHaveCount(0);
  expect((await must<Sharing>(page, "GET", `/v1/docs/${doc.id}/sharing`)).members).toEqual([]);
  await expect(friend.page.getByRole("heading", { name: "You no longer have access" })).toBeVisible({ timeout: 15_000 });
  expect((await call(friend.page, "GET", `/v1/docs/${doc.id}`)).status).toBe(404);
  await friend.page.goto("/shared");
  await expect(friend.page.getByRole("heading", { level: 1, name: "Shared with me" })).toBeVisible();
  await expect(link(friend.page, "Shared with me", doc.title)).toHaveCount(0);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("someone with view access sees who has it, can't share or change roles, and can leave", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const doc = await newDoc(carbon.page, named("Minutes"), { markdown: "Minutes of the meeting." });
  await shareDoc(carbon.page, doc.id, friend.id, "viewer");

  await friend.page.goto("/shared");
  const menu = await rowMenu(friend.page, doc.title);
  // A viewer's menu: share (to see who has it) and copy; never rename, move or trash.
  await expect(menu.getByRole("menuitem")).toHaveText(["Share", "Make a copy"]);
  await menu.getByRole("menuitem", { exact: true, name: "Share" }).click();
  const dialog = friend.page.getByRole("dialog", { name: "Share", exact: true });
  await expect(dialog.getByText("Only the owner and editors can share this.")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Who to share with" })).toHaveCount(0);
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Transfer to" })).toHaveCount(0);
  const people = dialog.getByRole("list", { name: "People with access" });
  await expect(people.getByRole("listitem").filter({ hasText: carbon.id })).toContainText("Owner");
  await expect(people.getByRole("listitem").filter({ hasText: friend.id })).toContainText("Viewer");
  await expect(dialog.getByText("Only people with access")).toBeVisible();
  // The service refuses what the dialog doesn't offer.
  const member = (await must<Sharing>(friend.page, "GET", `/v1/docs/${doc.id}/sharing`)).members[0]!;
  expect((await call(friend.page, "PATCH", `/v1/docs/${doc.id}/sharing/${member.id}`, { role: "editor" })).status).toBe(403);
  expect((await call(friend.page, "POST", `/v1/docs/${doc.id}/sharing`, { to: carbon.id, role: "editor" })).status).toBe(403);
  expect((await call(friend.page, "PUT", `/v1/docs/${doc.id}/public`, { access: "view" })).status).toBe(403);
  await shot(friend.page, "desktop-share-dialog-viewer", false);

  // Leaving: the doc is no longer shared with them.
  await dialog.getByRole("button", { name: "Leave" }).click();
  await expect.poll(async () => (await call(friend.page, "GET", `/v1/docs/${doc.id}`)).status).toBe(404);
  await friend.page.keyboard.press("Escape");
  await friend.page.reload();
  await expect(friend.page.getByRole("heading", { level: 1, name: "Shared with me" })).toBeVisible();
  await expect(link(friend.page, "Shared with me", doc.title)).toHaveCount(0);
  expect((await must<Sharing>(carbon.page, "GET", `/v1/docs/${doc.id}/sharing`)).members).toEqual([]);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("inviting an email that isn't on Silicon Accounts yet keeps a pending invite and emails them", async ({ browser }) => {
  const carbon = await signedIn(browser, "carbon");
  const { page } = carbon;
  const doc = await newDoc(page, named("Proposal"), { markdown: "For the new partner." });
  const email = `write-invitee-${RUN}${(++made).toString(36)}@example.test`;
  await page.goto("/library");
  const dialog = await shareFromRow(page, doc.title);
  await dialog.getByRole("textbox", { name: "Who to share with" }).fill(email);
  await choose(page, dialog.getByRole("combobox", { name: "Role", exact: true }), "Suggester");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByText(`Invited ${email}`)).toBeVisible();
  await expect(page.getByText("They get access when they sign in with this email.")).toBeVisible();
  const invited = dialog.getByRole("list", { name: "People with access" }).getByRole("listitem").filter({ hasText: email });
  await expect(invited).toContainText("Invited, not signed in yet");
  await expect(dialog.getByRole("combobox", { name: `Role of ${email}` })).toContainText("Suggester");
  const member = (await must<Sharing>(page, "GET", `/v1/docs/${doc.id}/sharing`)).members.find(m => m.email === email);
  expect(member?.pending).toBe(true);
  expect(member?.role).toBe("commenter");

  // The invite to join went out (the service's development outbox).
  const outbox = await (await page.request.get(`${API}/v1/dev/outbox`)).json() as { emails: { to: string; subject: string; body: string }[] };
  const mail = outbox.emails.find(e => e.to === email);
  expect(mail, `an email to ${email}`).toBeTruthy();
  expect(mail!.subject).toContain(doc.title);
  expect(mail!.body).toContain(`/d/${doc.id}`);

  // And it can be taken back.
  await dialog.getByRole("button", { name: `Remove ${email}` }).click();
  await expect(invited).toHaveCount(0);
  expect((await must<Sharing>(page, "GET", `/v1/docs/${doc.id}/sharing`)).members).toEqual([]);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
});

test("an editor's share dialog: they invite people, but can't change or remove anyone else, not even by inviting them again", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const doc = await newDoc(carbon.page, named("Agenda"), { markdown: "Items for Monday." });
  const pending = `write-pending-${RUN}${(++made).toString(36)}@example.test`;
  await shareDoc(carbon.page, doc.id, pending, "editor");
  await shareDoc(carbon.page, doc.id, friend.id, "editor");

  const page = friend.page;
  await page.goto("/shared");
  const dialog = await shareFromRow(page, doc.title);
  const people = dialog.getByRole("list", { name: "People with access" });
  const invited = people.getByRole("listitem").filter({ hasText: pending });
  // An editor can invite, sees everyone's role, and can leave; nothing more.
  await expect(dialog.getByRole("textbox", { name: "Who to share with" })).toBeVisible();
  await expect(invited).toContainText("Editor");
  await expect(dialog.getByRole("combobox", { name: `Role of ${pending}` })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: `Remove ${pending}` })).toHaveCount(0);
  await expect(people.getByRole("listitem").filter({ hasText: friend.id }).getByRole("button", { name: "Leave" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Who can open the link" })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Transfer to" })).toHaveCount(0);
  await shot(page, "desktop-share-dialog-editor", false);
  // Every row shows whole: who it is, and their role.
  expect.soft(await layoutProblems(page), "the editor's share dialog shows every row whole").toEqual([]);

  // They invite someone new, as a commenter: the owner sees it, with the editor as who invited them.
  const newcomer = `write-newcomer-${RUN}${(++made).toString(36)}@example.test`;
  await dialog.getByRole("textbox", { name: "Who to share with" }).fill(newcomer);
  await choose(page, dialog.getByRole("combobox", { name: "Role", exact: true }), "Suggester");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByText(`Invited ${newcomer}`)).toBeVisible();
  await expect(people.getByRole("listitem").filter({ hasText: newcomer })).toContainText("Suggester");
  const newcomerMember = (await must<Sharing>(carbon.page, "GET", `/v1/docs/${doc.id}/sharing`)).members.find(m => m.email === newcomer);
  expect(newcomerMember?.role).toBe("commenter");
  expect(newcomerMember?.invited_by?.id).toBe(friend.id);

  // Inviting the owner's pending invite again as a viewer would lower someone else's role: only the owner may do that
  // (docs/api.md, "only the owner can change or remove other people").
  await dialog.getByRole("textbox", { name: "Who to share with" }).fill(pending);
  await choose(page, dialog.getByRole("combobox", { name: "Role", exact: true }), "Viewer");
  const again = await answerTo(page, "POST", `/v1/docs/${doc.id}/sharing`, () => dialog.getByRole("button", { name: "Share", exact: true }).click());
  const role = (await must<Sharing>(carbon.page, "GET", `/v1/docs/${doc.id}/sharing`)).members.find(m => m.email === pending)?.role;
  expect.soft(role, `an editor inviting ${pending} again as viewer leaves the role its owner gave it (the service answered ${again.status} ${JSON.stringify(again.body).slice(0, 200)})`).toBe("editor");
  await expect.soft(invited, "the dialog still shows the owner's role for the invite").toContainText("Editor");
  expect(friend.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("the share and transfer boxes say what is wrong with what was typed, and nothing changes", async ({ browser }) => {
  const carbon = await signedIn(browser, "carbon");
  const { page } = carbon;
  const friendId = runAccounts().friend.id;
  const doc = await newDoc(page, named("Inputs"), { markdown: "Nothing to see." });
  await page.goto("/library");
  const dialog = await shareFromRow(page, doc.title);
  const who = dialog.getByRole("textbox", { name: "Who to share with" });
  const share = dialog.getByRole("button", { name: "Share", exact: true });
  /**
   * Once the toast titled `title` shows, the toasts about `typed` that blame Silicon Accounts ("didn't answer"). Read
   * once, at once: toasts expire, so an assertion that waits for none would pass by waiting them out.
   */
  const blamed = async (typed: string, title: string) => {
    await expect(page.getByText(title).last()).toBeVisible();
    await page.waitForTimeout(300);
    const toasts = await page.getByRole("region", { name: /^Notifications/ }).locator("li").filter({ hasText: typed }).allInnerTexts();
    return toasts.map(text => text.replace(/\s+/g, " ")).filter(text => /didn't answer/i.test(text));
  };

  // A handle without its c: is neither an id nor an email: a typo, not Silicon Accounts being down.
  const handle = friendId.replace(/^c:/, "");
  await who.fill(handle);
  const bare = await pressLookingUp(page, share, `/v1/docs/${doc.id}/sharing`);
  expect.soft(bare.status, `a handle without c: is invalid input (the service answered ${bare.status} ${JSON.stringify(bare.body).slice(0, 220)})`).toBe(422);
  expect.soft(await blamed(handle, "Couldn't share"), "the toast doesn't blame Silicon Accounts for a typo").toEqual([]);
  // The way mentions are written (@c:id): shared with them, or told how to write it, never "didn't answer".
  await who.fill(`@${friendId}`);
  const mention = await pressLookingUp(page, share, `/v1/docs/${doc.id}/sharing`);
  expect.soft(mention.status, `“@${friendId}” is shared with ${friendId} or refused as invalid input (the service answered ${mention.status} ${JSON.stringify(mention.body).slice(0, 220)})`).not.toBe(503);
  if (mention.status === 201) await must(page, "DELETE", `/v1/docs/${doc.id}/sharing/${(mention.body as Member).id}`, undefined, 204);
  expect((await must<Sharing>(page, "GET", `/v1/docs/${doc.id}/sharing`)).members).toEqual([]);

  // Transfers: to someone who doesn't exist, and to an email (only a c:id or si:id can take a doc over).
  await dialog.getByText("Transfer ownership", { exact: true }).click();
  const to = dialog.getByRole("textbox", { name: "Transfer to" });
  const transfer = dialog.getByRole("button", { name: "Transfer" });
  await to.fill(`c:nobody_${RUN}`);
  const unknown = await pressLookingUp(page, transfer, `/v1/docs/${doc.id}/transfer`);
  expect(unknown.status).toBe(404);
  await expect(page.getByText("Couldn't start the transfer").first()).toBeVisible();
  await expect(page.getByText(`The account c:nobody_${RUN} doesn't exist`).first()).toBeVisible();
  const email = `write-transfer-${RUN}${(++made).toString(36)}@example.test`;
  await to.fill(email);
  const byEmail = await pressLookingUp(page, transfer, `/v1/docs/${doc.id}/transfer`);
  expect.soft(byEmail.status, `a transfer to an email is refused as invalid input (the service answered ${byEmail.status} ${JSON.stringify(byEmail.body).slice(0, 220)})`).toBe(422);
  const emailToasts = await blamed(email, "Couldn't start the transfer");
  await shot(page, "desktop-share-dialog-input-errors", false);
  expect.soft(emailToasts, "the toast doesn't blame Silicon Accounts for an email in the c:id box").toEqual([]);
  const outgoing = (await must<{ outgoing: Transfer[] }>(page, "GET", "/v1/transfers")).outgoing.filter(t => t.item.id === doc.id);
  expect(outgoing).toEqual([]);
  expect((await must<Doc>(page, "GET", `/v1/docs/${doc.id}`)).owner.id).toBe(carbon.id);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
});

test("a shared folder: the friend opens it from Shared with me, and a doc they make in it belongs to the folder's owner", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const team = await newFolder(carbon.page, named("Team notes"));
  const sub = await newFolder(carbon.page, named("Sub"), team.id);
  const existing = await newDoc(carbon.page, named("Existing"), { folder_id: team.id, markdown: "Already here." });

  await carbon.page.goto("/library");
  const dialog = await shareFromRow(carbon.page, team.name);
  await expect(dialog.getByText("Everyone you add can open everything in this folder, now and later.")).toBeVisible();
  // No public link for folders.
  await expect(dialog.getByRole("region", { name: "Public link" })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Who to share with" }).fill(friend.id);
  expect((await pressLookingUp(carbon.page, dialog.getByRole("button", { name: "Share", exact: true }), `/v1/folders/${team.id}/sharing`)).status).toBe(201);
  await expect(carbon.page.getByText(`Shared with ${friend.id}`)).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: `Role of ${friend.id}` })).toContainText("Editor");
  await carbon.page.keyboard.press("Escape");

  // The friend: under Shared with me, then inside it.
  await friend.page.goto("/shared");
  const shared = row(friend.page, "Shared with me", team.name);
  await expect(shared).toContainText(carbon.id);
  await shared.getByRole("link", { name: team.name }).click();
  await friend.page.waitForURL(new RegExp(`/library/${team.id}$`));
  await expect(friend.page.getByRole("heading", { level: 1, name: team.name, exact: true })).toBeVisible();
  await expect(friend.page.getByText(`${carbon.id}'s folder, shared with you as editor.`)).toBeVisible();
  const crumbs = friend.page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link")).toHaveText(["Shared with me"]);
  await expect(crumbs.getByRole("link", { name: "Shared with me" })).toHaveAttribute("href", "/shared");
  await expect(link(friend.page, team.name, existing.title)).toBeVisible();
  await expect(link(friend.page, team.name, sub.name)).toBeVisible();
  await shot(friend.page, "desktop-shared-folder");
  await link(friend.page, team.name, sub.name).click();
  await friend.page.waitForURL(new RegExp(`/library/${sub.id}$`));
  await expect(crumbs.getByRole("link")).toHaveText(["Shared with me", team.name]);
  await crumbs.getByRole("link", { name: team.name }).click();
  await friend.page.waitForURL(new RegExp(`/library/${team.id}$`));

  // A doc the friend makes here is the folder owner's, and still shows who made it.
  await friend.page.getByRole("button", { name: "New doc" }).first().click();
  await friend.page.waitForURL(/\/d\/d_/);
  const madeId = lastSegment(friend.page);
  await expect(friend.page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
  const theirDoc = await must<Doc>(friend.page, "GET", `/v1/docs/${madeId}`);
  expect(theirDoc.owner.id).toBe(carbon.id);
  expect(theirDoc.created_by.id).toBe(friend.id);
  expect(theirDoc.folder_id).toBe(team.id);
  expect(theirDoc.role).toBe("editor");
  await expect(friend.page.getByRole("link", { name: "Back to My docs" })).toHaveAttribute("href", "/library");
  await carbon.page.goto(`/library/${team.id}`);
  const theirs = list(carbon.page, team.name).getByRole("listitem").filter({ has: carbon.page.locator(`a[href="/d/${madeId}"]`) });
  await expect(theirs).toBeVisible();
  await expect.soft(theirs, "the owner's folder shows who made the doc (UNDERSTANDING: “The doc still shows who created it.”)").toContainText(friend.id);

  // The doc's own share dialog shows the friend's access through the folder.
  const docDialog = await shareFromRow(carbon.page, existing.title);
  await expect(docDialog.getByRole("list", { name: "People with access" }).getByRole("listitem").filter({ hasText: friend.id })).toContainText(`through the folder “${team.name}”`);
  await carbon.page.keyboard.press("Escape");

  // The ting that told the friend links to the folder, and the link opens it.
  const outbox = await (await carbon.page.request.get(`${API}/v1/dev/outbox`)).json() as { tings: { type: string; data: { id?: string; url?: string } }[] };
  const ting = outbox.tings.find(t => t.type === "write.doc.shared" && t.data.id === team.id);
  expect(ting, "a write.doc.shared ting for the folder").toBeTruthy();
  const path = new URL(ting!.data.url!).pathname;
  const opened = await friend.page.goto(path);
  expect.soft(opened?.status(), `the folder's link ${ting!.data.url} opens (it is ${path})`).toBe(200);
  await expect.soft(friend.page.getByRole("heading", { level: 1, name: team.name, exact: true }), `the folder's link ${ting!.data.url} opens the folder`).toBeVisible();
  await shot(friend.page, "desktop-folder-link-from-ting");

  // The invitation email for the folder (an address not on Silicon Accounts yet) links to the folder's page too.
  const invitee = `write-folder-invitee-${RUN}${(++made).toString(36)}@example.test`;
  await must(carbon.page, "POST", `/v1/folders/${team.id}/sharing`, { to: invitee, role: "viewer" }, 201);
  const mails = (await (await carbon.page.request.get(`${API}/v1/dev/outbox`)).json()) as { emails: { to: string; subject: string; body: string }[] };
  const mail = mails.emails.find(e => e.to === invitee);
  expect(mail, `an invitation email to ${invitee}`).toBeTruthy();
  const mailLink = /https?:\/\/\S+/.exec(mail!.body)?.[0] ?? "";
  expect.soft(new URL(mailLink).pathname, `the folder invitation email links to the folder's page (it links to ${mailLink})`).toBe(`/library/${team.id}`);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("a folder shared as viewer: the friend opens everything in it, can't add, rename, move or trash anything, never sees the folder above it, and can leave", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const parent = await newFolder(carbon.page, named("Private parent"));
  const shared = await newFolder(carbon.page, named("Reading room"), parent.id);
  const inner = await newFolder(carbon.page, named("Shelf"), shared.id);
  const doc = await newDoc(carbon.page, named("Catalogue"), { folder_id: shared.id, markdown: "Every book we have." });
  await must(carbon.page, "POST", `/v1/folders/${shared.id}/sharing`, { to: friend.id, role: "viewer" }, 201);

  const page = friend.page;
  await page.goto("/shared");
  await expect(link(page, "Shared with me", shared.name)).toBeVisible();
  await expect(link(page, "Shared with me", parent.name)).toHaveCount(0);
  await link(page, "Shared with me", shared.name).click();
  await page.waitForURL(new RegExp(`/library/${shared.id}$`));
  await expect(page.getByText(`${carbon.id}'s folder, shared with you as viewer.`)).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link")).toHaveText(["Shared with me"]);
  // The folder it sits in is not theirs to see.
  await expect(page.getByText(parent.name)).toHaveCount(0);
  await expect(link(page, shared.name, doc.title)).toBeVisible();
  await expect(link(page, shared.name, inner.name)).toBeVisible();
  // Nothing to add; the folder's people instead of Share folder.
  for (const action of ["New doc", "New folder", "Open files", "Open folder", "Share folder"]) await expect(page.getByRole("button", { name: action })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "People" })).toBeVisible();
  await shot(page, "desktop-folder-shared-as-viewer");
  // Selecting a doc is available to viewers too; editing and ownership actions remain absent.
  await expect((await rowMenu(page, doc.title)).getByRole("menuitem")).toHaveText(["Select", "Share", "Make a copy"]);
  await page.keyboard.press("Escape");
  await expect((await rowMenu(page, inner.name)).getByRole("menuitem")).toHaveText(["Share"]);
  await page.keyboard.press("Escape");
  // The service refuses what the page doesn't offer.
  expect((await call(page, "PATCH", `/v1/docs/${doc.id}`, { title: "Renamed by a viewer" })).status).toBe(403);
  expect((await call(page, "PATCH", `/v1/folders/${inner.id}`, { name: "Renamed by a viewer" })).status).toBe(403);
  expect((await call(page, "POST", "/v1/docs", { title: "Sneaked in", folder_id: shared.id })).status).toBe(403);
  expect((await call(page, "DELETE", `/v1/docs/${doc.id}`)).status).toBe(403);

  // A doc inside opens read only, with the way back to Home.
  await link(page, shared.name, doc.title).click();
  await page.waitForURL(new RegExp(`/d/${doc.id}$`));
  await expect(page.locator(".ProseMirror")).toContainText("Every book we have.");
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("link", { name: "Back to My docs" })).toHaveAttribute("href", "/library");
  // Deeper in, the breadcrumbs start at what was shared.
  await page.goto(`/library/${inner.id}`);
  await expect(crumbs.getByRole("link")).toHaveText(["Shared with me", shared.name]);
  await expect(page.getByText(parent.name)).toHaveCount(0);

  // Leaving, from the folder's People.
  await page.goto(`/library/${shared.id}`);
  await page.getByRole("button", { name: "People" }).click();
  const dialog = page.getByRole("dialog", { name: "Share", exact: true });
  await expect(dialog.getByText("Only the owner and editors can share this.")).toBeVisible();
  await dialog.getByRole("button", { name: "Leave" }).click();
  await expect.poll(async () => (await call(page, "GET", `/v1/folders/${shared.id}`)).status).toBe(404);
  expect((await call(page, "GET", `/v1/docs/${doc.id}`)).status).toBe(404);
  await page.goto("/shared");
  await expect(page.getByRole("heading", { level: 1, name: "Shared with me" })).toBeVisible();
  await expect(link(page, "Shared with me", shared.name)).toHaveCount(0);
  // Its address now says it can't be opened, and lists nothing of it.
  await page.goto(`/library/${shared.id}`);
  await expect(page.getByText("This folder doesn't exist, or you don't have access to it.")).toBeVisible();
  await expect(page.getByRole("link", { name: doc.title })).toHaveCount(0);
  await shot(page, "desktop-folder-after-leaving");
  await expect.soft(page.getByRole("heading", { level: 1, name: "My docs" }), "a folder that can't be opened isn't shown under the heading My docs").toHaveCount(0);
  await expect.soft(page.getByRole("button", { name: "New doc" }), "a folder that can't be opened offers no New doc (it can only fail)").toHaveCount(0);
  expect((await must<Sharing>(carbon.page, "GET", `/v1/folders/${shared.id}/sharing`)).members).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("a folder editor moves a doc around inside the shared folder with the move dialog, which offers only that owner's folders they can edit", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const studio = await newFolder(carbon.page, named("Studio"));
  const drafts = await newFolder(carbon.page, named("Drafts"), studio.id);
  const elsewhere = await newFolder(carbon.page, named("Not shared"));
  const sketch = await newDoc(carbon.page, named("Sketch"), { folder_id: studio.id, markdown: "First lines." });
  await must(carbon.page, "POST", `/v1/folders/${studio.id}/sharing`, { to: friend.id, role: "editor" }, 201);
  const own = await newFolder(friend.page, named("Friend's own"));

  const page = friend.page;
  await page.goto(`/library/${studio.id}`);
  await (await rowMenu(page, sketch.title)).getByRole("menuitem", { exact: true, name: "Move" }).click();
  const move = page.getByRole("dialog", { name: `Move “${sketch.title}”` });
  const places = move.getByRole("listbox", { name: "Where to" });
  await expect(places.getByRole("option", { name: studio.name, exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(places.getByRole("option", { name: drafts.name, exact: true })).toBeVisible();
  // Not the owner's folders the friend can't open, nor the friend's own (a doc only moves within one owner's folders).
  await expect(places.getByRole("option", { name: elsewhere.name, exact: true })).toHaveCount(0);
  await expect(places.getByRole("option", { name: own.name, exact: true })).toHaveCount(0);
  await shot(page, "desktop-move-dialog-folder-editor", false);
  // Only the owner can move a doc out to the top level: offering it to anyone else can only end in an error.
  const topLevel = places.getByRole("option", { name: "Top level" });
  await expect.soft(topLevel, "the move dialog doesn't offer Top level to someone who isn't the doc's owner").toHaveCount(0);
  if (await topLevel.count()) {
    await topLevel.click();
    const refused = await answerTo(page, "PATCH", `/v1/docs/${sketch.id}`, () => move.getByRole("button", { name: "Move here" }).click());
    expect(refused.status, "the service refuses the top level to a folder editor").toBe(403);
    await expect(page.getByText("It couldn't be moved")).toBeVisible();
    await expect(move).toBeVisible();
  }
  await places.getByRole("option", { name: drafts.name, exact: true }).click();
  await move.getByRole("button", { name: "Move here" }).click();
  await expect(move).toBeHidden();
  await expect(link(page, studio.name, sketch.title)).toHaveCount(0);
  expect((await must<Doc>(page, "GET", `/v1/docs/${sketch.id}`)).folder_id).toBe(drafts.id);
  await link(page, studio.name, drafts.name).click();
  await page.waitForURL(new RegExp(`/library/${drafts.id}$`));
  await expect(link(page, drafts.name, sketch.title)).toBeVisible();
  // The owner sees it moved, and still owns it.
  const moved = await must<Doc>(carbon.page, "GET", `/v1/docs/${sketch.id}`);
  expect(moved.folder_id).toBe(drafts.id);
  expect(moved.owner.id).toBe(carbon.id);
  await carbon.context.close();
  await friend.context.close();
});

test("names reach other Carbons exactly as typed: markup in a doc or folder name is shown, never run", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const docName = `<img src=x onerror="window.__ran=1"> & <b>bold</b> ${RUN}${(++made).toString(36)}`;
  const folderName = `<script>window.__ran=2</script> “quoted” ${RUN}${(++made).toString(36)}`;
  const folder = await newFolder(carbon.page, folderName);
  const doc = await newDoc(carbon.page, docName, { folder_id: folder.id, markdown: "Plain text." });
  await shareDoc(carbon.page, doc.id, friend.id, "viewer");
  const ran = (page: Page) => page.evaluate(() => (window as unknown as { __ran?: number }).__ran ?? null);

  // The owner: the folder's page, its breadcrumbs, the row, and the share dialog's title.
  await carbon.page.goto(`/library/${folder.id}`);
  await expect(carbon.page.getByRole("heading", { level: 1, name: folderName, exact: true })).toBeVisible();
  await expect(carbon.page.getByRole("navigation", { name: "Breadcrumb" }).locator("[aria-current=page]")).toHaveText(folderName);
  await expect(link(carbon.page, folderName, docName)).toBeVisible();
  const dialog = await shareFromRow(carbon.page, docName);
  await dialog.getByText("Transfer ownership", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Transfer to" }).fill(friend.id);
  expect((await pressLookingUp(carbon.page, dialog.getByRole("button", { name: "Transfer" }), `/v1/docs/${doc.id}/transfer`)).status).toBe(200);
  await expect(carbon.page.getByText(`Asked ${friend.id} to take it over`)).toBeVisible();
  await carbon.page.keyboard.press("Escape");

  // The friend: Shared with me, the offer, and the doc's own page.
  await friend.page.goto("/shared");
  await expect(link(friend.page, "Shared with me", docName)).toBeVisible();
  await friend.page.goto("/library");
  const offer = friend.page.getByRole("region", { name: "Offered to you" }).locator(":scope > div").filter({ hasText: docName });
  await expect(offer).toContainText(`wants to give you the doc “${docName}”.`);
  await expect(offer.locator("img, b, script")).toHaveCount(0);
  await offer.getByRole("button", { name: "Decline" }).click();
  await expect(offer).toHaveCount(0);
  await friend.page.goto(`/d/${doc.id}`);
  await expect(friend.page.getByRole("banner").getByRole("heading", { level: 1 })).toHaveText(docName);
  expect(await friend.page.title()).toContain(docName);
  expect(await ran(carbon.page)).toBeNull();
  expect(await ran(friend.page)).toBeNull();
  expect(carbon.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Transfers                                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

test("a transfer offered to the friend shows on their My docs with Accept and Decline, and Accept moves the doc", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const outbox = await newFolder(carbon.page, named("Outbox"));
  const handover = await newDoc(carbon.page, named("Handover"), { folder_id: outbox.id, markdown: "Yours now." });
  const keep = await newDoc(carbon.page, named("Keep"), { markdown: "Still mine." });
  const page = carbon.page;

  // Offer the doc in the folder from its share dialog.
  await page.goto(`/library/${outbox.id}`);
  let dialog = await shareFromRow(page, handover.title);
  await dialog.getByText("Transfer ownership", { exact: true }).click();
  const to = dialog.getByRole("textbox", { name: "Transfer to" });
  await expect(dialog.getByRole("button", { name: "Transfer" })).toBeDisabled();
  // Not to yourself.
  await to.fill(carbon.id);
  expect((await pressLookingUp(page, dialog.getByRole("button", { name: "Transfer" }), `/v1/docs/${handover.id}/transfer`)).status).toBe(422);
  await expect(page.getByText("You already own this.")).toBeVisible();
  await to.fill(friend.id);
  expect((await pressLookingUp(page, dialog.getByRole("button", { name: "Transfer" }), `/v1/docs/${handover.id}/transfer`)).status).toBe(200);
  await expect(page.getByText(`Asked ${friend.id} to take it over`)).toBeVisible();
  await expect(page.getByText("It moves once they accept.")).toBeVisible();
  await expect(to).toHaveValue("");
  // Nothing moves before they accept.
  expect((await must<Doc>(page, "GET", `/v1/docs/${handover.id}`)).owner.id).toBe(carbon.id);
  await page.keyboard.press("Escape");
  // And the other doc, from My docs.
  await page.goto("/library");
  dialog = await shareFromRow(page, keep.title);
  await dialog.getByText("Transfer ownership", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Transfer to" }).fill(friend.id);
  expect((await pressLookingUp(page, dialog.getByRole("button", { name: "Transfer" }), `/v1/docs/${keep.id}/transfer`)).status).toBe(200);
  await expect(page.getByText(`Asked ${friend.id} to take it over`)).toBeVisible();
  await page.keyboard.press("Escape");

  // The friend's My docs offers both.
  await friend.page.goto("/library");
  const offers = friend.page.getByRole("region", { name: "Offered to you" });
  const offer = offers.locator(":scope > div").filter({ hasText: handover.title });
  await expect(offer).toContainText(`${carbon.id} wants to give you the doc “${handover.title}”.`);
  await expect(offer.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(offer.getByRole("button", { name: "Decline" })).toBeVisible();
  const other = offers.locator(":scope > div").filter({ hasText: keep.title });
  await expect(other).toBeVisible();
  await shot(friend.page, "desktop-transfer-offers");

  // Accept: it's theirs, at their top level, and the previous owner can still edit it.
  await offer.getByRole("button", { name: "Accept" }).click();
  await expect(friend.page.getByText(`“${handover.title}” is yours now`)).toBeVisible();
  await expect(offer).toHaveCount(0);
  await expect(link(friend.page, "My docs", handover.title)).toHaveAttribute("href", `/d/${handover.id}`);
  const theirs = await must<Doc>(friend.page, "GET", `/v1/docs/${handover.id}`);
  expect(theirs.owner.id).toBe(friend.id);
  expect(theirs.role).toBe("owner");
  expect(theirs.folder_id).toBeNull();
  expect((await must<Doc>(page, "GET", `/v1/docs/${handover.id}`)).role).toBe("editor");
  await page.goto(`/library/${outbox.id}`);
  await expect(page.getByRole("heading", { level: 1, name: outbox.name })).toBeVisible();
  await expect(link(page, outbox.name, handover.title)).toHaveCount(0);
  await page.goto("/shared");
  await expect(row(page, "Shared with me", handover.title)).toContainText(friend.id);

  // Decline: nothing moves.
  await other.getByRole("button", { name: "Decline" }).click();
  await expect(friend.page.getByText("Declined", { exact: true })).toBeVisible();
  await expect(other).toHaveCount(0);
  await expect(offers).toHaveCount(0);
  await expect(link(friend.page, "My docs", keep.title)).toHaveCount(0);
  expect((await must<Doc>(page, "GET", `/v1/docs/${keep.id}`)).owner.id).toBe(carbon.id);
  const transfers = await must<{ incoming: Transfer[] }>(friend.page, "GET", "/v1/transfers");
  expect(transfers.incoming.find(t => t.item.id === handover.id)?.status).toBe("accepted");
  expect(transfers.incoming.find(t => t.item.id === keep.id)?.status).toBe("declined");
  expect(carbon.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("a folder transferred to the friend moves to them with everything in it", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const folder = await newFolder(carbon.page, named("Handbook"));
  const chapter = await newDoc(carbon.page, named("Chapter"), { folder_id: folder.id, markdown: "Chapter one." });

  // From the folder's own page.
  await carbon.page.goto(`/library/${folder.id}`);
  await carbon.page.getByRole("button", { name: "Share folder" }).click();
  const dialog = carbon.page.getByRole("dialog", { name: "Share", exact: true });
  await dialog.getByText("Transfer ownership", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Transfer to" }).fill(friend.id);
  expect((await pressLookingUp(carbon.page, dialog.getByRole("button", { name: "Transfer" }), `/v1/folders/${folder.id}/transfer`)).status).toBe(200);
  await expect(carbon.page.getByText(`Asked ${friend.id} to take it over`)).toBeVisible();

  await friend.page.goto("/library");
  const offer = friend.page.getByRole("region", { name: "Offered to you" }).locator(":scope > div").filter({ hasText: folder.name });
  await expect(offer).toContainText(`${carbon.id} wants to give you the folder “${folder.name}”.`);
  await offer.getByRole("button", { name: "Accept" }).click();
  await expect(friend.page.getByText(`“${folder.name}” is yours now`)).toBeVisible();
  await link(friend.page, "My docs", folder.name).click();
  await friend.page.waitForURL(new RegExp(`/library/${folder.id}$`));
  await expect(friend.page.getByRole("heading", { level: 1, name: folder.name })).toBeVisible();
  await expect(friend.page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link")).toHaveText(["My docs"]);
  await expect(link(friend.page, folder.name, chapter.title)).toBeVisible();
  expect((await must<Doc>(friend.page, "GET", `/v1/docs/${chapter.id}`)).owner.id).toBe(friend.id);
  expect((await must<Folder>(carbon.page, "GET", `/v1/folders/${folder.id}`)).role).toBe("editor");
  await carbon.page.goto("/library");
  await expect(carbon.page.getByRole("heading", { level: 1, name: "My docs" })).toBeVisible();
  await expect(link(carbon.page, "My docs", folder.name)).toHaveCount(0);
  expect(carbon.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("an offer for a doc its owner then puts in the trash is withdrawn, and the doc stays in its owner's trash", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const doc = await newDoc(carbon.page, named("Second thoughts"), { markdown: "Not for handing over after all." });
  const page = carbon.page;
  await page.goto("/library");
  const dialog = await shareFromRow(page, doc.title);
  await dialog.getByText("Transfer ownership", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "Transfer to" }).fill(friend.id);
  expect((await pressLookingUp(page, dialog.getByRole("button", { name: "Transfer" }), `/v1/docs/${doc.id}/transfer`)).status).toBe(200);
  await expect(page.getByText(`Asked ${friend.id} to take it over`)).toBeVisible();
  // The share dialog shows nothing about the offer once made, and has no way to take it back.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // So the owner changes their mind the one way the page offers: the doc goes to the trash.
  await (await rowMenu(page, doc.title)).getByRole("menuitem", { exact: true, name: "Move to the trash" }).click();
  await expect(page.getByText(`Moved “${doc.title}” to the trash`)).toBeVisible();
  // "A doc in the trash is only its owner's": nobody else can open it now…
  expect((await call(friend.page, "GET", `/v1/docs/${doc.id}`)).status).toBe(404);

  // …yet the friend's My docs still offers it.
  const loaded = friend.page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/transfers" && r.status() === 200);
  await friend.page.goto("/library");
  await loaded;
  await expect(friend.page.getByRole("heading", { level: 1, name: "My docs" })).toBeVisible();
  const offer = friend.page.getByRole("region", { name: "Offered to you" }).locator(":scope > div").filter({ hasText: doc.title });
  await shot(friend.page, "desktop-offer-of-a-doc-in-the-trash");
  await expect.soft(offer, "an offer for a doc in the trash is no longer offered").toHaveCount(0);
  if (await offer.count()) {
    const accepted = await answerTo(friend.page, "POST", `/v1/transfers/${(await must<{ incoming: Transfer[] }>(friend.page, "GET", "/v1/transfers")).incoming.find(t => t.item.id === doc.id)!.id}/accept`, () => offer.getByRole("button", { name: "Accept" }).click());
    expect.soft(accepted.status, `accepting an offer for a doc in the trash is refused (the service answered ${accepted.status})`).toBeGreaterThanOrEqual(400);
  }
  // Whatever the friend did, the doc is still the owner's, in the owner's trash, to restore at any time.
  const now = await call<Doc>(page, "GET", `/v1/docs/${doc.id}`);
  expect.soft(now.body?.owner?.id, "the doc the owner put in the trash still belongs to them").toBe(carbon.id);
  await page.goto("/trash");
  await expect(page.getByRole("heading", { level: 1, name: "Trash" })).toBeVisible();
  await expect.soft(row(page, "Trash", doc.title), "the doc is still in its owner's trash").toBeVisible();
  const theirTrash = (await must<Library>(friend.page, "GET", "/v1/library?view=trash")).docs.map(d => d.id);
  expect.soft(theirTrash, "the doc didn't end up in the friend's trash").not.toContain(doc.id);
  await carbon.context.close();
  await friend.context.close();
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Recent and Search                                                                                                */
/* ---------------------------------------------------------------------------------------------------------------- */

test("Recent lists every doc you can open, most recently changed first", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const older = await newDoc(carbon.page, named("Older"), { markdown: "First draft." });
  const newer = await newDoc(carbon.page, named("Newer"), { markdown: "Second draft." });
  const fromFriend = await newDoc(friend.page, named("From the friend"), { markdown: "Shared with you." });
  await shareDoc(friend.page, fromFriend.id, carbon.id, "viewer");
  const gone = await newDoc(carbon.page, named("Gone"), { markdown: "Trashed." });
  await must(carbon.page, "DELETE", `/v1/docs/${gone.id}`, undefined, 204);
  const page = carbon.page;

  await page.getByRole("navigation", { name: "Write", exact: true }).getByRole("link", { name: "Recent" }).click();
  await page.waitForURL(/\/recent$/);
  await expect(page.getByRole("heading", { level: 1, name: "Recent" })).toBeVisible();
  const titles = () => list(page, "Recent").getByRole("link").allTextContents();
  await expect.poll(titles).toContain(fromFriend.title);
  let shown = await titles();
  expect(shown.indexOf(fromFriend.title)).toBeLessThan(shown.indexOf(newer.title));
  expect(shown.indexOf(newer.title)).toBeLessThan(shown.indexOf(older.title));
  expect(shown).not.toContain(gone.title);
  await expect(row(page, "Recent", fromFriend.title)).toContainText(friend.id);

  // Changing the older doc brings it to the top.
  await must(page, "POST", `/v1/docs/${older.id}/edits`, { edits: [{ old: "First draft.", new: "First draft, changed." }] });
  await page.reload();
  await expect.poll(async () => (await titles())[0]).toBe(older.title);
  shown = await titles();
  expect(shown.indexOf(fromFriend.title)).toBeLessThan(shown.indexOf(newer.title));
  await shot(page, "desktop-recent");

  // The page says it lists every doc you can open. With more than 30 of them, it either does, or doesn't say so.
  for (let have = (await must<{ docs: Doc[] }>(page, "GET", "/v1/docs")).docs.length; have <= 31; have++) await newDoc(page, named("Filler"));
  const total = (await must<{ docs: Doc[] }>(page, "GET", "/v1/docs")).docs.length;
  await page.reload();
  await expect(list(page, "Recent").getByRole("link").first()).toBeVisible();
  const listed = (await titles()).length;
  if (listed < total) await expect.soft(page.getByText("Every doc you can open", { exact: false }), `Recent lists ${listed} of the ${total} docs this Carbon can open, so it doesn't say it lists every one`).toHaveCount(0);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("Search finds a doc by its text or title, and only docs you can open", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const term = word("zephyr");
  const doc = await newDoc(carbon.page, named("Field notes"), { markdown: `# Spring\n\nThe ${term} migrates north in spring, a little earlier each year.\n` });
  await indexed(carbon.page, term, doc.id);
  const page = carbon.page;

  await page.getByRole("navigation", { name: "Write", exact: true }).getByRole("link", { name: "Search" }).click();
  await page.waitForURL(/\/search$/);
  const field = page.getByRole("searchbox", { name: "Search docs" });
  await expect(field).toBeFocused();
  await field.fill(term);
  const results = list(page, "Results");
  const hit = results.getByRole("listitem").filter({ hasText: doc.title });
  await expect(hit.getByRole("link", { name: doc.title })).toHaveAttribute("href", `/d/${doc.id}`);
  await expect(hit.locator("strong")).toHaveText(term);
  await expect(hit).toContainText("migrates north");
  await expect(hit).toContainText(carbon.id);
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${term}$`));
  await shot(page, "desktop-search");
  // The address keeps the search.
  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search docs" })).toHaveValue(term);
  await expect(hit).toBeVisible();
  // The title finds it too.
  await field.fill(doc.title);
  await expect(hit).toBeVisible();
  // Nothing matches.
  const none = word("nomatch");
  await field.fill(none);
  await expect(results).toContainText(`Nothing matches “${none}”.`);
  // Open a result.
  await field.fill(term);
  await hit.getByRole("link", { name: doc.title }).click();
  await page.waitForURL(new RegExp(`/d/${doc.id}$`));
  await expect(page.locator(".ProseMirror")).toContainText(`The ${term} migrates north`);

  // The friend can't find what isn't shared with them; once it is, they can.
  await friend.page.goto(`/search?q=${term}`);
  await expect(list(friend.page, "Results")).toContainText(`Nothing matches “${term}”.`);
  await shareDoc(carbon.page, doc.id, friend.id, "viewer");
  await friend.page.reload();
  await expect(list(friend.page, "Results").getByRole("link", { name: doc.title })).toBeVisible();
  expect(carbon.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("Search leaves out docs in the trash, and finds docs inside a folder shared with you", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const binnedTerm = word("quokka");
  const binned = await newDoc(carbon.page, named("Binned"), { markdown: `The ${binnedTerm} was here.` });
  await indexed(carbon.page, binnedTerm, binned.id);
  await must(carbon.page, "DELETE", `/v1/docs/${binned.id}`, undefined, 204);
  await carbon.page.goto(`/search?q=${binnedTerm}`);
  await expect(list(carbon.page, "Results")).toContainText(`Nothing matches “${binnedTerm}”.`);
  // Restored, it's found again.
  await must(carbon.page, "POST", `/v1/docs/${binned.id}/restore`);
  await carbon.page.reload();
  await expect(list(carbon.page, "Results").getByRole("link", { name: binned.title })).toHaveAttribute("href", `/d/${binned.id}`);

  // A doc inside a folder shared with the friend (not shared on its own) is theirs to find.
  const folderTerm = word("pangolin");
  const folder = await newFolder(carbon.page, named("Field kit"));
  const sub = await newFolder(carbon.page, named("Logs"), folder.id);
  const deep = await newDoc(carbon.page, named("Field log"), { folder_id: sub.id, markdown: `Saw a ${folderTerm} today.` });
  await indexed(carbon.page, folderTerm, deep.id);
  await friend.page.goto(`/search?q=${folderTerm}`);
  await expect(list(friend.page, "Results")).toContainText(`Nothing matches “${folderTerm}”.`);
  await must(carbon.page, "POST", `/v1/folders/${folder.id}/sharing`, { to: friend.id, role: "viewer" }, 201);
  await friend.page.reload();
  const hit = list(friend.page, "Results").getByRole("listitem").filter({ hasText: deep.title });
  await expect(hit.getByRole("link", { name: deep.title })).toHaveAttribute("href", `/d/${deep.id}`);
  await expect(hit).toContainText(carbon.id);
  // The page rewrites its address a moment after it loads, which drops a click made before that (the next test).
  await friend.page.waitForTimeout(600);
  await hit.getByRole("link", { name: deep.title }).click();
  await friend.page.waitForURL(new RegExp(`/d/${deep.id}$`));
  await expect(friend.page.locator(".ProseMirror")).toContainText(`Saw a ${folderTerm} today.`);
  expect(carbon.errors).toEqual([]);
  expect(friend.errors).toEqual([]);
  await carbon.context.close();
  await friend.context.close();
});

test("a search result clicked as soon as it shows opens, even on a slow connection", async ({ browser }) => {
  test.setTimeout(180_000);
  const carbon = await signedIn(browser, "carbon");
  const { page } = carbon;
  const term = word("heron");
  const doc = await newDoc(page, named("Wading birds"), { markdown: `The grey ${term} stands still.` });
  await indexed(page, term, doc.id);
  // The doc's page takes 800 ms to arrive, as it can on a phone or a slow network.
  await page.route(url => url.pathname === `/d/${doc.id}` && url.searchParams.has("_rsc"), async route => {
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.continue();
  });
  // Someone follows a link to a search (or reloads one) and clicks the first result the moment it shows.
  await page.goto(`/search?q=${term}`);
  const result = list(page, "Results").getByRole("link", { name: doc.title });
  await expect(result).toBeVisible();
  await result.click();
  const opened = await page.waitForURL(new RegExp(`/d/${doc.id}$`), { timeout: 10_000 }).then(() => true, () => false);
  if (!opened) await shot(page, "desktop-search-click-dropped");
  expect.soft(opened, `the click on “${doc.title}” opens it (the page stayed at ${new URL(page.url()).pathname}${new URL(page.url()).search})`).toBe(true);
  // Clicked again, it does open.
  if (!opened) {
    await result.click();
    await page.waitForURL(new RegExp(`/d/${doc.id}$`), { timeout: 15_000 });
  }
  await expect(page.locator(".ProseMirror")).toContainText(`The grey ${term} stands still.`);
  expect(carbon.errors).toEqual([]);
  await carbon.context.close();
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Public docs                                                                                                      */
/* ---------------------------------------------------------------------------------------------------------------- */

test("a public doc opens signed out, read only, and once private again the same link sends to sign in", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const friend = await signedIn(browser, "friend");
  const term = word("lantern");
  const doc = await newDoc(carbon.page, named("Open letter"), { markdown: `# Dear readers\n\nAnyone with the link can read this ${term}.\n` });
  await carbon.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = carbon.page;
  await page.goto("/library");
  const dialog = await shareFromRow(page, doc.title);
  const linkAccess = dialog.getByRole("combobox", { name: "Who can open the link" });
  await expect(linkAccess).toContainText("Only people with access");
  await expect(dialog.getByText("a doc only opens for the people above")).toBeVisible();

  // One switch makes it public.
  await choose(page, linkAccess, "Anyone with the link can view");
  await expect(linkAccess).toContainText("Anyone with the link can view");
  await expect(dialog.getByText("the doc is just reachable by its link")).toBeVisible();
  expect((await must<Doc>(page, "GET", `/v1/docs/${doc.id}`)).public_access).toBe("view");
  await dialog.getByRole("button", { name: "Copy link" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Copy link: Copied" })).toBeAttached();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${BASE}/d/${doc.id}`);
  await shot(page, "desktop-share-dialog-public", false);

  // Signed out, the link opens it read only: no formatting bar, nothing to edit, a Sign in button.
  const reader = await signedOut(browser);
  const response = await reader.page.goto(copied);
  expect(response?.status()).toBe(200);
  await expect(reader.page.getByRole("heading", { level: 1, name: doc.title })).toBeVisible();
  const editor = reader.page.locator(".ProseMirror");
  await expect(editor).toContainText(`Anyone with the link can read this ${term}.`);
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(reader.page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);
  await expect(reader.page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(reader.page.getByRole("button", { name: "Share" })).toHaveCount(0);
  await expect(reader.page.getByRole("button", { name: "Comments", exact: true })).toHaveCount(0);
  await expect(reader.page.getByText("Public", { exact: true })).toBeVisible();
  await editor.click();
  await reader.page.keyboard.type("Written by nobody");
  await expect(editor).not.toContainText("Written by nobody");
  expect((await must<{ markdown: string }>(page, "GET", `/v1/docs/${doc.id}/markdown`)).markdown).not.toContain("Written by nobody");
  // Signed out, nothing else about the doc is reachable.
  expect((await call(reader.page, "GET", `/v1/docs/${doc.id}/sharing`)).status).toBe(401);
  await shot(reader.page, "desktop-public-doc-signed-out");

  // Commenting through the link needs signing in: signed out it stays read only.
  await choose(page, linkAccess, "Anyone with the link can comment");
  await reader.page.reload();
  await expect(reader.page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
  await expect(reader.page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(reader.page.getByRole("button", { name: "Comments", exact: true })).toHaveCount(0);

  // Nothing is listed anywhere: the friend, signed in, doesn't come across it.
  await indexed(page, term, doc.id);
  expect((await must<{ results: unknown[] }>(friend.page, "GET", `/v1/search?q=${term}`)).results).toEqual([]);
  expect((await must<{ docs: Doc[] }>(friend.page, "GET", "/v1/library?view=recent")).docs.map(d => d.id)).not.toContain(doc.id);
  expect((await must<{ docs: Doc[] }>(friend.page, "GET", "/v1/library?view=shared")).docs.map(d => d.id)).not.toContain(doc.id);

  // Private again: the open page closes, and the same link sends to sign in.
  await choose(page, linkAccess, "Only people with access");
  await expect(linkAccess).toContainText("Only people with access");
  expect((await must<Doc>(page, "GET", `/v1/docs/${doc.id}`)).public_access).toBe("none");
  await expect(reader.page.getByRole("heading", { name: "You no longer have access" })).toBeVisible({ timeout: 15_000 });
  expect((await call(reader.page, "GET", `/v1/docs/${doc.id}`)).status).toBe(401);
  const later = await reader.context.newPage();
  await later.goto(copied);
  await later.waitForURL(url => url.href.startsWith(`${ACCOUNTS}/authorize`), { timeout: 30_000 });
  await expect(later.getByRole("heading", { name: /Sign in to Write/ })).toBeVisible();
  expect(carbon.errors).toEqual([]);
  await reader.context.close();
  await carbon.context.close();
  await friend.context.close();
});

test("a public doc's Sign in button signs the reader in and brings them back to the doc, where the link lets them comment, and shows them nobody's email", async ({ browser }) => {
  test.setTimeout(240_000);
  const carbon = await signedIn(browser, "carbon");
  const doc = await newDoc(carbon.page, named("Notice"), { markdown: "# Notice\n\nComments welcome on this notice.\n" });
  const invitee = `write-private-invitee-${RUN}${(++made).toString(36)}@example.test`;
  await shareDoc(carbon.page, doc.id, invitee, "viewer");
  await must(carbon.page, "PUT", `/v1/docs/${doc.id}/public`, { access: "comment" });

  // The friend's browser is signed in to Silicon Accounts, not to Silicon Write: the doc reads, read only.
  const context = await accountsSession(browser, "friend", { viewport: DESKTOP, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`/d/${doc.id}`);
  const editor = page.locator(".ProseMirror");
  await expect(editor).toContainText("Comments welcome on this notice.");
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "Comments", exact: true })).toHaveCount(0);

  // Sign in, from the doc: back on the same doc, signed in.
  await page.getByRole("button", { name: "Sign in" }).click();
  await signInOnHostedPages(page, runAccounts().friend.email);
  await expect(page).toHaveURL(new RegExp(`/d/${doc.id}$`));
  await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  // "Anyone with the link can comment": signed in, they can.
  await expect(page.getByRole("button", { name: "Comments", exact: true })).toBeVisible();
  expect((await must<Doc>(page, "GET", `/v1/docs/${doc.id}`)).role).toBe("commenter");
  await expect(page.getByRole("button", { name: "Mode: Suggesting" })).toBeVisible();
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
  await shot(page, "desktop-public-doc-after-sign-in");
  // The link let them in; nothing lists the doc for them.
  expect((await must<Library>(page, "GET", "/v1/library?view=shared")).docs.map(d => d.id)).not.toContain(doc.id);

  // Someone who only has the public link can copy it, but cannot inspect membership.
  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share", exact: true });
  await expect(dialog.getByText("You have this doc through its link.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(dialog.getByRole("list", { name: "People with access" })).toHaveCount(0);
  await shot(page, "desktop-public-doc-share-dialog-link-only", false);
  await expect.soft(dialog.getByText(invitee), `a reader who only has the public link doesn't see the invited address ${invitee}`).toHaveCount(0);
  const seen = await call<Sharing>(page, "GET", `/v1/docs/${doc.id}/sharing`);
  expect(seen.status).toBe(403);
  expect.soft(JSON.stringify(seen.body), `the service doesn't hand invited email addresses to a reader who only has the public link (it answered ${seen.status})`).not.toContain(invitee);
  expect(errors).toEqual([]);
  await context.close();
  await carbon.context.close();
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Light only                                                                                                       */
/* ---------------------------------------------------------------------------------------------------------------- */

test("dark appearance works in the library, share dialog, editor and anonymous public docs", async ({ browser }) => {
  test.setTimeout(180_000);
  const carbon = await signedIn(browser, "carbon", DESKTOP, { colorScheme: "dark" });
  const { page } = carbon;
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "the browser prefers dark").toBe(true);
  const doc = await newDoc(page, named("Night reading"), { markdown: "# Night reading\n\nComfortable night reading.\n" });
  await must(page, "PUT", `/v1/docs/${doc.id}/public`, { access: "view" });
  const dark = async (where: string, target: Locator) => {
    await expect(target).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), `${where}: the page follows dark preference`).toBe("dark");
    expect(await backgroundLuminance(target), `${where}: the background is dark`).toBeLessThan(0.2);
  };

  await page.goto("/library");
  await dark("My docs", page.getByRole("list", { name: "My docs", exact: true }));
  await shot(page, "desktop-dark-preference-my-docs");
  await (await rowMenu(page, doc.title)).getByRole("menuitem", { exact: true, name: "Share" }).click();
  const dialog = page.getByRole("dialog", { name: "Share", exact: true });
  await dark("the share dialog", dialog.getByRole("list", { name: "People with access" }));
  await shot(page, "desktop-dark-preference-share-dialog", false);
  await page.keyboard.press("Escape");
  await page.goto(`/d/${doc.id}`);
  await dark("the doc", page.locator(".ProseMirror"));
  expect(await inkLuminance(page.locator(".ProseMirror p").first()), "the doc's text is light ink on the dark canvas").toBeGreaterThan(0.7);
  await shot(page, "desktop-dark-preference-doc");

  // Signed out, the public doc too.
  const reader = await signedOut(browser, DESKTOP, { colorScheme: "dark" });
  await reader.page.goto(`/d/${doc.id}`);
  await expect(reader.page.locator(".ProseMirror")).toContainText("Comfortable night reading.");
  expect(await reader.page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
  expect(await backgroundLuminance(reader.page.locator(".ProseMirror")), "the signed-out public doc is dark").toBeLessThan(0.2);
  await shot(reader.page, "desktop-dark-preference-public-doc");
  expect(carbon.errors).toEqual([]);
  expect(reader.errors).toEqual([]);
  await reader.context.close();
  await carbon.context.close();
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Every page, at 1440×900 and at 390×844                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test(`every library page and dialog at ${viewport.width}×${viewport.height}: no sideways scrolling, nothing cut off`, async ({ browser }) => {
    test.setTimeout(360_000);
    const carbon = await signedIn(browser, "carbon", viewport);
    const friend = await signedIn(browser, "friend", viewport);
    const { page } = carbon;
    const problems: string[] = [];
    const prefix = `${label}-pass`;

    // Long names, the way people really name things.
    const folder = await newFolder(page, named("Customer research interviews and the notes we took along the way"));
    const longTitle = named("A rather long doc title about the launch plan for the spring release and who does what");
    const doc = await newDoc(page, longTitle, { markdown: `# The plan\n\nEveryone with the doc can read the plan ${RUN}.\n` });
    await newDoc(page, named("Interview with the first customer, transcribed and annotated"), { folder_id: folder.id, markdown: "Notes." });
    const trashed = await newDoc(page, named("An old draft we no longer need but keep in the trash for now"));
    await must(page, "DELETE", `/v1/docs/${trashed.id}`, undefined, 204);
    await shareDoc(page, doc.id, friend.id, "commenter");
    await must(page, "PUT", `/v1/docs/${doc.id}/public`, { access: "view" });
    const gift = await newDoc(friend.page, named("A doc the friend wants to hand over to the Carbon, with a long name"));
    await must(friend.page, "POST", `/v1/docs/${gift.id}/transfer`, { to: carbon.id });
    const fromFriend = await newDoc(friend.page, named("Shared by the friend, also with quite a long name to wrap"));
    await shareDoc(friend.page, fromFriend.id, carbon.id, "editor");
    await indexed(page, `plan ${RUN}`, doc.id);

    await page.goto("/library");
    await expect(page.getByRole("region", { name: "Offered to you" })).toBeVisible();
    await expect(link(page, "My docs", doc.title)).toBeVisible();
    await screen(page, prefix, "my-docs", problems);
    // The row's actions stay on screen next to a long title.
    const more = page.getByRole("button", { name: `More for ${doc.title}`, exact: true });
    const box = (await more.boundingBox())!;
    expect(box.x + box.width, "the row's menu button is inside the window").toBeLessThanOrEqual(viewport.width);
    await more.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await screen(page, prefix, "row-menu", problems, false);
    await page.getByRole("menu").getByRole("menuitem", { exact: true, name: "Share" }).click();
    const share = page.getByRole("dialog", { name: "Share", exact: true });
    await expect(share.getByRole("list", { name: "People with access" }).getByRole("listitem").filter({ hasText: friend.id })).toBeVisible();
    await screen(page, prefix, "share-dialog", problems, false);
    await page.keyboard.press("Escape");
    await expect(share).toBeHidden();
    await (await rowMenu(page, doc.title)).getByRole("menuitem", { exact: true, name: "Move" }).click();
    await expect(page.getByRole("dialog", { name: `Move “${doc.title}”` })).toBeVisible();
    await screen(page, prefix, "move-dialog", problems, false);
    await page.keyboard.press("Escape");
    await (await rowMenu(page, doc.title)).getByRole("menuitem", { exact: true, name: "Rename" }).click();
    await expect(page.getByRole("dialog", { name: "Rename" })).toBeVisible();
    await screen(page, prefix, "rename-dialog", problems, false);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "New folder" }).click();
    await expect(page.getByRole("dialog", { name: "New folder" })).toBeVisible();
    await screen(page, prefix, "new-folder-dialog", problems, false);
    await page.keyboard.press("Escape");

    await page.goto(`/library/${folder.id}`);
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
    await screen(page, prefix, "folder", problems);
    await page.getByRole("button", { name: "Share folder" }).click();
    await expect(page.getByRole("dialog", { name: "Share", exact: true })).toBeVisible();
    await screen(page, prefix, "share-folder-dialog", problems, false);
    await page.keyboard.press("Escape");

    await page.goto("/shared");
    await expect(link(page, "Shared with me", fromFriend.title)).toBeVisible();
    await screen(page, prefix, "shared-with-me", problems);
    await page.goto("/recent");
    await expect(link(page, "Recent", doc.title)).toBeVisible();
    await screen(page, prefix, "recent", problems);
    await page.goto(`/search?q=${encodeURIComponent(`plan ${RUN}`)}`);
    await expect(list(page, "Results").getByRole("link", { name: doc.title })).toBeVisible();
    await screen(page, prefix, "search", problems);
    await page.goto("/trash");
    const inTrash = row(page, "Trash", trashed.title);
    await expect(inTrash.getByRole("button", { name: "Restore" })).toBeInViewport();
    await expect(inTrash.getByRole("button", { name: "Hold to delete forever" })).toBeInViewport();
    await screen(page, prefix, "trash", problems);
    if (label === "phone") {
      // Below 900 px the sections live in the menu sheet.
      await page.getByRole("button", { name: "Open the menu" }).click();
      const sheet = page.getByRole("navigation", { name: "Write menu" });
      for (const section of ["My docs", "Shared with me", "Recent", "Search", "Trash"]) await expect(sheet.getByRole("link", { name: section })).toBeVisible();
      await screen(page, prefix, "menu-sheet", problems, false);
      await sheet.getByRole("link", { name: "My docs" }).click();
      await page.waitForURL(/\/library$/);
    }

    // The doc and its share dialog, signed in.
    await page.goto(`/d/${doc.id}`);
    await expect(page.locator(".ProseMirror")).toContainText("Everyone with the doc can read the plan");
    await screen(page, prefix, "doc", problems);
    await page.getByRole("button", { name: "Share" }).click();
    await expect(page.getByRole("dialog", { name: "Share", exact: true })).toBeVisible();
    await screen(page, prefix, "doc-share-dialog", problems, false);
    await page.keyboard.press("Escape");

    // The friend's side: what was shared with them.
    await friend.page.goto("/shared");
    await expect(link(friend.page, "Shared with me", doc.title)).toBeVisible();
    await screen(friend.page, prefix, "friend-shared-with-me", problems);

    // The public doc, signed out.
    const reader = await signedOut(browser, viewport);
    await reader.page.goto(`/d/${doc.id}`);
    await expect(reader.page.locator(".ProseMirror")).toContainText("Everyone with the doc can read the plan");
    await expect(reader.page.getByRole("button", { name: "Sign in" })).toBeInViewport();
    await screen(reader.page, prefix, "public-doc-signed-out", problems);

    expect(problems).toEqual([]);
    expect(carbon.errors).toEqual([]);
    expect(friend.errors).toEqual([]);
    expect(reader.errors).toEqual([]);
    await reader.context.close();
    await carbon.context.close();
    await friend.context.close();
  });
}

test("personal archive: doc, folder and selected docs can be put aside and brought back", async ({ browser }) => {
  const { page, context } = await signedIn(browser, "carbon");
  try {
    const doc = await newDoc(page, named("Archive draft"));
    const folder = await newFolder(page, named("Archive folder"));
    await newDoc(page, named("Inside archive"), { folder_id: folder.id });
    await page.goto("/library");
    await page.getByRole("button", { name: `More for ${doc.title}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("link", { name: doc.title, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: `More for ${folder.name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("link", { name: folder.name, exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Archive", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: doc.title, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: folder.name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: `More for ${doc.title}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Unarchive", exact: true }).click();
    await expect(page.getByRole("link", { name: doc.title, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: `More for ${folder.name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Unarchive", exact: true }).click();
    await page.goto("/library");
    await expect(page.getByRole("link", { name: folder.name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: `More for ${doc.title}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Select", exact: true }).click();
    await page.getByRole("button", { name: "Archive selected", exact: true }).click();
    await expect(page.getByRole("link", { name: doc.title, exact: true })).toHaveCount(0);
    await page.goto(`/d/${doc.id}`);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Unarchive", exact: true }).click();
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeVisible();
  } finally { await context.close(); }
});

for (const viewport of [DESKTOP, PHONE]) {
  test(`selection stays still and title clicks toggle selection at ${viewport.width}px`, async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon", viewport);
    try {
      const first = await newDoc(page, named("Selection first"));
      const second = await newDoc(page, named("Selection second"));
      await page.goto("/library");
      const title = page.getByRole("link", { name: first.title, exact: true });
      await expect(title).toBeVisible();
      const before = await title.boundingBox();
      await page.getByRole("button", { name: `More for ${first.title}`, exact: true }).click();
      await page.getByRole("menuitem", { name: "Select", exact: true }).click();
      await expect(page.getByRole("checkbox", { name: `Select ${first.title}`, exact: true })).toBeChecked();
      const active = await title.boundingBox();
      expect(active?.y).toBe(before?.y);
      expect(active?.x).toBe(before?.x);
      await page.getByRole("link", { name: second.title, exact: true }).click();
      await expect(page).toHaveURL(/\/library$/);
      await expect(page.getByRole("checkbox", { name: `Select ${second.title}`, exact: true })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: `Select ${first.title}`, exact: true })).toBeChecked();
      expect((await title.boundingBox())?.y).toBe(before?.y);
      await title.click();
      await expect(page.getByRole("checkbox", { name: `Select ${first.title}`, exact: true })).not.toBeChecked();
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      expect((await title.boundingBox())?.y).toBe(before?.y);
      await title.click();
      await expect(page).toHaveURL(new RegExp(`/d/${first.id}$`));
    } finally { await context.close(); }
  });
}

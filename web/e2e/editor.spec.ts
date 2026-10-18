/**
 * The doc page, end to end in a real browser (UNDERSTANDING.md: "Editing", "Suggestions", "Comments", "Versions",
 * "Formats"). Every test makes its own docs (and its own Silicon where it needs one), drives the web editor the way a
 * Carbon does, and checks that the service's Markdown (GET /api/v1/docs/{id}/markdown) reflects each change exactly.
 *
 * The run's two Carbons come from the setup project (e2e/accounts.setup.ts): each test continues as them on the hosted
 * sign-in, so no email code is spent here. Screenshots of every state go to test-results/web-editor/.
 *
 *   E2E_AUTH_DIR=test-results/.auth-editor pnpm exec playwright test --project=setup --project=e2e e2e/editor.spec.ts \
 *     --output=test-results/editor
 *
 * Checks written as `expect.soft` are promises the product doesn't keep yet (each names what it found): the test goes
 * on past them so everything after still gets checked, and the run still fails on them.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "@playwright/test";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { accountsSession, runAccounts, sameOrigin, sessionOf, signIn, type Who } from "./support";
import { chooseDocMode, docSyncState, openComments, openFormatting } from "./doc-support";

const SHOTS = "test-results/web-editor";

/* ---------------------------------------------------------------------------------------------------------------- */
/* Shapes (docs/api.md)                                                                                              */
/* ---------------------------------------------------------------------------------------------------------------- */

interface Account {
  uuid: string;
  id: string;
  kind: "carbon" | "silicon";
  display_name: string;
  pfp_url?: string | null;
}

interface Doc {
  id: string;
  title: string;
  kind: "doc" | "pdf";
  role: string;
  seq: number;
}

interface Comment {
  id: string;
  body: string;
  author: Account;
  edited_at: string | null;
  reactions: { emoji: string; accounts: Account[] }[];
}

interface Thread {
  id: string;
  anchor: { kind: string; start?: string; end?: string; quote?: string; rect?: Record<string, number> };
  quote: string;
  current_quote: string | null;
  status: "open" | "resolved";
  created_by: Account;
  resolved_by: Account | null;
  comments: Comment[];
}

interface Version {
  seq: number;
  from_seq: number;
  summary: string;
  name: string | null;
  origin: string;
  authors: Account[];
}

interface Suggestion {
  id: string;
  author: Account | null;
  inserted: string;
  deleted: string;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Signing in, the API, and the stack's Silicons                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

interface Signed {
  context: BrowserContext;
  page: Page;
  account: Account;
}

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A browser signed in to Silicon Write as one of the run's Carbons ("Continue as" on the hosted sign-in). */
async function signedIn(browser: Browser, who: Who): Promise<Signed> {
  const accounts = runAccounts();
  const context = await accountsSession(browser, who);
  const page = await context.newPage();
  await signIn(page, accounts[who].email, "/library");
  const session = await sessionOf(context);
  if (!session.account) throw new Error(`${who} isn't signed in to Silicon Write`);
  return { context, page, account: { ...session.account, pfp_url: session.account.pfp_url ?? null } };
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Calls the service through the site's /api proxy, as the page's account. */
async function call<T>(page: Page, method: Method, path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const response = await page.request.fetch(`/api${path}`, {
    method,
    headers: method === "GET" ? {} : sameOrigin(),
    ...(method === "GET" ? {} : { data: data ?? {} }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: the raw text is the body.
  }
  return { status: response.status(), body: body as T };
}

async function ok<T>(page: Page, method: Method, path: string, data?: unknown): Promise<T> {
  const answer = await call<T>(page, method, path, data);
  expect(answer.status, `${method} ${path} answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 400)}`).toBeLessThan(300);
  return answer.body;
}

async function newDoc(page: Page, title: string, markdown?: string): Promise<Doc> {
  return ok<Doc>(page, "POST", "/v1/docs", markdown === undefined ? { title } : { title, markdown });
}

async function share(page: Page, docId: string, to: string, role: "editor" | "commenter" | "viewer") {
  await ok(page, "POST", `/v1/docs/${docId}/sharing`, { to, role });
}

async function markdownOf(page: Page, docId: string, query = ""): Promise<string> {
  return (await ok<{ markdown: string }>(page, "GET", `/v1/docs/${docId}/markdown${query}`)).markdown;
}

/** Waits for the service's Markdown of the doc to be exactly `expected`. */
async function expectMarkdown(page: Page, docId: string, expected: string, query = "") {
  await expect.poll(() => markdownOf(page, docId, query), { timeout: 15_000, message: `the service's Markdown of ${docId}${query}` }).toBe(expected);
}

async function threadsOf(page: Page, docId: string, status: "open" | "resolved" | "all" = "all"): Promise<Thread[]> {
  return (await ok<{ threads: Thread[] }>(page, "GET", `/v1/docs/${docId}/threads?status=${status}`)).threads;
}

async function versionsOf(page: Page, docId: string): Promise<Version[]> {
  return (await ok<{ versions: Version[] }>(page, "GET", `/v1/docs/${docId}/versions`)).versions;
}

/** Uploads an image for a doc and returns the address the doc refers to it by. */
async function uploadImage(page: Page, docId: string, name: string, bytes: Buffer): Promise<string> {
  const response = await page.request.post(`/api/v1/docs/${docId}/assets`, { headers: sameOrigin(), multipart: { file: { name, mimeType: "image/png", buffer: bytes } } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

interface Stack {
  signUpCarbon(label: string): Promise<{ id: string; uuid: string; email: string }>;
  createSilicon(carbon: unknown, label: string): Promise<{ id: string; uuid: string }>;
  siliconTokens(silicon: unknown): Promise<{ access_token: string }>;
  writeApi(token: string | null): {
    get(path: string): Promise<{ status: number; body: unknown }>;
    post(path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  };
}

/** The repository's e2e kit (real Carbons and Silicons on the local Accounts stack). */
async function stack(): Promise<Stack> {
  const path = resolve(__dirname, "../../e2e/lib/stack.mjs");
  return (await import(pathToFileURL(path).href)) as Stack;
}

/**
 * The shared Accounts stack allows 30 email codes per network in 10 minutes, for every app's tests together. When the
 * stack says to wait, this waits (giving the test the time) and tries again.
 */
async function waitingOutCodeLimit<T>(what: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await what();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const wait = /"retry_after_seconds":\s*(\d+)/.exec(text);
      if (!wait || attempt >= 3) throw error;
      const ms = (Number(wait[1]) + 5) * 1000;
      test.info().setTimeout(test.info().timeout + ms + 60_000);
      console.log(`the shared stack's code limit for this network: waiting ${Math.round(ms / 1000)} s before making the Silicon again`);
      await new Promise(done => setTimeout(done, ms));
    }
  }
}

/** A new Silicon (its custodian a new Carbon), signed in to Silicon Write, with its account. */
async function newSilicon(label: string) {
  const kit = await stack();
  const custodian = await waitingOutCodeLimit(() => kit.signUpCarbon("custodian"));
  const silicon = await waitingOutCodeLimit(() => kit.createSilicon(custodian, label));
  const api = kit.writeApi((await kit.siliconTokens(silicon)).access_token);
  const account = ((await api.get("/v1/me")).body as { account: Account }).account;
  return { silicon, api, account };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The editor                                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

const editorOf = (page: Page) => page.locator(".ProseMirror").first();
const toolbarOf = (page: Page) => page.getByRole("toolbar", { name: "Formatting" });
const newCommentBox = (page: Page) => page.getByRole("dialog", { name: "New comment" });
const threadCards = (page: Page) => page.locator("[data-thread-card]");
const suggestionsList = (page: Page) => page.getByRole("region", { name: "Suggestions" });
const statusBar = (page: Page) => page.getByRole("contentinfo");

async function openDoc(page: Page, docId: string) {
  await page.goto(`/d/${docId}`);
  await expect(editorOf(page)).toBeVisible({ timeout: 30_000 });
  await expect(docSyncState(page)).toHaveAccessibleName("Connected and synced", { timeout: 30_000 });
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

/**
 * Selects `text` in the editor (inside one run of text, the `occurrence`-th one), as a drag over it would. Unless
 * `bounded` is false, only a whole word or phrase counts (not "dog" inside "dogma"). With `collapse`, puts the caret
 * at that end of it instead.
 */
async function select(page: Page, text: string, options: { occurrence?: number; collapse?: "end" | "start"; focus?: boolean; bounded?: boolean } = {}) {
  if (options.focus !== false) await editorOf(page).focus();
  const place = () =>
    page.evaluate(
      ({ text, occurrence, collapse, bounded }) => {
        const root = document.querySelector(".ProseMirror");
        if (!root) throw new Error("There's no editor on the page.");
        const boundary = (c: string | undefined) => !bounded || c === undefined || !/[\p{L}\p{N}]/u.test(c);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let seen = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const value = node.textContent ?? "";
          for (let at = value.indexOf(text); at !== -1; at = value.indexOf(text, at + 1)) {
            if (!boundary(value[at - 1]) || !boundary(value[at + text.length])) continue;
            if (seen++ < occurrence) continue;
            const range = document.createRange();
            range.setStart(node, collapse === "end" ? at + text.length : at);
            range.setEnd(node, collapse === "start" ? at : at + text.length);
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            return;
          }
        }
        throw new Error(`“${text}” isn't in the editor.`);
      },
      { text, occurrence: options.occurrence ?? 0, collapse: options.collapse ?? null, bounded: options.bounded !== false },
    );
  // ProseMirror reads the page's selection on the next selectionchange, and may put back its own selection right after
  // a focus: place it again until the editor shows exactly this selection.
  const wanted = options.collapse ? "" : text;
  for (let attempt = 0; attempt < 4; attempt++) {
    await place();
    await page.waitForTimeout(150);
    if ((await page.evaluate(() => window.getSelection()?.toString() ?? "")) === wanted) return;
  }
  throw new Error(`The editor wouldn't keep “${text}” selected.`);
}

/** Puts the caret right after `text`. */
async function caretAfter(page: Page, text: string, occurrence = 0) {
  await select(page, text, { occurrence, collapse: "end" });
}

/** Selects `text` with the mouse: presses inside its first letter and releases inside its last one. */
async function dragSelect(page: Page, text: string) {
  const at = await page.evaluate(text => {
    const root = document.querySelector(".ProseMirror");
    if (!root) throw new Error("There's no editor on the page.");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.textContent ?? "";
      const index = value.indexOf(text);
      if (index === -1) continue;
      const rect = (from: number) => {
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, from + 1);
        return range.getBoundingClientRect();
      };
      const first = rect(index);
      const last = rect(index + text.length - 1);
      return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
    }
    throw new Error(`“${text}” isn't in the editor.`);
  }, text);
  await page.mouse.move(at.x1, at.y1);
  await page.mouse.down();
  await page.mouse.move((at.x1 + at.x2) / 2, at.y2, { steps: 4 });
  await page.mouse.move(at.x2, at.y2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe(text);
}

/** Where the page's selection is, on screen. */
async function selectionRect(page: Page) {
  return page.evaluate(() => {
    const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  });
}

/** Drags from one point of a box to another (fractions of its width and height). */
async function dragOver(page: Page, box: { x: number; y: number; width: number; height: number }, from: [number, number], to: [number, number]) {
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((from[0] + to[0]) / 2), box.y + box.height * ((from[1] + to[1]) / 2), { steps: 5 });
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 5 });
  await page.mouse.up();
}

/** Opens the doc's ⋯ menu and picks an item. */
async function docMenu(page: Page, item: string) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

/** Types `/query` at the caret, checks the first item of the menu and picks it with Enter. */
async function slash(page: Page, query: string, first: string) {
  await page.keyboard.type(`/${query}`);
  const menu = page.getByRole("listbox", { name: "Insert" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option").first()).toContainText(first);
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
}

/** The element that has the keyboard: its accessible name, or its tag. */
const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);

interface Flashes {
  labels: string[];
  flashed: boolean;
  texts: string[];
}

/**
 * From now on, records every highlight of someone else's change (`.remote-change`), every name label on one, and every
 * state the doc's text goes through.
 */
async function watchFlashes(page: Page): Promise<() => Promise<Flashes>> {
  await page.evaluate(() => {
    const seen = { labels: [] as string[], flashed: false, texts: [] as string[] };
    (window as unknown as { __flash: typeof seen }).__flash = seen;
    const root = document.querySelector(".ProseMirror")!;
    new MutationObserver(() => {
      for (const label of document.querySelectorAll(".remote-change-label")) {
        const text = label.textContent ?? "";
        if (!seen.labels.includes(text)) seen.labels.push(text);
      }
      if (document.querySelector(".remote-change")) seen.flashed = true;
      const content = root.cloneNode(true) as HTMLElement;
      content.querySelectorAll(".collaboration-carets__caret, .collaboration-carets__label, .remote-change-label, .authorship-gutter, .ProseMirror-widget").forEach(el => el.remove());
      const text = content.textContent ?? "";
      if (seen.texts[seen.texts.length - 1] !== text) seen.texts.push(text);
    }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  return () => page.evaluate(() => (window as unknown as { __flash: Flashes }).__flash);
}

/**
 * Waits for a toolbar menu or popover to be gone and done handing the keyboard back (Radix gives it back to the
 * button that opened it once its closing animation ends), so the next step's keyboard isn't taken from it.
 */
async function popupGone(page: Page) {
  await expect(page.locator('[role="menu"], [data-radix-popper-content-wrapper] [role="dialog"]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

/**
 * The doc's text as the editor shows it, blocks joined by a line break, without what's drawn on top of it (other
 * people's carets and their names, highlight labels, who-wrote-what chips).
 */
const docText = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector(".ProseMirror")!.cloneNode(true) as HTMLElement;
    root.querySelectorAll(".collaboration-carets__caret, .collaboration-carets__label, .remote-change-label, .authorship-gutter, .ProseMirror-widget").forEach(el => el.remove());
    return [...root.children].map(child => child.textContent ?? "").join("\n");
  });

/* ---------------------------------------------------------------------------------------------------------------- */
/* Files                                                                                                             */
/* ---------------------------------------------------------------------------------------------------------------- */

/** A real PNG: `width`×`height`, a colour band on paper. */
function png(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const band = y < height / 2;
      raw[row + 1 + x * 3] = band ? 31 : 246;
      raw[row + 2 + x * 3] = band ? 92 : 241;
      raw[row + 3 + x * 3] = band ? 177 : 231;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A real PDF with one line of text on each page. */
function pdf(pages: string[]): Buffer {
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const stream = `BT /F1 30 Tf 72 690 Td (${text}) Tj ET`;
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ---------------------------------------------------------------------------------------------------------------- */
/* Typing, formatting, blocks                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

test.describe("writing", () => {
  test("typing and every toolbar format reach the service's Markdown exactly", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Formats ${tag()}`);
    await openDoc(page, doc.id);
    await openFormatting(page);
    const editor = editorOf(page);
    await expect(editor.locator("p.is-editor-empty")).toHaveAttribute("data-placeholder", "Start writing, or type / for blocks");
    await editor.click();
    await page.keyboard.type("The quick brown fox jumps over the lazy dog today");
    let expected = "The quick brown fox jumps over the lazy dog today\n";
    await expectMarkdown(page, doc.id, expected);
    // The word count follows the typing.
    await expect(statusBar(page)).toContainText("10 words · 49 characters");

    const toolbar = toolbarOf(page);
    const button = (name: string) => toolbar.getByRole("button", { name, exact: true });
    const steps: { word: string; markdown: string; apply: () => Promise<void>; shows: Locator }[] = [
      { word: "quick", markdown: "**quick**", apply: () => button("Bold").click(), shows: editor.locator("strong", { hasText: "quick" }) },
      { word: "brown", markdown: "*brown*", apply: () => button("Italic").click(), shows: editor.locator("em", { hasText: "brown" }) },
      { word: "fox", markdown: "<u>fox</u>", apply: () => button("Underline").click(), shows: editor.locator("u", { hasText: "fox" }) },
      { word: "jumps", markdown: "~~jumps~~", apply: () => button("Strikethrough").click(), shows: editor.locator("s", { hasText: "jumps" }) },
      { word: "over", markdown: "`over`", apply: () => button("Code").click(), shows: editor.locator("code", { hasText: "over" }) },
      {
        word: "lazy",
        markdown: '<span style="color: #B42318">lazy</span>',
        apply: async () => {
          await button("Text colour").click();
          await page.getByRole("button", { name: "Colour #B42318" }).click();
          await page.keyboard.press("Escape");
        },
        shows: editor.locator('span[style*="color"]', { hasText: "lazy" }),
      },
      {
        word: "dog",
        markdown: '<mark style="background-color: #FFF1A8">dog</mark>',
        apply: async () => {
          await button("Highlight").click();
          await page.getByRole("button", { name: "Highlight #FFF1A8" }).click();
          await page.keyboard.press("Escape");
        },
        shows: editor.locator("mark", { hasText: "dog" }),
      },
      {
        word: "today",
        markdown: "[today](https://example.com/write)",
        apply: async () => {
          await button("Link").click();
          const field = page.getByRole("textbox", { name: "Link address" });
          await field.fill("example.com/write");
          await field.press("Enter");
        },
        shows: editor.locator('a[href="https://example.com/write"]', { hasText: "today" }),
      },
    ];
    for (const step of steps) {
      await select(page, step.word);
      await step.apply();
      await expect(step.shows, `${step.word} shows its format`).toBeVisible();
      expected = expected.replace(` ${step.word}`, ` ${step.markdown}`);
      await expectMarkdown(page, doc.id, expected);
    }
    expect(expected).toBe(
      'The **quick** *brown* <u>fox</u> ~~jumps~~ `over` the <span style="color: #B42318">lazy</span> <mark style="background-color: #FFF1A8">dog</mark> [today](https://example.com/write)\n',
    );
    // The toolbar shows what the selection has.
    await select(page, "quick");
    await expect(button("Bold")).toHaveAttribute("aria-pressed", "true");
    await expect(button("Italic")).toHaveAttribute("aria-pressed", "false");
    await shot(page, "formats");
    await context.close();
  });

  test("formats come off again from the toolbar, and the shortcuts the toolbar names work", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const start = 'Plain **bold** and <span style="color: #B42318">red</span> and <mark style="background-color: #FFF1A8">lit</mark> and [linked](https://example.com/a) words\n';
    const doc = await newDoc(page, `Unformat ${tag()}`, start);
    await expectMarkdown(page, doc.id, start);
    await openDoc(page, doc.id);
    await openFormatting(page);
    const editor = editorOf(page);
    const toolbar = toolbarOf(page);
    const button = (name: string) => toolbar.getByRole("button", { name, exact: true });

    await select(page, "bold");
    await expect(button("Bold")).toHaveAttribute("aria-pressed", "true");
    await button("Bold").click();
    await expect(editor.locator("strong")).toHaveCount(0);
    await select(page, "red");
    await button("Text colour").click();
    await page.getByRole("button", { name: "Default", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(editor.locator('span[style*="color"]')).toHaveCount(0);
    await select(page, "lit");
    await button("Highlight").click();
    await page.getByRole("button", { name: "None", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(editor.locator("mark")).toHaveCount(0);
    await select(page, "linked");
    await button("Link").click();
    await expect(page.getByRole("textbox", { name: "Link address" })).toHaveValue("https://example.com/a");
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(editor.locator("a")).toHaveCount(0);
    await expectMarkdown(page, doc.id, "Plain bold and red and lit and linked words\n");
    await popupGone(page);

    // The keyboard: the toolbar's tooltips name ⌘B, ⌘I and ⌘U.
    await select(page, "Plain");
    await page.keyboard.press("ControlOrMeta+b");
    await select(page, "words");
    await page.keyboard.press("ControlOrMeta+i");
    await select(page, "and");
    await page.keyboard.press("ControlOrMeta+u");
    await expectMarkdown(page, doc.id, "**Plain** bold <u>and</u> red and lit and linked *words*\n");
    // …and "Link ⌘K".
    await select(page, "lit");
    await page.keyboard.press("ControlOrMeta+k");
    const linkField = page.getByRole("textbox", { name: "Link address" });
    await expect.soft(linkField, "⌘K (the Link button's tooltip says “Link ⌘K”) opens the link field").toBeVisible({ timeout: 2_000 });
    await shot(page, "link-shortcut");
    if (await linkField.isVisible()) {
      await linkField.fill("example.com/lit");
      await linkField.press("Enter");
      await expectMarkdown(page, doc.id, "**Plain** bold <u>and</u> red and [lit](https://example.com/lit) and linked *words*\n");
    }
    await context.close();
  });

  test("a javascript: link is never made, from the link field or from Markdown", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Safe links ${tag()}`, "Click here please.\n\n[Sneaky](javascript:alert(document.domain))");
    const before = await markdownOf(page, doc.id);
    await openDoc(page, doc.id);
    await openFormatting(page);
    const editor = editorOf(page);
    // A link a Silicon wrote in Markdown is shown, but never with an address that runs script.
    await expect(editor).toContainText("Sneaky");
    await expect(editor.locator('a[href^="javascript:" i]')).toHaveCount(0);
    // Typed into the link field, it isn't applied.
    await select(page, "here");
    await toolbarOf(page).getByRole("button", { name: "Link", exact: true }).click();
    const field = page.getByRole("textbox", { name: "Link address" });
    await field.fill("javascript:alert(document.domain)");
    await field.press("Enter");
    await page.waitForTimeout(1_000);
    await expect(editor.locator('a[href^="javascript:" i]')).toHaveCount(0);
    expect(await markdownOf(page, doc.id)).toBe(before);
    await context.close();
  });

  test("paragraph styles and Markdown shortcuts (#, -, 1., [ ], >) make the blocks Markdown names", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Shortcuts ${tag()}`);
    await openDoc(page, doc.id);
    await openFormatting(page);
    const editor = editorOf(page);
    await editor.click();
    const line = async (text: string, enters = 1) => {
      await page.keyboard.type(text);
      for (let i = 0; i < enters; i++) await page.keyboard.press("Enter");
    };
    await line("# Big title");
    await expect(editor.locator("h1")).toHaveText("Big title");
    await line("- first");
    await line("second", 2);
    await expect(editor.locator("ul:not([data-type]) > li")).toHaveText(["first", "second"]);
    await line("1. one");
    await line("two", 2);
    await expect(editor.locator("ol > li")).toHaveText(["one", "two"]);
    await line("[ ] task", 2);
    await expect(editor.locator('ul[data-type="taskList"] > li > div')).toHaveText(["task"]);
    await line("> quoted", 2);
    await expect(editor.locator("blockquote")).toHaveText("quoted");
    await expectMarkdown(page, doc.id, "# Big title\n\n- first\n- second\n\n1. one\n2. two\n\n- [ ] task\n\n> quoted\n");

    // The paragraph style menu.
    const toolbar = toolbarOf(page);
    await page.keyboard.type("Styled line");
    await toolbar.getByRole("button", { name: "Paragraph style: Text" }).click();
    await page.getByRole("menuitem", { name: "Heading 2" }).click();
    await expect(editor.locator("h2")).toHaveText("Styled line");
    await expect(toolbar.getByRole("button", { name: "Paragraph style: Heading 2" })).toBeVisible();
    // (Where the keyboard goes after the menu closes is its own test, below.)
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.waitForTimeout(400);
    await caretAfter(page, "Styled line");
    await expectMarkdown(page, doc.id, "# Big title\n\n- first\n- second\n\n1. one\n2. two\n\n- [ ] task\n\n> quoted\n\n## Styled line\n");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("let answer = 42;");
    await toolbar.getByRole("button", { name: "Paragraph style: Text" }).click();
    await page.getByRole("menuitem", { name: "Code" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(editor.locator("pre code")).toHaveText("let answer = 42;");
    await expectMarkdown(page, doc.id, "# Big title\n\n- first\n- second\n\n1. one\n2. two\n\n- [ ] task\n\n> quoted\n\n## Styled line\n\n```\nlet answer = 42;\n```\n");
    // Ticking the checklist item is a change too.
    await editor.locator('ul[data-type="taskList"] input[type="checkbox"]').check();
    await expectMarkdown(page, doc.id, "# Big title\n\n- first\n- second\n\n1. one\n2. two\n\n- [x] task\n\n> quoted\n\n## Styled line\n\n```\nlet answer = 42;\n```\n");
    await shot(page, "styles-and-shortcuts");
    await context.close();
  });

  test("Markdown shortcuts inside a line (**, *, `, ~~, ==) and for a divider and code (---, ```)", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Inline shortcuts ${tag()}`);
    await openDoc(page, doc.id);
    const editor = editorOf(page);
    await editor.click();
    await page.keyboard.type("Make **bold** and *soft* and `tick` and ~~gone~~ and ==glow== now");
    await expect(editor.locator("strong")).toHaveText("bold");
    await expect(editor.locator("em")).toHaveText("soft");
    await expect(editor.locator("code")).toHaveText("tick");
    await expect(editor.locator("s")).toHaveText("gone");
    await expect(editor.locator("mark")).toHaveText("glow");
    await expectMarkdown(page, doc.id, "Make **bold** and *soft* and `tick` and ~~gone~~ and <mark>glow</mark> now\n");
    await page.keyboard.press("Enter");
    await page.keyboard.type("---");
    await expect(editor.locator("hr")).toHaveCount(1);
    await page.keyboard.type("``` ");
    await page.keyboard.type("let x = 1;");
    await expect(editor.locator("pre code")).toHaveText("let x = 1;");
    await expectMarkdown(page, doc.id, "Make **bold** and *soft* and `tick` and ~~gone~~ and <mark>glow</mark> now\n\n---\n\n```\nlet x = 1;\n```\n");
    await shot(page, "inline-shortcuts");
    await context.close();
  });

  test("after picking from the toolbar's menus, typing goes on in the doc", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Menus keep the keyboard ${tag()}`, "Plain line\n\nLast line");
    await openDoc(page, doc.id);
    await openFormatting(page);
    const editor = editorOf(page);
    const toolbar = toolbarOf(page);
    /** Closes whatever a stray keystroke opened, and waits for the keyboard to be handed back. */
    const closeMenus = async () => {
      for (let i = 0; i < 3 && (await page.locator('[role="menu"], [data-radix-popper-content-wrapper]').count()) > 0; i++) await page.keyboard.press("Escape");
      await popupGone(page);
    };
    // A paragraph style, then keep typing: the words land in the heading.
    await caretAfter(page, "Plain line");
    await toolbar.getByRole("button", { name: "Paragraph style: Text" }).click();
    await page.getByRole("menuitem", { name: "Heading 2" }).click();
    await expect(editor.locator("h2")).toHaveText("Plain line");
    await popupGone(page);
    expect.soft(await focused(page), "the element with the keyboard after picking Heading 2").toBe("Doc");
    await page.keyboard.type(" continued");
    await page.waitForTimeout(1_000);
    await shot(page, "menus-keyboard-style");
    expect.soft(await page.getByRole("menu").count(), "menus open after typing “ continued” (a space on the style button opens its menu again)").toBe(0);
    expect.soft(await markdownOf(page, doc.id), "the doc after typing on from the paragraph style menu").toBe("## Plain line continued\n\nLast line\n");
    await closeMenus();

    // Insert ▸ Table, then type: the words land in the first cell.
    await caretAfter(page, "Last line");
    await page.keyboard.press("Enter");
    await toolbar.getByRole("button", { name: "Insert" }).click();
    await page.getByRole("menuitem", { name: "Table", exact: true }).click();
    await expect(editor.locator("table")).toBeVisible();
    await popupGone(page);
    expect.soft(await focused(page), "the element with the keyboard after Insert ▸ Table").toBe("Doc");
    await page.keyboard.type("Cell text");
    await page.waitForTimeout(500);
    expect.soft(await editor.locator("th").first().textContent(), "the first cell after typing on from the Insert menu").toBe("Cell text");
    await shot(page, "menus-keyboard");
    await closeMenus();

    // A link from the link field, then keep typing after it.
    await caretAfter(page, "Plain");
    await select(page, "Plain");
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    const field = page.getByRole("textbox", { name: "Link address" });
    await field.fill("example.com/plain");
    await field.press("Enter");
    await expect(editor.locator('a[href="https://example.com/plain"]')).toHaveText("Plain");
    await popupGone(page);
    expect.soft(await focused(page), "the element with the keyboard after applying a link").toBe("Doc");
    await context.close();
  });

  test("the / menu inserts a table, a divider, maths, a table of contents and a footnote", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Blocks ${tag()}`, "# Intro\n\nEnd");
    await openDoc(page, doc.id);
    const editor = editorOf(page);
    const blocks = ["# Intro", "End"];
    const expectBlocks = (footnotes = "") => expectMarkdown(page, doc.id, `${blocks.join("\n\n")}\n${footnotes}`);
    /** A new empty line right after the heading. */
    const lineAfterIntro = async () => {
      await caretAfter(page, "Intro");
      await page.keyboard.press("Enter");
    };

    // Nothing matching says so, and Escape closes the menu without inserting anything.
    await lineAfterIntro();
    await page.keyboard.type("/zzzz");
    const menu = page.getByRole("listbox", { name: "Insert" });
    await expect(menu).toContainText("Nothing matches.");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expectBlocks();

    await lineAfterIntro();
    await slash(page, "table", "Table");
    await expect(editor.locator("table tr")).toHaveCount(3);
    for (const [i, cell] of ["Name", "Role", "Note", "Ada", "Writer", "first", "Bo", "Editor", "second"].entries()) {
      if (i) await page.keyboard.press("Tab");
      await page.keyboard.type(cell);
    }
    blocks.splice(1, 0, "| Name | Role | Note |\n| --- | --- | --- |\n| Ada | Writer | first |\n| Bo | Editor | second |");
    await expect(editor.locator("th")).toHaveText(["Name", "Role", "Note"]);
    await expectBlocks();

    await lineAfterIntro();
    await slash(page, "divider", "Divider");
    await expect(editor.locator("hr")).toHaveCount(1);
    blocks.splice(1, 0, "---");
    await expectBlocks();

    await lineAfterIntro();
    await slash(page, "maths", "Maths");
    await expect(editor.locator(".katex").first()).toBeVisible();
    blocks.splice(1, 0, "$$\nE = mc^2\n$$");
    await expectBlocks();

    await lineAfterIntro();
    await slash(page, "toc", "Table of contents");
    const toc = editor.locator("[data-toc]");
    await expect(toc).toContainText("Contents");
    await expect(toc.getByRole("link", { name: "Intro" })).toBeVisible();
    blocks.splice(1, 0, "[[_TOC_]]");
    await expectBlocks();

    await lineAfterIntro();
    await slash(page, "footnote", "Footnote");
    await page.keyboard.type(" is a note");
    const note = editor.getByRole("button", { name: "Footnote 1" });
    await expect(note).toBeVisible();
    await note.click();
    const text = page.getByRole("textbox", { name: "Footnote text" });
    await expect(text).toBeVisible();
    await text.fill("Source: the archive");
    await text.press("ControlOrMeta+Enter");
    await expect(text).toBeHidden();
    blocks.splice(1, 0, "[^1] is a note");
    await expectBlocks("\n[^1]: Source: the archive\n");
    await shot(page, "slash-menu-blocks");
    await context.close();
  });

  test("[[ links to another doc by its title, the link opens it, and that doc lists the link", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const t = tag();
    const target = await newDoc(page, `Target ${t}`, "The target body.");
    const source = await newDoc(page, `Source ${t}`, "Start.");
    await openDoc(page, source.id);
    const editor = editorOf(page);
    await caretAfter(page, "Start.");
    await page.keyboard.type(" See [[");
    const menu = page.getByRole("listbox", { name: "Insert" });
    await expect(menu).toBeVisible();
    await page.keyboard.type(target.title);
    await expect(menu.getByRole("option").first()).toHaveText(target.title);
    await shot(page, "doc-link-menu");
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await page.keyboard.type("for details.");
    await expect(editor.locator("[data-doc-link]")).toHaveText(target.title);
    await expectMarkdown(page, source.id, `Start. See [[${target.title}]] for details.\n`);
    // Typing the whole link works too.
    await page.keyboard.type(` Also [[${target.title}]]`);
    await page.keyboard.press("Escape");
    await expect(editor.locator("[data-doc-link]")).toHaveCount(2);
    await expectMarkdown(page, source.id, `Start. See [[${target.title}]] for details. Also [[${target.title}]]\n`);

    // Following it opens the doc.
    await editor.locator("[data-doc-link] a").first().click();
    await page.waitForURL(`**/d/${target.id}`);
    await expect(editorOf(page)).toContainText("The target body.");
    // Every doc shows which docs link to it. Opened right away, before the service has indexed the typing…
    await docMenu(page, "Linked from");
    const panel = page.getByRole("complementary", { name: "Linked from", exact: true });
    await expect(panel).toBeVisible();
    // …the service has the link within about two seconds of the typing (docs/api.md)…
    await expect.poll(async () => (await ok<{ docs: Doc[] }>(page, "GET", `/v1/docs/${target.id}/backlinks`)).docs.map(d => d.id), { timeout: 10_000 }).toEqual([source.id]);
    // …and the open panel should catch up, or at least show it when opened again.
    await expect.soft(panel.getByRole("link", { name: source.title }), "the open Linked from panel, once the service has the link").toBeVisible({ timeout: 5_000 });
    await shot(page, "linked-from-right-away");
    await panel.getByRole("button", { name: "Close" }).click();
    await docMenu(page, "Linked from");
    await expect.soft(panel.getByRole("link", { name: source.title }), "the Linked from panel closed and opened again, once the service has the link").toBeVisible({ timeout: 5_000 });
    await openDoc(page, target.id);
    await docMenu(page, "Linked from");
    await expect(panel.getByRole("link", { name: source.title })).toBeVisible();
    await shot(page, "linked-from");
    // The link in the panel opens the linking doc.
    await panel.getByRole("link", { name: source.title }).click();
    await page.waitForURL(`**/d/${source.id}`);
    await expect(editorOf(page)).toContainText("for details.");

    // A link to a title no doc has says so on the page (not in a browser alert).
    const dialogs: string[] = [];
    page.on("dialog", dialog => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await caretAfter(page, "for details.");
    await page.keyboard.type(` Nowhere [[No such doc ${t}]]`);
    await page.keyboard.press("Escape");
    await expect(editorOf(page).locator("[data-doc-link]")).toHaveCount(3);
    await editorOf(page).locator("[data-doc-link] a", { hasText: `No such doc ${t}` }).click();
    await expect.poll(async () => dialogs.length + (await page.getByText(/no doc called/i).count()), { message: "anything said about the missing doc" }).toBeGreaterThan(0);
    await expect(page).toHaveURL(new RegExp(`/d/${source.id}$`));
    await shot(page, "doc-link-missing");
    expect.soft(dialogs, "browser dialogs opened by following a [[link]] to a title no doc has (the page itself should say it)").toEqual([]);
    await context.close();
  });

  test("an image chosen with the file chooser shows in the doc and is stored", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Image ${tag()}`, "Above\n\nBelow");
    await openDoc(page, doc.id);
    const editor = editorOf(page);
    const picture = png(160, 90);
    await caretAfter(page, "Above");
    await page.keyboard.press("Enter");
    const chooser = page.waitForEvent("filechooser");
    await openFormatting(page);
    await toolbarOf(page).getByRole("button", { name: "Insert" }).click();
    await page.getByRole("menuitem", { name: "Image" }).click();
    await (await chooser).setFiles({ name: "editor-photo.png", mimeType: "image/png", buffer: picture });
    const image = editor.locator("img");
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute("alt", "editor-photo");
    const src = (await image.getAttribute("src")) ?? "";
    expect(src).toMatch(/\/assets\/a_[A-Za-z0-9]+$/);
    // It shows (the browser decoded it at its real size).
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth)).toBe(160);
    await expectMarkdown(page, doc.id, `Above\n\n![editor-photo](${src})\n\nBelow\n`);
    // It is stored: the address in the doc and the service both give back the same bytes.
    const shown = await page.request.get(src);
    expect(shown.status()).toBe(200);
    expect(Buffer.from(await shown.body()).equals(picture)).toBe(true);
    const id = src.split("/assets/")[1];
    const stored = await page.request.get(`/api/v1/assets/${id}`);
    expect(stored.status()).toBe(200);
    expect(stored.headers()["content-type"]).toBe("image/png");
    expect(Buffer.from(await stored.body()).equals(picture)).toBe(true);
    // And it is still there after a reload.
    await openDoc(page, doc.id);
    await expect(editorOf(page).locator(`img[src="${src}"]`)).toBeVisible();
    await shot(page, "image");
    await context.close();
  });

  test("find and replace changes the doc", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Find ${tag()}`, "A red apple, a red car and a red door.");
    await openDoc(page, doc.id);
    const editor = editorOf(page);
    await editor.click();
    await page.keyboard.press("ControlOrMeta+f");
    const bar = page.getByRole("search", { name: "Find in this doc" });
    await expect(bar).toBeVisible();
    const field = bar.getByRole("textbox", { name: "Find" });
    await expect(field).toBeFocused();
    await field.fill("red");
    await expect(bar.getByText("1 of 3")).toBeVisible();
    await expect(editor.locator(".find-match")).toHaveCount(3);
    await field.press("Enter");
    await expect(bar.getByText("2 of 3")).toBeVisible();
    await bar.getByRole("textbox", { name: "Replace with" }).fill("blue");
    await shot(page, "find-and-replace");
    await bar.getByRole("button", { name: "Replace", exact: true }).click();
    await expectMarkdown(page, doc.id, "A red apple, a blue car and a red door.\n");
    await bar.getByRole("button", { name: "Replace all" }).click();
    await expectMarkdown(page, doc.id, "A blue apple, a blue car and a blue door.\n");
    await expect(bar.getByText("No matches")).toBeVisible();
    await field.fill("BLUE");
    await expect(bar.getByText("1 of 3")).toBeVisible();
    await field.press("Escape");
    await expect(bar).toBeHidden();
    await expect(editor.locator(".find-match")).toHaveCount(0);
    await context.close();
  });

  test("undo and redo, from the toolbar and the keyboard", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Undo ${tag()}`, "Keep this.");
    await openDoc(page, doc.id);
    await openFormatting(page);
    const toolbar = toolbarOf(page);
    const undo = toolbar.getByRole("button", { name: "Undo" });
    const redo = toolbar.getByRole("button", { name: "Redo" });
    await caretAfter(page, "Keep this.");
    await page.keyboard.type(" Typed words.");
    await expectMarkdown(page, doc.id, "Keep this. Typed words.\n");
    // The undo history groups what's typed within half a second.
    await page.waitForTimeout(700);
    await select(page, "Typed");
    await toolbar.getByRole("button", { name: "Bold", exact: true }).click();
    await expectMarkdown(page, doc.id, "Keep this. **Typed** words.\n");
    await undo.click();
    await expectMarkdown(page, doc.id, "Keep this. Typed words.\n");
    await undo.click();
    await expectMarkdown(page, doc.id, "Keep this.\n");
    await redo.click();
    await expectMarkdown(page, doc.id, "Keep this. Typed words.\n");
    await editorOf(page).focus();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expectMarkdown(page, doc.id, "Keep this. **Typed** words.\n");
    await page.keyboard.press("ControlOrMeta+z");
    await expectMarkdown(page, doc.id, "Keep this. Typed words.\n");
    // Undo only takes back your own changes: what was there before you opened the doc stays.
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+z");
    await expectMarkdown(page, doc.id, "Keep this.\n");
    await expect(undo).toBeDisabled();
    await context.close();
  });
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Together                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

test.describe("together", () => {
  test("two Carbons typing at once both see each other's text, cursors and faces", async ({ browser }) => {
    const owner = await signedIn(browser, "carbon");
    const friend = await signedIn(browser, "friend");
    const doc = await newDoc(owner.page, `Together ${tag()}`, "Owner's paragraph.\n\nFriend's paragraph.");
    await share(owner.page, doc.id, friend.account.id, "editor");
    await openDoc(owner.page, doc.id);
    await openDoc(friend.page, doc.id);
    const here = (page: Page, who: Account) =>
      page.getByRole("group", { name: "Here now" }).getByRole("img", { name: new RegExp(`^${escapeRegex(who.display_name || who.id)}`) });
    await expect(here(owner.page, friend.account)).toBeVisible();
    await expect(here(friend.page, owner.account)).toBeVisible();

    await caretAfter(owner.page, "Owner's paragraph.");
    await caretAfter(friend.page, "Friend's paragraph.");
    await Promise.all([
      owner.page.keyboard.type(" Typed by the owner at the same time.", { delay: 25 }),
      friend.page.keyboard.type(" Typed by the friend at the same time.", { delay: 25 }),
    ]);
    await expect(editorOf(owner.page)).toContainText("Friend's paragraph. Typed by the friend at the same time.");
    await expect(editorOf(friend.page)).toContainText("Owner's paragraph. Typed by the owner at the same time.");
    await expectMarkdown(owner.page, doc.id, "Owner's paragraph. Typed by the owner at the same time.\n\nFriend's paragraph. Typed by the friend at the same time.\n");
    // Each one's cursor shows on the other's page, with their name.
    await expect(owner.page.locator(".collaboration-carets__label", { hasText: friend.account.display_name || friend.account.id })).toBeVisible();
    await expect(friend.page.locator(".collaboration-carets__label", { hasText: owner.account.display_name || owner.account.id })).toBeVisible();
    await shot(owner.page, "together-owner");
    await shot(friend.page, "together-friend");
    // Leaving takes the face away.
    await friend.context.close();
    await expect(here(owner.page, friend.account)).toBeHidden({ timeout: 15_000 });
    await owner.context.close();
  });

  test("undo takes back only your own typing, never the other Carbon's", async ({ browser }) => {
    const owner = await signedIn(browser, "carbon");
    const friend = await signedIn(browser, "friend");
    const doc = await newDoc(owner.page, `Shared undo ${tag()}`, "First paragraph.\n\nSecond paragraph.");
    await share(owner.page, doc.id, friend.account.id, "editor");
    await openDoc(owner.page, doc.id);
    await openDoc(friend.page, doc.id);
    await caretAfter(owner.page, "First paragraph.");
    await owner.page.keyboard.type(" Mine.");
    await caretAfter(friend.page, "Second paragraph.");
    await friend.page.keyboard.type(" Theirs.");
    await expectMarkdown(owner.page, doc.id, "First paragraph. Mine.\n\nSecond paragraph. Theirs.\n");
    await expect(editorOf(owner.page)).toContainText("Second paragraph. Theirs.");
    await owner.page.waitForTimeout(700);
    await editorOf(owner.page).focus();
    await owner.page.keyboard.press("ControlOrMeta+z");
    await expectMarkdown(owner.page, doc.id, "First paragraph.\n\nSecond paragraph. Theirs.\n");
    await expect.poll(() => docText(friend.page)).toBe("First paragraph.\nSecond paragraph. Theirs.");
    await owner.page.keyboard.press("ControlOrMeta+Shift+z");
    await expectMarkdown(owner.page, doc.id, "First paragraph. Mine.\n\nSecond paragraph. Theirs.\n");
    // And the other way round.
    await friend.page.waitForTimeout(700);
    await editorOf(friend.page).focus();
    await friend.page.keyboard.press("ControlOrMeta+z");
    await expectMarkdown(owner.page, doc.id, "First paragraph. Mine.\n\nSecond paragraph.\n");
    await shot(owner.page, "shared-undo");
    await friend.context.close();
    await owner.context.close();
  });

  test("a dropped connection loses nothing: what's typed meanwhile merges back in when it returns", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Offline ${tag()}`, "Typed online.\n\nChanged elsewhere.");
    // The live connection goes through the test, which can drop it and refuse new ones while "offline".
    let online = true;
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/v1\/live\//, ws => {
      if (!online) return ws.close({ code: 4000, reason: "offline (test)" });
      sockets.push(ws);
      ws.connectToServer();
    });
    await openDoc(page, doc.id);
    online = false;
    for (const ws of sockets.splice(0)) await ws.close({ code: 4000, reason: "dropped (test)" });
    await expect(docSyncState(page)).toContainText(/Offline|Connecting/);
    await caretAfter(page, "Typed online.");
    await page.keyboard.type(" Typed while offline.");
    // Meanwhile the doc changes elsewhere.
    await ok(page, "POST", `/v1/docs/${doc.id}/edits`, { edits: [{ old: "Changed elsewhere.", new: "Changed elsewhere, meanwhile." }] });
    await page.waitForTimeout(1_500);
    expect(await markdownOf(page, doc.id), "nothing reaches the service while the connection is down").toBe("Typed online.\n\nChanged elsewhere, meanwhile.\n");
    await expect(docSyncState(page)).not.toHaveAccessibleName("Connected and synced");
    await shot(page, "offline");
    // Back: both changes are kept, on the page and in the service.
    online = true;
    await expect(docSyncState(page)).toHaveAccessibleName("Connected and synced", { timeout: 20_000 });
    await expectMarkdown(page, doc.id, "Typed online. Typed while offline.\n\nChanged elsewhere, meanwhile.\n");
    await expect.poll(() => docText(page)).toBe("Typed online. Typed while offline.\nChanged elsewhere, meanwhile.");
    await shot(page, "back-online");
    await context.close();
  });

  test("a Silicon's change appears at once, briefly highlighted with its name", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const { silicon, api, account: me } = await newSilicon("flash");
    const doc = await newDoc(page, `Flash ${tag()}`, "Draft paragraph.\n\nClosing line.");
    await share(page, doc.id, silicon.id, "editor");

    // What the live connection receives, in order (y-websocket: 0 sync, 1 awareness, 100 the service's JSON events).
    const frames: string[] = [];
    page.on("websocket", socket =>
      socket.on("framereceived", frame => {
        const bytes = typeof frame.payload === "string" ? Buffer.from(frame.payload) : frame.payload;
        if (bytes[0] === 100) {
          let at = 1;
          while (bytes[at] & 0x80) at++;
          frames.push(`event ${bytes.subarray(at + 1).toString("utf8").slice(0, 60)}`);
        } else frames.push(bytes[0] === 0 ? `sync ${["step1", "step2", "update"][bytes[1]] ?? bytes[1]}` : bytes[0] === 1 ? "awareness" : `type ${bytes[0]}`);
      }),
    );
    await openDoc(page, doc.id);
    // Record every highlight and every state of the text while the change arrives.
    const flashes = await watchFlashes(page);
    const before = frames.length;
    const edited = await api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Draft paragraph.", new: "Draft paragraph, reviewed and tightened by the Silicon." }] });
    expect(edited.status).toBe(200);
    await expect.poll(() => docText(page)).toContain("Draft paragraph, reviewed and tightened by the Silicon.");
    await page.waitForTimeout(300);
    await shot(page, "silicon-flash");
    const seen = await flashes();
    const arrived = frames.slice(before).join(" | ");
    test.info().annotations.push({ type: "frames after the Silicon's edit", description: arrived });
    // Never typed out letter by letter: the text went from before to after in one step.
    expect(seen.texts.filter(text => text.includes("reviewed") && !text.includes("reviewed and tightened by the Silicon."))).toEqual([]);
    await expectMarkdown(page, doc.id, "Draft paragraph, reviewed and tightened by the Silicon.\n\nClosing line.\n");
    expect.soft(seen.flashed, `the change was highlighted (frames after the edit: ${arrived})`).toBe(true);
    expect.soft(seen.labels, `the highlight's name label (frames after the edit: ${arrived})`).toContain(me.display_name || me.id);
    // A second change by the same Silicon (its author now known to the page) is highlighted too.
    await api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Closing line.", new: "Closing line, also by the Silicon." }] });
    await expect.poll(() => docText(page)).toContain("Closing line, also by the Silicon.");
    await page.waitForTimeout(300);
    const again = await flashes();
    expect.soft(again.labels, `the second change's name label (frames: ${frames.slice(before).join(" | ")})`).toContain(me.display_name || me.id);
    await context.close();
  });

  test("a Silicon in the doc shows up like a Carbon: its face, its cursor with its name, its typing", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const { silicon, api, account: me } = await newSilicon("live");
    const doc = await newDoc(page, `Live Silicon ${tag()}`, "Carbon's paragraph.\n\nSilicon's paragraph.");
    await share(page, doc.id, silicon.id, "editor");
    await openDoc(page, doc.id);
    // The Silicon joins live with a ticket of its own, the way the web editor does.
    const ticket = (await api.post(`/v1/docs/${doc.id}/live`)).body as { url: string; ticket: string; role: string };
    expect(ticket.role).toBe("editor");
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(ticket.url.slice(0, ticket.url.lastIndexOf("/")), doc.id, ydoc, {
      params: { ticket: ticket.ticket },
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    });
    // The service's own events (message 100) aren't needed here.
    provider.messageHandlers[100] = () => {};
    try {
      await expect.poll(() => provider.synced, { message: "the Silicon's live connection synced" }).toBe(true);
      const paragraph = ydoc.getXmlFragment("default").get(1) as Y.XmlElement;
      const text = paragraph.get(0) as Y.XmlText;
      expect(text.toString()).toBe("Silicon's paragraph.");
      const at = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, text.length));
      // Whatever name a client claims, the service shows the account behind the connection.
      provider.awareness.setLocalStateField("user", { name: "Someone else entirely", color: "#2c6f86" });
      provider.awareness.setLocalStateField("cursor", { anchor: at, head: at });
      const name = me.display_name || me.id;
      await expect(page.getByRole("group", { name: "Here now" }).getByRole("img", { name: new RegExp(`^${escapeRegex(name)}`) })).toBeVisible();
      await expect(page.getByRole("group", { name: "Here now" }).getByRole("img", { name: /Someone else entirely/ })).toHaveCount(0);
      await expect(editorOf(page).locator(".collaboration-carets__label", { hasText: name })).toBeVisible();
      await shot(page, "silicon-live-presence");

      // Its typing reaches the page and the service as one change.
      const flashes = await watchFlashes(page);
      text.insert(text.length, " Typed live by the Silicon.");
      await expect.poll(() => docText(page)).toContain("Silicon's paragraph. Typed live by the Silicon.");
      await expectMarkdown(page, doc.id, "Carbon's paragraph.\n\nSilicon's paragraph. Typed live by the Silicon.\n");
      await page.waitForTimeout(300);
      const first = await flashes();
      expect.soft(first.labels, "the name label on the Silicon's first live change").toContain(name);
      // A later change, once the page knows whose connection it is.
      text.insert(text.length, " And a second sentence.");
      await expect.poll(() => docText(page)).toContain("Typed live by the Silicon. And a second sentence.");
      await page.waitForTimeout(300);
      await shot(page, "silicon-live-typing");
      const second = await flashes();
      expect.soft(second.labels, "the name label on the Silicon's second live change").toContain(name);
      // Leaving takes its face away.
      provider.destroy();
      await expect(page.getByRole("group", { name: "Here now" }).getByRole("img", { name: new RegExp(`^${escapeRegex(name)}`) })).toBeHidden({ timeout: 15_000 });
    } finally {
      provider.destroy();
      ydoc.destroy();
    }
    await context.close();
  });
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Comments                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

test.describe("comments", () => {
  test("in Reading mode, selecting text opens the comment box at once and Enter posts it", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Reading ${tag()}`, "Opening line.\n\nThe quick brown fox jumps over the lazy dog.");
    await openDoc(page, doc.id);
    await chooseDocMode(page, "Reading");
    await expect(page.getByRole("button", { name: "Mode: Reading", exact: true })).toBeVisible();
    await expect(toolbarOf(page)).toBeHidden();
    await expect(editorOf(page)).toHaveAttribute("contenteditable", "false");
    // Escape closes the box without posting anything.
    await dragSelect(page, "Opening line");
    const box = newCommentBox(page);
    await expect(box).toBeVisible({ timeout: 2_000 });
    await page.keyboard.press("Escape");
    await expect(box).toBeHidden();
    await page.mouse.click(10, 300);

    await dragSelect(page, "brown fox jumps");
    await expect(box).toBeVisible({ timeout: 2_000 });
    await expect(box).toContainText("“brown fox jumps”");
    await expect(page.locator('[class*="commentPill"]')).toHaveCount(0);
    const field = box.getByRole("combobox", { name: "Comment" });
    await expect(field).toBeFocused();
    await page.keyboard.type("Is the fox the right animal?");
    await shot(page, "comment-viewing-box");
    await page.keyboard.press("Enter");
    await expect(box).toBeHidden();
    await expect(threadCards(page)).toHaveCount(1);
    await expect(threadCards(page)).toContainText("Is the fox the right animal?");
    await expect(editorOf(page).locator(".comment-anchor")).toHaveText("brown fox jumps");
    const threads = await threadsOf(page, doc.id);
    expect(threads.length).toBe(1);
    expect(threads[0]).toMatchObject({ anchor: { kind: "text" }, quote: "brown fox jumps", current_quote: "brown fox jumps", status: "open" });
    expect(threads[0].comments.map(c => c.body)).toEqual(["Is the fox the right animal?"]);
    // Commenting never changes the text.
    await expectMarkdown(page, doc.id, "Opening line.\n\nThe quick brown fox jumps over the lazy dog.\n");
    await shot(page, "comment-viewing-posted");
    await context.close();
  });

  test("in Editing mode a Comment button appears beside the selection, and ⌘⌥M comments too", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Editing comment ${tag()}`, "The quick brown fox jumps over the lazy dog.\n\nA second sentence to comment on.");
    await openDoc(page, doc.id);
    await select(page, "lazy dog");
    const pill = page.locator('[class*="commentPill"]').getByRole("button", { name: "Comment" });
    await expect(pill).toBeVisible();
    // Beside the selection: just under its end, and no comment box until it's asked for.
    const selection = await selectionRect(page);
    const box = (await pill.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(selection.bottom - 2);
    expect(box.y).toBeLessThan(selection.bottom + 40);
    expect(Math.abs(box.x - selection.right)).toBeLessThan(80);
    await expect(newCommentBox(page)).toBeHidden();
    await shot(page, "comment-editing-pill");
    await pill.click();
    const composer = newCommentBox(page);
    const field = composer.getByRole("combobox", { name: "Comment" });
    await expect(composer).toBeVisible();
    await expect(composer).toContainText("“lazy dog”");
    await expect(field).toBeFocused();
    await page.keyboard.type("Which dog?");
    await page.keyboard.press("Enter");
    await expect(composer).toBeHidden();
    await expect(threadCards(page)).toHaveCount(1);

    // The keyboard shortcut.
    await select(page, "second sentence");
    await page.keyboard.press("ControlOrMeta+Alt+m");
    await expect(composer).toBeVisible();
    await expect(composer).toContainText("“second sentence”");
    await expect(field).toBeFocused();
    await page.keyboard.type("Shorter, please.");
    await page.keyboard.press("Enter");
    await expect(threadCards(page)).toHaveCount(1);
    await expect(threadCards(page)).toContainText("Shorter, please.");
    await openComments(page);
    await expect(threadCards(page)).toHaveCount(2);
    const threads = await threadsOf(page, doc.id);
    expect(threads.map(t => [t.anchor.kind, t.quote, t.comments[0]?.body])).toEqual([
      ["text", "lazy dog", "Which dog?"],
      ["text", "second sentence", "Shorter, please."],
    ]);
    await expectMarkdown(page, doc.id, "The quick brown fox jumps over the lazy dog.\n\nA second sentence to comment on.\n");
    await context.close();
  });

  test("the toolbar's Comment button with nothing selected comments on the whole section", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Section comment ${tag()}`, "First section text.\n\nSecond section text.");
    await openDoc(page, doc.id);
    await openFormatting(page);
    await caretAfter(page, "Second section");
    await toolbarOf(page).getByRole("button", { name: "Comment", exact: true }).click();
    const box = newCommentBox(page);
    await expect(box).toBeVisible();
    await expect(box).toContainText("On this section");
    await expect(box).toContainText("“Second section text.”");
    await expect(box.getByRole("combobox", { name: "Comment" })).toBeFocused();
    await page.keyboard.type("This section needs a source.");
    await page.keyboard.press("Enter");
    await expect(box).toBeHidden();
    const card = threadCards(page);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Section");
    await expect(card).toContainText("This section needs a source.");
    await expect(editorOf(page).locator(".comment-anchor-block")).toHaveText("Second section text.");
    const [thread] = await threadsOf(page, doc.id);
    expect(thread.anchor.kind).toBe("block");
    expect(thread.quote).toBe("Second section text.");
    expect(thread.comments.map(c => c.body)).toEqual(["This section needs a source."]);
    await expectMarkdown(page, doc.id, "First section text.\n\nSecond section text.\n");
    await shot(page, "comment-section");
    await context.close();
  });

  test("typing straight after ⌘⌥M goes into the comment, never into the doc", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Comment race ${tag()}`, "The quick brown fox jumps over the lazy dog.");
    await openDoc(page, doc.id);
    await select(page, "lazy dog");
    // How long the comment box takes to have the keyboard after the shortcut.
    await page.evaluate(() => {
      const race = { pressed: 0, focused: 0 };
      (window as unknown as { __race: typeof race }).__race = race;
      window.addEventListener("keydown", e => {
        if (e.code === "KeyM" && e.altKey && (e.metaKey || e.ctrlKey) && !race.pressed) race.pressed = performance.now();
      }, true);
      document.addEventListener("focusin", e => {
        if (!race.focused && (e.target as Element | null)?.closest?.('[role="dialog"][aria-label="New comment"]')) race.focused = performance.now();
      }, true);
    });
    // A Carbon who knows the shortcut presses it and types on at once (a fast typist: 30 ms between keys).
    await page.keyboard.press("ControlOrMeta+Alt+m");
    await page.keyboard.type("Which dog?", { delay: 30 });
    const box = newCommentBox(page);
    await expect(box).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(box).toBeHidden();
    await expect(threadCards(page)).toHaveCount(1);
    const race = await page.evaluate(() => (window as unknown as { __race: { pressed: number; focused: number } }).__race);
    const latency = Math.round(race.focused - race.pressed);
    test.info().annotations.push({ type: "⌘⌥M until the comment box has the keyboard", description: `${latency} ms` });
    // The doc is untouched (no keystroke replaced the selected text), and the comment has every letter.
    expect.soft(await markdownOf(page, doc.id), `the doc after commenting (the comment box took the keyboard ${latency} ms after ⌘⌥M)`).toBe("The quick brown fox jumps over the lazy dog.\n");
    expect.soft((await threadsOf(page, doc.id)).map(t => [t.quote, t.comments[0]?.body]), `the comment (the box took the keyboard ${latency} ms after ⌘⌥M)`).toEqual([["lazy dog", "Which dog?"]]);
    await context.close();
  });

  test("a section can be commented on by clicking next to it in the margin", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Margin comment ${tag()}`, "First section text.\n\nSecond section text.");
    await openDoc(page, doc.id);
    await chooseDocMode(page, "Reading");
    const paragraph = editorOf(page).locator("p", { hasText: "Second section text." });
    const box = (await paragraph.boundingBox())!;
    // The margin left of the reading column, level with the section.
    await page.mouse.move(box.x - 24, box.y + box.height / 2);
    await expect(page.getByRole("button", { name: "Comment on this section" })).toBeVisible();
    await shot(page, "comment-margin-hover");
    await page.mouse.click(box.x - 24, box.y + box.height / 2);
    const composer = newCommentBox(page);
    await expect(composer).toBeVisible({ timeout: 3_000 });
    await expect(composer).toContainText("On this section");
    await expect(composer).toContainText("“Second section text.”");
    await expect(composer.getByRole("combobox", { name: "Comment" })).toBeFocused();
    await page.keyboard.type("From the margin.");
    await page.keyboard.press("Enter");
    await expect(threadCards(page)).toHaveCount(1);
    const [thread] = await threadsOf(page, doc.id);
    expect([thread.anchor.kind, thread.quote, thread.comments[0]?.body]).toEqual(["block", "Second section text.", "From the margin."]);
    await context.close();
  });

  test("a table cell, an image and an area drawn on the image take comments too", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Cells and images ${tag()}`, "Intro line.");
    const src = await uploadImage(page, doc.id, "chart.png", png(240, 120));
    await ok(page, "PUT", `/v1/docs/${doc.id}/markdown`, { markdown: `Intro line.\n\n| Name | Role |\n| --- | --- |\n| Ada | Writer |\n\n![chart](${src})\n\nOutro line.\n` });
    await openDoc(page, doc.id);
    await openFormatting(page);
    const editor = editorOf(page);
    const composer = newCommentBox(page);

    // A cell: the caret in it, then the toolbar's Comment.
    await caretAfter(page, "Writer");
    await toolbarOf(page).getByRole("button", { name: "Comment", exact: true }).click();
    await expect(composer).toBeVisible();
    await expect(composer).toContainText("On this cell");
    await expect(composer).toContainText("“Writer”");
    const field = composer.getByRole("combobox", { name: "Comment" });
    await expect(field).toBeFocused();
    await page.keyboard.type("Is Ada the only writer?");
    await page.keyboard.press("Enter");
    await expect(composer).toBeHidden();
    await expect(threadCards(page).filter({ hasText: "Is Ada the only writer?" })).toContainText("Cell");
    await expect(editor.locator("td.comment-anchor")).toHaveText("Writer");

    // An area of the image: select the image, "Comment on an area", drag over it.
    const image = editor.locator("img");
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(240);
    await image.click();
    const imageBar = page.getByRole("button", { name: "Comment on image" });
    await expect(imageBar).toBeVisible();
    await page.getByRole("button", { name: "Comment on an area" }).click();
    const canvas = page.getByRole("application", { name: "Drag over the image to choose the area" });
    await expect(canvas).toBeVisible();
    await dragOver(page, (await canvas.boundingBox())!, [0.1, 0.2], [0.5, 0.7]);
    await expect(composer).toBeVisible();
    await expect(composer).toContainText("On this area of the image");
    await expect(field).toBeFocused();
    await page.keyboard.type("This bar looks wrong.");
    await page.keyboard.press("Enter");
    await expect(composer).toBeHidden();
    await expect(page.getByRole("button", { name: "Comment on this area" })).toHaveCount(1);
    await shot(page, "comment-image-area");

    // The whole image: select it (clicking outside the area), then "Comment on image".
    const imageBox = (await image.boundingBox())!;
    const outsideArea = { x: imageBox.x + imageBox.width * 0.85, y: imageBox.y + imageBox.height * 0.12 };
    await page.mouse.click(outsideArea.x, outsideArea.y);
    await imageBar.click();
    await expect(composer).toBeVisible();
    await expect.soft(composer, "the comment box for “Comment on image” (the whole image)").toContainText("On this image");
    await shot(page, "comment-image-box");
    await expect(field).toBeFocused();
    await page.keyboard.type("A clearer chart, please.");
    await page.keyboard.press("Enter");
    await expect(composer).toBeHidden();
    await expect(threadCards(page)).toHaveCount(1);
    // The image can still be picked afterwards (to comment on another part of it, or to remove it).
    await editorOf(page).focus();
    await caretAfter(page, "Outro line.");
    await page.mouse.click(outsideArea.x, outsideArea.y);
    await expect.soft(imageBar, "the image's bar after clicking the image, once the whole image has a comment").toBeVisible({ timeout: 3_000 });
    await shot(page, "comment-image-after");

    const threads = await threadsOf(page, doc.id);
    const byBody = (body: string) => threads.find(t => t.comments[0]?.body === body);
    expect(byBody("Is Ada the only writer?")?.anchor.kind).toBe("cell");
    expect(byBody("Is Ada the only writer?")?.quote).toBe("Writer");
    expect(byBody("A clearer chart, please.")?.anchor.kind).toBe("image");
    expect.soft(byBody("A clearer chart, please.")?.anchor.rect, "the anchor of a comment on the whole image (an area, or no area at all)").toBeUndefined();
    const area = byBody("This bar looks wrong.");
    expect(area?.anchor.kind).toBe("image");
    expect(area?.anchor.rect?.x).toBeCloseTo(0.1, 1);
    expect(area?.anchor.rect?.y).toBeCloseTo(0.2, 1);
    expect(area?.anchor.rect?.w).toBeCloseTo(0.4, 1);
    expect(area?.anchor.rect?.h).toBeCloseTo(0.5, 1);
    await openComments(page);
    await expect(threadCards(page)).toHaveCount(3);
    await expect(threadCards(page).filter({ hasText: "This bar looks wrong." })).toContainText("Image area");
    await expectMarkdown(page, doc.id, `Intro line.\n\n| Name | Role |\n| --- | --- |\n| Ada | Writer |\n\n![chart](${src})\n\nOutro line.\n`);
    await context.close();
  });

  test("replying, reacting, editing and resolving in the panel, and reopening a resolved thread", async ({ browser }) => {
    const { page, context, account } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Threads ${tag()}`, "A sentence that needs work.\n\nAnother line.");
    const created = await ok<Thread>(page, "POST", `/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "needs work" }, body: "What kind of work?" });
    const thread = async () => (await threadsOf(page, doc.id)).find(t => t.id === created.id)!;
    await openDoc(page, doc.id);
    await expect(page.getByRole("complementary", { name: "All comments", exact: true })).toBeHidden();
    await openComments(page);
    const card = threadCards(page).filter({ hasText: "What kind of work?" });
    await expect(card).toBeVisible();
    await expect(editorOf(page).locator(".comment-anchor")).toHaveText("needs work");
    const reply = card.getByRole("combobox", { name: "Reply, or @mention someone" });
    await reply.click();
    await page.keyboard.type("A clearer opening, mostly.");
    await card.getByRole("button", { name: "Send", exact: true }).click();
    await expect(card).toContainText("A clearer opening, mostly.");
    await expect.poll(async () => (await thread()).comments.map(c => c.body)).toEqual(["What kind of work?", "A clearer opening, mostly."]);
    await shot(page, "comment-replied");

    // A reaction on the first comment.
    await card.getByRole("button", { name: "Add reaction" }).first().click();
    await card.getByRole("button", { name: "React with 👍" }).click();
    await expect(card.getByRole("button", { name: "👍 1, including you" })).toBeVisible();
    await expect.poll(async () => (await thread()).comments[0].reactions.map(r => [r.emoji, r.accounts.map(a => a.uuid)])).toEqual([["👍", [account.uuid]]]);
    // Editing the reply.
    await card.getByRole("button", { name: "Edit", exact: true }).last().click();
    const edit = card.getByRole("combobox", { name: "Edit comment" });
    await expect(edit).toBeFocused();
    await edit.fill("A clearer opening, and a shorter close.");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card).toContainText("A clearer opening, and a shorter close.");
    await expect.poll(async () => (await thread()).comments[1].body).toBe("A clearer opening, and a shorter close.");
    expect((await thread()).comments[1].edited_at).not.toBeNull();
    await shot(page, "comment-reacted-edited");

    await card.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(threadCards(page)).toHaveCount(0);
    await expect(page.getByText("No open comments. Select text to comment on it.")).toBeVisible();
    await expect(editorOf(page).locator(".comment-anchor")).toHaveCount(0);
    await expect.poll(async () => (await thread()).status).toBe("resolved");
    const [resolved] = await threadsOf(page, doc.id, "resolved");
    expect(resolved.resolved_by?.uuid).toBe(account.uuid);

    const panel = page.getByRole("complementary", { name: "All comments", exact: true });
    await panel.getByRole("button", { name: "Resolved", exact: true }).click();
    // A resolved thread keeps the conversation readable and offers Reopen.
    const resolvedCard = threadCards(page).filter({ hasText: "needs work" });
    await expect(resolvedCard).toBeVisible();
    await expect(resolvedCard).toContainText("Resolved");
    await expect(resolvedCard).toContainText("2 comments");
    await shot(page, "comment-resolved-list");
    await resolvedCard.getByRole("button", { name: "Reopen" }).click();
    await expect.poll(async () => (await thread()).status).toBe("open");
    await panel.getByRole("button", { name: "Open", exact: true }).click();
    await expect(threadCards(page).filter({ hasText: "What kind of work?" })).toBeVisible();
    await expect(editorOf(page).locator(".comment-anchor")).toHaveText("needs work");
    await context.close();
  });

  test("a photo opens only its conversation in place, with a separate complete list", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Focused comments ${tag()}`, "Alpha paragraph here.\n\nBeta paragraph here.");
    const first = await ok<Thread>(page, "POST", `/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Alpha paragraph" }, body: "Only the first note." });
    const second = await ok<Thread>(page, "POST", `/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: "Beta paragraph" }, body: "Only the second note." });
    await openDoc(page, doc.id);
    const marker = page.locator(`[data-comment-marker="${first.id}"]`);
    await expect(marker).toBeVisible();
    const before = await page.evaluate(() => window.scrollY);
    await marker.click();
    const focused = page.getByRole("dialog", { name: "Comment thread", exact: true });
    await expect(focused).toBeVisible();
    await expect(threadCards(page)).toHaveCount(1);
    await expect(focused).toContainText("Only the first note.");
    await expect(focused).not.toContainText("Only the second note.");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
    await expect(page.getByRole("complementary", { name: "All comments", exact: true })).toBeHidden();

    // Closing with Escape returns the keyboard to the photo without scrolling.
    await page.keyboard.press("Escape");
    await expect(focused).toBeHidden();
    await expect(marker).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(focused).toBeVisible();
    await focused.getByRole("button", { name: "All comments", exact: true }).click();
    const all = page.getByRole("complementary", { name: "All comments", exact: true });
    await expect(all).toBeVisible();
    await expect(focused).toBeHidden();
    await expect(threadCards(page)).toHaveCount(2);
    await all.getByRole("button", { name: "Close comments" }).click();

    // Text opens the same focused mode. Resolving does not replace it with another thread.
    await editorOf(page).locator(`[data-thread="${second.id}"]`).click();
    await expect(focused).toContainText("Only the second note.");
    await focused.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(focused).toContainText("Resolved comment");
    await expect(threadCards(page)).toHaveCount(1);
    await expect(focused).toContainText("Only the second note.");
    await focused.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(focused.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
    await focused.getByRole("button", { name: "Close comment", exact: true }).click();

    // A narrow screen keeps the single note inside the viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(`[data-comment-marker="${second.id}"]`).click();
    await expect(focused).toBeVisible();
    const box = (await focused.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect(threadCards(page)).toHaveCount(1);
    await context.close();
  });

  test("J and K move between the threads one by one", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Keys ${tag()}`, "Alpha paragraph here.\n\nBeta paragraph here.\n\nGamma paragraph here.");
    const ids: string[] = [];
    for (const word of ["Alpha", "Beta", "Gamma"]) {
      ids.push((await ok<Thread>(page, "POST", `/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote: `${word} paragraph` }, body: `About ${word}.` })).id);
    }
    await openDoc(page, doc.id);
    await openComments(page);
    await expect(threadCards(page)).toHaveCount(3);
    const active = page.locator("[data-thread-card][data-active]");
    await page.getByRole("heading", { name: "All comments" }).click();
    await page.keyboard.press("j");
    await expect(active).toHaveAttribute("data-thread-card", ids[0]);
    await expect(editorOf(page).locator(".comment-anchor-active")).toHaveText("Alpha paragraph");
    await page.keyboard.press("j");
    await expect(active).toHaveAttribute("data-thread-card", ids[1]);
    await expect(editorOf(page).locator(".comment-anchor-active")).toHaveText("Beta paragraph");
    await page.keyboard.press("j");
    await expect(active).toHaveAttribute("data-thread-card", ids[2]);
    await page.keyboard.press("k");
    await expect(active).toHaveAttribute("data-thread-card", ids[1]);
    await page.keyboard.press("k");
    await expect(active).toHaveAttribute("data-thread-card", ids[0]);
    // From the first, K goes round to the last.
    await page.keyboard.press("k");
    await expect(active).toHaveAttribute("data-thread-card", ids[2]);
    await expect(page.getByText("3 threads · J and K move between them")).toBeVisible();
    // Typing J in the doc types a J: the keys only move between threads outside the text.
    await caretAfter(page, "here.", 1);
    await page.keyboard.type("jk");
    await expect(active).toHaveAttribute("data-thread-card", ids[2]);
    await expectMarkdown(page, doc.id, "Alpha paragraph here.\n\nBeta paragraph here.jk\n\nGamma paragraph here.\n");
    await shot(page, "comment-keys");
    await context.close();
  });
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Suggestions and roles                                                                                             */
/* ---------------------------------------------------------------------------------------------------------------- */

test.describe("suggestions and roles", () => {
  test("in Suggesting mode typed and deleted text become suggestions the panel lists, and accepting applies them", async ({ browser }) => {
    const { page, context, account } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Suggest ${tag()}`, "The draft plan is ready.");
    await openDoc(page, doc.id);
    const editor = editorOf(page);
    await chooseDocMode(page, "Suggesting");
    await openFormatting(page);
    await expect(toolbarOf(page)).toContainText("Suggesting: your changes are proposed for review.");
    await caretAfter(page, "ready");
    await page.keyboard.type(" today");
    const inserted = editor.locator("ins.suggest-insert");
    await expect.poll(async () => (await inserted.allTextContents()).join("")).toBe(" today");
    expect.soft(await inserted.evaluateAll(els => [...new Set(els.map(el => el.getAttribute("data-suggestion")))].length), "suggestions made by typing “ today”").toBe(1);
    // Deleting a word and the space after it.
    await select(page, "draft ", { bounded: false });
    await page.keyboard.press("Backspace");
    await expect(editor.locator("del.suggest-delete")).toHaveText("draft ");
    await expect(editor).toContainText("The draft plan is ready today.");
    // The doc as it reads now is unchanged; the suggestions show in CriticMarkup.
    await expectMarkdown(page, doc.id, "The draft plan is ready.\n");
    await expect.poll(async () => (await markdownOf(page, doc.id, "?suggestions=critic")).replace(/\+\+\}\{\+\+/g, "")).toBe("The {--draft --}plan is ready{++ today++}.\n");
    expect.soft(await markdownOf(page, doc.id, "?suggestions=critic"), "the suggestions in CriticMarkup").toBe("The {--draft --}plan is ready{++ today++}.\n");

    await expect(page.getByRole("button", { name: "Comments", exact: true })).toHaveAccessibleDescription("0 open comment threads, 2 pending suggestions");
    await expect(page.getByRole("button", { name: "Comments", exact: true })).toContainText("2");
    await openComments(page);
    const list = suggestionsList(page);
    const cards = list.locator('[class*="suggestionCard"]');
    await expect(list).toBeVisible();
    const remove = cards.filter({ hasText: "Delete" });
    const adds = cards.filter({ hasText: "Add" });
    await expect(remove).toHaveCount(1);
    await expect(remove).toContainText("Delete draft");
    await expect(remove).toContainText(account.display_name || account.id);
    await expect.poll(async () => (await adds.locator("ins").allTextContents()).join("")).toBe(" today");
    expect.soft(await list.locator('[class*="panelSubhead"]').textContent(), "the panel's count").toContain("2 suggestions");
    await shot(page, "suggestions");
    const listed = (await ok<{ suggestions: Suggestion[] }>(page, "GET", `/v1/docs/${doc.id}/suggestions`)).suggestions;
    expect(listed.filter(s => s.deleted).map(s => [s.deleted, s.author?.uuid])).toEqual([["draft ", account.uuid]]);
    expect(listed.map(s => s.inserted).join("")).toBe(" today");
    expect(listed.every(s => s.author?.uuid === account.uuid)).toBe(true);

    // Accept the deletion: the word goes.
    await remove.getByRole("button", { name: "Accept", exact: true }).click();
    await expectMarkdown(page, doc.id, "The plan is ready.\n");
    await expect(editor.locator("del.suggest-delete")).toHaveCount(0);
    // Accept the addition (each card it was split into): the words join the text.
    for (let i = 0; i < 6 && (await adds.count()) > 0; i++) {
      const before = await adds.count();
      await adds.first().getByRole("button", { name: "Accept", exact: true }).click();
      await expect(adds).toHaveCount(before - 1);
    }
    await expectMarkdown(page, doc.id, "The plan is ready today.\n");
    await expect(inserted).toHaveCount(0);
    await expect(editor).toHaveText("The plan is ready today.");
    await expect(list).toBeHidden();
    await expectMarkdown(page, doc.id, "The plan is ready today.\n", "?suggestions=critic");
    await context.close();
  });

  test("Accept all and Reject all decide every suggestion at once", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `All at once ${tag()}`, "One two three.\n\nFour five six.");
    await openDoc(page, doc.id);
    await openComments(page);
    const list = suggestionsList(page);
    // Two suggestions arrive while the doc is open (made through the API, as the write CLI makes them).
    await ok(page, "POST", `/v1/docs/${doc.id}/edits`, { edits: [{ old: "two", new: "2" }], suggest: true });
    await ok(page, "POST", `/v1/docs/${doc.id}/edits`, { edits: [{ old: "five", new: "5" }], suggest: true });
    await expect(list).toContainText("2 suggestions");
    await expect(editorOf(page).locator("ins.suggest-insert")).toHaveText(["2", "5"]);
    await shot(page, "suggestions-all");
    await list.getByRole("button", { name: "Accept all", exact: true }).click();
    await expectMarkdown(page, doc.id, "One 2 three.\n\nFour 5 six.\n");
    await expectMarkdown(page, doc.id, "One 2 three.\n\nFour 5 six.\n", "?suggestions=critic");
    await expect(list).toBeHidden();
    await expect.poll(() => docText(page)).toBe("One 2 three.\nFour 5 six.");

    await ok(page, "POST", `/v1/docs/${doc.id}/edits`, { edits: [{ old: "three", new: "3" }], suggest: true });
    await ok(page, "POST", `/v1/docs/${doc.id}/edits`, { edits: [{ old: "six", new: "6" }], suggest: true });
    await expect(list).toContainText("2 suggestions");
    await list.getByRole("button", { name: "Reject all", exact: true }).click();
    await expectMarkdown(page, doc.id, "One 2 three.\n\nFour 5 six.\n", "?suggestions=critic");
    await expect(list).toBeHidden();
    await expect.poll(() => docText(page)).toBe("One 2 three.\nFour 5 six.");
    await context.close();
  });

  test("a commenter comments and proposes text, formatting and paragraph splits for review", async ({ browser }) => {
    const owner = await signedIn(browser, "carbon");
    const friend = await signedIn(browser, "friend");
    const doc = await newDoc(owner.page, `Commenter ${tag()}`, "The commenter reads this line.");
    await share(owner.page, doc.id, friend.account.id, "commenter");
    const page = friend.page;
    await openDoc(page, doc.id);
    const mode = page.getByRole("button", { name: "Mode: Commenting", exact: true });
    await mode.click();
    await expect(page.getByRole("menuitemradio")).toHaveText(["Commenting", "Suggesting"]);
    await expect(page.getByRole("menuitemradio", { name: "Commenting", exact: true })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(toolbarOf(page)).toBeHidden();
    await expect(editorOf(page)).toHaveAttribute("contenteditable", "false");
    // Selecting opens the comment box straight away.
    await dragSelect(page, "reads this line");
    await expect(newCommentBox(page)).toBeVisible({ timeout: 2_000 });
    await page.keyboard.type("Could it say more?");
    await page.keyboard.press("Enter");
    await expect(threadCards(page)).toHaveCount(1);
    expect((await threadsOf(owner.page, doc.id)).map(t => [t.quote, t.created_by.uuid])).toEqual([["reads this line", friend.account.uuid]]);

    await chooseDocMode(page, "Suggesting");
    await openFormatting(page);
    await expect(toolbarOf(page)).toContainText("Suggesting: your changes are proposed for review.");
    await caretAfter(page, "reads");
    await page.keyboard.type(" closely");
    const inserted = editorOf(page).locator("ins.suggest-insert");
    await expect.poll(async () => (await inserted.allTextContents()).join("")).toBe(" closely");
    // One typed word is one suggestion (one card to accept), not a suggestion every few letters.
    expect.soft(await inserted.evaluateAll(els => [...new Set(els.map(el => el.getAttribute("data-suggestion")))].length), "suggestions made by typing “ closely”").toBe(1);
    await expectMarkdown(owner.page, doc.id, "The commenter reads this line.\n");
    await expect.poll(async () => (await markdownOf(owner.page, doc.id, "?suggestions=critic")).replace(/\+\+\}\{\+\+/g, "")).toBe("The commenter reads{++ closely++} this line.\n");
    expect.soft(await markdownOf(owner.page, doc.id, "?suggestions=critic"), "the suggestion in CriticMarkup").toBe("The commenter reads{++ closely++} this line.\n");
    await expect(toolbarOf(page).getByRole("button", { name: "Bold", exact: true })).toBeVisible();
    await shot(page, "commenter-suggesting");
    // A commenter can propose changes but cannot decide them.
    await expect(suggestionsList(page)).toBeVisible();
    await expect(suggestionsList(page).getByRole("button", { name: /^(Accept|Reject)/ })).toHaveCount(0);
    await openDoc(owner.page, doc.id);
    await openComments(owner.page);
    const list = suggestionsList(owner.page);
    await expect(list).toContainText(friend.account.display_name || friend.account.id);
    await list.getByRole("button", { name: /^Reject(?: all)?$/ }).first().click();
    await expectMarkdown(owner.page, doc.id, "The commenter reads this line.\n", "?suggestions=critic");
    await expect(editorOf(page).locator("ins.suggest-insert")).toHaveCount(0);
    await expect.poll(() => docText(page)).toBe("The commenter reads this line.");
    await expect.poll(async () => (await threadsOf(owner.page, doc.id)).map(t => t.current_quote)).toEqual(["reads this line"]);

    // Formatting is reviewable too, without changing the accepted document.
    await select(page, "commenter");
    await toolbarOf(page).getByRole("button", { name: "Bold", exact: true }).click();
    await expect(list).toBeVisible();
    await expectMarkdown(owner.page, doc.id, "The commenter reads this line.\n");
    await list.getByRole("button", { name: /^Reject(?: all)?$/ }).first().click();
    await expect(list).toBeHidden();
    await expect(editorOf(page).locator("strong")).toHaveCount(0);
    await expect.poll(async () => (await threadsOf(owner.page, doc.id)).map(t => t.current_quote)).toEqual(["reads this line"]);

    // Enter proposes a paragraph split; the owner can accept the structural change.
    await caretAfter(page, "commenter");
    await page.keyboard.press("Enter");
    await expect(list).toBeVisible();
    await expectMarkdown(owner.page, doc.id, "The commenter reads this line.\n");
    await expect(suggestionsList(page).getByRole("button", { name: /^(Accept|Reject)/ })).toHaveCount(0);
    await list.getByRole("button", { name: /^Accept(?: all)?$/ }).first().click();
    await expectMarkdown(owner.page, doc.id, "The commenter\n\n reads this line.\n");
    await expect(editorOf(page).locator("p")).toHaveCount(2);
    await expect.poll(async () => (await threadsOf(owner.page, doc.id)).map(t => t.current_quote)).toEqual(["reads this line"]);
    await friend.context.close();
    await owner.context.close();
  });

  test("on a phone a commenter switches between commenting and proposing changes", async ({ browser }) => {
    const owner = await signedIn(browser, "carbon");
    const friend = await signedIn(browser, "friend");
    const doc = await newDoc(owner.page, `Phone review ${tag()}`, "Read this proposal.");
    await owner.page.setViewportSize({ width: 390, height: 844 });
    await openDoc(owner.page, doc.id);
    await owner.page.getByRole("button", { name: `Title: ${doc.title}`, exact: true }).click();
    const title = owner.page.getByRole("textbox", { name: "Title", exact: true });
    await title.fill("A phone review with a long title and room to rename it");
    await owner.page.getByRole("button", { name: "Save title", exact: true }).click();
    await expect.poll(async () => (await ok<Doc>(owner.page, "GET", `/v1/docs/${doc.id}`)).title).toBe("A phone review with a long title and room to rename it");
    await share(owner.page, doc.id, friend.account.id, "commenter");
    const page = friend.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await openDoc(page, doc.id);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Mode", exact: true }).click();
    await expect(page.getByRole("menuitemradio", { name: "Editing", exact: true })).toHaveCount(0);
    await page.getByRole("menuitemradio", { name: "Suggesting", exact: true }).click();
    await openFormatting(page);
    await expect(toolbarOf(page)).toBeVisible();
    await expect(editorOf(page)).toHaveAttribute("contenteditable", "true");
    await caretAfter(page, "Read");
    await page.keyboard.type(" closely");
    await expectMarkdown(owner.page, doc.id, "Read this proposal.\n");
    await expectMarkdown(owner.page, doc.id, "Read{++ closely++} this proposal.\n", "?suggestions=critic");
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Mode", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Commenting", exact: true }).click();
    await expect(toolbarOf(page)).toBeHidden();
    await expect(editorOf(page)).toHaveAttribute("contenteditable", "false");
    await popupGone(page);
    await shot(page, "phone-commenter");
    await ok(owner.page, "PUT", `/v1/docs/${doc.id}/public`, { access: "view" });
    const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const publicPage = await publicContext.newPage();
    await publicPage.goto(new URL(`/d/${doc.id}`, owner.page.url()).href);
    const home = publicPage.getByRole("link", { name: "Silicon Write home", exact: true });
    await expect(home).toBeVisible();
    await expect(home.locator("svg")).toBeVisible();
    await shot(publicPage, "phone-public-doc");
    await publicContext.close();
    await friend.context.close();
    await owner.context.close();
  });

  test("a viewer reads only: no formatting bar, no modes, no comment box, no changes", async ({ browser }) => {
    const owner = await signedIn(browser, "carbon");
    const friend = await signedIn(browser, "friend");
    const doc = await newDoc(owner.page, `Viewer ${tag()}`, "Only to be read.");
    await share(owner.page, doc.id, friend.account.id, "viewer");
    const page = friend.page;
    await openDoc(page, doc.id);
    await expect(page.getByRole("button", { name: /^Mode: / })).toHaveCount(0);
    await expect(toolbarOf(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Comments", exact: true })).toHaveCount(0);
    await expect(editorOf(page)).toHaveAttribute("contenteditable", "false");
    await dragSelect(page, "to be read");
    await page.waitForTimeout(800);
    await expect(newCommentBox(page)).toHaveCount(0);
    await editorOf(page).click();
    await page.keyboard.type("sneaky");
    await page.waitForTimeout(500);
    await expectMarkdown(owner.page, doc.id, "Only to be read.\n");
    // Find works for a viewer, without replace.
    await page.keyboard.press("ControlOrMeta+f");
    const bar = page.getByRole("search", { name: "Find in this doc" });
    await bar.getByRole("textbox", { name: "Find" }).fill("read");
    await expect(bar.getByText("1 of 1")).toBeVisible();
    await expect(bar.getByRole("textbox", { name: "Replace with" })).toHaveCount(0);
    await shot(page, "viewer");
    await friend.context.close();
    await owner.context.close();
  });
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Versions                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

test.describe("versions", () => {
  test("the versions panel lists versions, opens one, shows what changed, names it, restores it and shows who wrote what", async ({ browser }) => {
    const { page, context, account } = await signedIn(browser, "carbon");
    const doc = await newDoc(page, `Versions ${tag()}`, "Version one text.");
    await openDoc(page, doc.id);
    await caretAfter(page, "Version one text.");
    await page.keyboard.type(" Typed live.");
    await expectMarkdown(page, doc.id, "Version one text. Typed live.\n");
    await ok(page, "POST", `/v1/docs/${doc.id}/edits`, { edits: [{ old: "Typed live.", new: "Typed live, then edited." }] });
    await expect(editorOf(page)).toContainText("Typed live, then edited.");
    const versions = await versionsOf(page, doc.id);
    expect(versions.map(v => v.origin)).toEqual(["edit", "live", "create"]);
    const first = versions[2];

    await docMenu(page, "Version history");
    const panel = page.getByRole("complementary", { name: "Version history", exact: true });
    await expect(panel).toBeVisible();
    const rows = panel.getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("Current");
    await expect(rows.nth(2)).toContainText(`${account.id} created the doc`);
    await shot(page, "versions-list");

    // Open the first version: what changed in it ("Changes").
    await rows.nth(2).getByRole("button").click();
    const detail = page.getByRole("complementary", { name: "Version", exact: true });
    await expect(detail.getByRole("heading", { level: 2 })).toHaveText(`${account.id} created the doc`);
    await expect(detail.getByRole("button", { name: "Changes", exact: true })).toHaveAttribute("aria-pressed", "true");
    const change = detail.locator("[data-change]");
    await expect(change).toHaveCount(1);
    await expect(change.locator("ins")).toHaveText("Version one text.");
    await shot(page, "versions-changes");
    // The version that created the doc added its text: there was nothing before it to bring back.
    expect.soft(await change.getAttribute("data-change"), "how the first version's text shows in its changes").toBe("added");
    await expect.soft(change.getByRole("button", { name: "Bring this back" }), "“Bring this back” on the text the doc was created with").toHaveCount(0);
    // The whole doc as it was.
    await detail.getByRole("button", { name: "Whole doc" }).click();
    await expect(detail.locator(".ProseMirror")).toHaveText("Version one text.");
    await detail.getByRole("button", { name: "Changes", exact: true }).click();

    // Name it.
    const name = detail.getByRole("textbox", { name: "Version name" });
    await name.fill("Sent to the client");
    await name.press("Enter");
    await expect(page.getByText("Version named")).toBeVisible();
    await expect(detail.getByRole("heading", { level: 2 })).toHaveText("Sent to the client");
    await expect.poll(async () => (await versionsOf(page, doc.id)).find(v => v.seq === first.seq)?.name).toBe("Sent to the client");
    await shot(page, "versions-named");

    // Restore it: the doc reads as it did, and the restore is itself the newest version.
    await detail.getByRole("button", { name: "Restore this version" }).click();
    await expect(page.getByText("Restored: it's the newest version now")).toBeVisible();
    await expect(editorOf(page)).toHaveText("Version one text.");
    await expectMarkdown(page, doc.id, "Version one text.\n");
    const after = await versionsOf(page, doc.id);
    expect(after[0].origin).toBe("restore");
    expect(after[0].summary).toBe(`${account.id} restored an earlier version`);
    expect(after.length).toBe(4);
    // Nothing after it is lost: the edited text is still in the history.
    const edited = await ok<{ markdown: string }>(page, "GET", `/v1/docs/${doc.id}/versions/${versions[0].seq}/markdown`);
    expect(edited.markdown).toBe("Version one text. Typed live, then edited.\n");

    // Back to the list: the named version, and who wrote what.
    await detail.getByRole("button", { name: "All versions" }).click();
    await expect(panel.getByText("Sent to the client")).toBeVisible();
    await expect(panel.getByRole("listitem")).toHaveCount(4, { timeout: 20_000 });
    await panel.getByRole("switch", { name: "Show who wrote what" }).click();
    const gutter = editorOf(page).locator(".authorship-gutter");
    await expect(gutter.first()).toBeVisible();
    await expect(gutter.first()).toHaveAttribute("aria-label", `Written by ${account.id}`);
    await shot(page, "versions-who-wrote-what");
    await panel.getByRole("switch", { name: "Show who wrote what" }).click();
    await expect(gutter).toHaveCount(0);
    await context.close();
  });

  test("from a version: compare it with the doc now, bring back one part, and undo one Carbon's changes", async ({ browser }) => {
    const owner = await signedIn(browser, "carbon");
    const friend = await signedIn(browser, "friend");
    const doc = await newDoc(owner.page, `Going back ${tag()}`, "Intro paragraph.\n\nMiddle paragraph.\n\nOutro paragraph.");
    await share(owner.page, doc.id, friend.account.id, "editor");
    // The friend rewrites the middle; the owner deletes the outro and adds a line.
    await ok(friend.page, "POST", `/v1/docs/${doc.id}/edits`, { edits: [{ old: "Middle paragraph.", new: "Middle paragraph, rewritten by the friend." }] });
    await ok(owner.page, "POST", `/v1/docs/${doc.id}/edits`, { edits: [{ old: "\n\nOutro paragraph.", new: "\n\nA new closing line." }] });
    await expectMarkdown(owner.page, doc.id, "Intro paragraph.\n\nMiddle paragraph, rewritten by the friend.\n\nA new closing line.\n");
    await openDoc(owner.page, doc.id);
    const page = owner.page;
    await docMenu(page, "Version history");
    const panel = page.getByRole("complementary", { name: "Version history", exact: true });
    const rows = panel.getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await rows.last().getByRole("button").click();
    const detail = page.getByRole("complementary", { name: "Version", exact: true });
    await expect(detail.getByRole("heading", { level: 2 })).toHaveText(`${owner.account.id} created the doc`);

    // Compared with the doc now: the middle changed (by the friend) and the outro was replaced (by the owner).
    await detail.getByRole("combobox", { name: "Compared with" }).click();
    await page.getByRole("option", { name: "The doc now" }).click();
    const changed = detail.locator('[data-change="changed"]');
    await expect(changed.filter({ hasText: "Middle paragraph" })).toContainText(`by ${friend.account.id}`);
    await expect(changed.filter({ hasText: "Middle paragraph" }).locator("ins")).toContainText(", rewritten by the friend");
    await shot(page, "versions-compare-now");

    // Bring back just the outro (it shows as changed into the new closing line).
    const outro = detail.locator("[data-change]").filter({ hasText: "Outro paragraph" });
    await expect(outro.locator("del")).toContainText("Outro paragraph");
    await expect(outro).toContainText(`by ${owner.account.id}`);
    await outro.getByRole("button", { name: "Bring this back" }).click();
    await expect(page.getByText("Brought back")).toBeVisible();
    await expect.poll(() => markdownOf(page, doc.id)).toContain("Outro paragraph.");
    const brought = await markdownOf(page, doc.id);
    expect(brought).toContain("Middle paragraph, rewritten by the friend.");
    expect(brought.startsWith("Intro paragraph.\n\n")).toBe(true);

    // Undo everything the friend changed since this version: only the friend's change goes.
    await detail.getByRole("button", { name: friend.account.id, exact: true }).click();
    await expect(page.getByText(`Undid ${friend.account.id}'s changes since this version`)).toBeVisible();
    await expect.poll(() => markdownOf(page, doc.id)).toBe(brought.replace("Middle paragraph, rewritten by the friend.", "Middle paragraph."));
    await expect.poll(() => docText(page)).toContain("Middle paragraph.");
    await shot(page, "versions-undo-account");
    // Going back never deletes anything: every version is still there.
    expect((await versionsOf(page, doc.id)).length).toBeGreaterThanOrEqual(5);
    await friend.context.close();
    await owner.context.close();
  });
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* PDFs                                                                                                              */
/* ---------------------------------------------------------------------------------------------------------------- */

test.describe("PDFs", () => {
  async function importPdf(page: Page, title: string): Promise<Doc> {
    const response = await page.request.post("/api/v1/docs/import", {
      headers: sameOrigin(),
      multipart: { file: { name: "plan.pdf", mimeType: "application/pdf", buffer: pdf(["Page one of the plan", "Page two of the plan"]) }, title },
    });
    expect(response.status(), await response.text()).toBe(201);
    const doc = (await response.json()) as Doc;
    expect(doc.kind).toBe("pdf");
    return doc;
  }

  test("a PDF shows its pages in the browser this suite runs, as it is", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await importPdf(page, `PDF as it is ${tag()}`);
    await page.goto(`/d/${doc.id}`);
    const first = page.getByRole("img", { name: "Page 1", exact: true });
    const shown = await first.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    await shot(page, "pdf-as-it-is");
    const said = (await page.locator("main p").allTextContents()).filter(text => text.trim()).join(" | ");
    expect(shown, `the PDF's first page shows in ${browser.browserType().name()} ${browser.version()} (the PDF view says: ${said || "nothing"})`).toBe(true);
    await context.close();
  });

  test("a PDF shows its pages and takes a comment on an area drawn over a page", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await importPdf(page, `PDF ${tag()}`);
    await page.goto(`/d/${doc.id}`);
    await expect(page.getByText("PDF, shown as it is · 2 pages")).toBeVisible({ timeout: 30_000 });
    const first = page.getByRole("img", { name: "Page 1", exact: true });
    await expect(first).toBeVisible();
    await expect(page.getByRole("img", { name: "Page 2", exact: true })).toBeAttached();
    expect(await first.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(500);
    await shot(page, "pdf-pages");

    await page.getByRole("button", { name: "Comment on an area" }).click();
    await expect(page.getByRole("button", { name: "Drag over an area" })).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, "pdf-drawing-mode");
    await dragOver(page, (await first.boundingBox())!, [0.1, 0.08], [0.6, 0.2]);
    await shot(page, "pdf-area-drawn");
    const composer = newCommentBox(page);
    await expect(composer).toBeVisible({ timeout: 5_000 });
    await expect(composer).toContainText("On this area of the page");
    await page.keyboard.type("This heading is wrong.");
    await page.keyboard.press("Enter");
    await expect(composer).toBeHidden();
    await expect.poll(async () => (await threadsOf(page, doc.id)).length).toBe(1);
    const [thread] = await threadsOf(page, doc.id);
    expect(thread.anchor.kind).toBe("pdf");
    expect(thread.anchor.rect?.page).toBe(1);
    expect(thread.anchor.rect?.x).toBeCloseTo(0.1, 1);
    expect(thread.anchor.rect?.w).toBeCloseTo(0.5, 1);
    expect(thread.comments.map(c => c.body)).toEqual(["This heading is wrong."]);
    await expect(page.getByRole("button", { name: "Comment on this area" })).toBeVisible();
    await expect(threadCards(page)).toContainText("Page 1");
    await expect(threadCards(page)).toContainText("This heading is wrong.");
    await shot(page, "pdf-commented");
    await context.close();
  });

  test("a comment on a PDF area shows on its page and in the comments", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await importPdf(page, `PDF threads ${tag()}`);
    const thread = await ok<Thread>(page, "POST", `/v1/docs/${doc.id}/threads`, { anchor: { kind: "pdf", rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.1, page: 2 } }, body: "Check this figure." });
    await page.goto(`/d/${doc.id}?thread=${thread.id}`);
    await expect(page.getByText("PDF, shown as it is · 2 pages")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Comments", exact: true })).toContainText("1");
    await expect(threadCards(page)).toHaveCount(1);
    await expect(threadCards(page)).toContainText("Page 2");
    await expect(threadCards(page)).toContainText("Check this figure.");
    const area = page.getByRole("button", { name: "Comment on this area" });
    await expect(area).toBeInViewport({ ratio: 1 });
    // It stays in view after the smooth scroll settles, rather than just passing through.
    await page.waitForTimeout(400);
    await expect(area).toBeInViewport({ ratio: 1 });
    // The area sits on page 2, where the comment put it.
    const pageTwo = (await page.getByRole("img", { name: "Page 2", exact: true }).boundingBox())!;
    const box = (await area.boundingBox())!;
    expect(box.x - pageTwo.x).toBeCloseTo(pageTwo.width * 0.1, -1);
    expect(box.y - pageTwo.y).toBeCloseTo(pageTwo.height * 0.1, -1);
    // Polling replies does not snap the reader back after they scroll elsewhere.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForTimeout(2200);
    await expect(area).not.toBeInViewport();
    // Clicking the area opens its thread.
    await area.click();
    await expect(threadCards(page).first()).toHaveAttribute("data-active", "");
    await shot(page, "pdf-thread");
    await context.close();
  });

  test("a PDF turns into a normal doc to edit it, and the PDF stays as its original", async ({ browser }) => {
    const { page, context } = await signedIn(browser, "carbon");
    const doc = await importPdf(page, `PDF to doc ${tag()}`);
    await page.goto(`/d/${doc.id}`);
    await page.getByRole("button", { name: "Turn into a doc" }).click();
    await expect(editorOf(page)).toBeVisible({ timeout: 30_000 });
    await expect(editorOf(page)).toContainText("Page one of the plan");
    await expect(editorOf(page)).toContainText("Page two of the plan");
    expect((await ok<Doc>(page, "GET", `/v1/docs/${doc.id}`)).kind).toBe("doc");
    const markdown = await markdownOf(page, doc.id);
    expect(markdown).toContain("Page one of the plan");
    const original = await page.request.get(`/api/v1/docs/${doc.id}/original`);
    expect(original.status()).toBe(200);
    expect(Buffer.from(await original.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    await shot(page, "pdf-turned-into-doc");
    await context.close();
  });
});

// File formats, end to end against the running service (UNDERSTANDING.md "Formats", docs/api.md).
//
//   node --test e2e/api/formats.test.mjs
//
// What it checks:
//  - Opening files as new docs (POST /v1/docs/import): .md .txt .docx .doc .odt .rtf .html .pdf, and
//    that what opens reads right: headings, lists, checklists, tables, bold/italic/strike/code, links,
//    quotes, maths, code blocks, footnotes; pictures inside a file become uploaded images the doc
//    points at; formatting Markdown can't write (text colour, highlight, underline) is never dropped.
//  - Downloading (GET /v1/docs/{id}/export) in md, txt, docx, odt, rtf, html and pdf: the bytes, the
//    text inside, colours and pictures, file names; older versions by `seq` (editors only).
//  - Opening a file on top of a doc (POST /v1/docs/{id}/import): the next version, the old text stays
//    in the history, comments stay, people editing live see it.
//  - PDFs: shown as they are (kind pdf), the original served, turned into a doc with its text.
//  - Refusals: unsupported or broken files, PDFs on top of docs, too-large uploads; image uploads
//    (POST /v1/docs/{id}/assets) take images only, judged by their bytes.
//
// Fixtures are in ./fixtures/formats, made from rich.md, embedded-image.md, pictures.md and
// styled.html with pandoc and LibreOffice by ./fixtures/formats/regenerate.sh (the tests only read
// them).
//
// Every test signs up its own Carbons (one test makes a Silicon) and makes its own docs, so the
// tests are independent and can run again and again. Needs the local stack (e2e/lib/stack.mjs),
// `pdftotext` for reading downloaded PDFs (PDFTOTEXT overrides; those checks are skipped without it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { deflateSync, inflateRawSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { signUpCarbon, carbonTokens, createSilicon, siliconTokens, writeApi, env, unique } from "../lib/stack.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "formats");
const fx = name => readFileSync(join(FX, name));
const RICH_MD = fx("rich.md").toString("utf8");
const DOT = fx("dot.png");
const WEB = env.web.replace(/\/$/, "");
const SLOW = { timeout: 180_000 };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ------------------------------------------------------------------------------------------
// Accounts, docs, uploads
// ------------------------------------------------------------------------------------------

/** A new Carbon signed in to Write. */
async function carbon(label = "fmt") {
  const account = await signUpCarbon(label);
  const tokens = await carbonTokens(account);
  return Object.assign(account, { api: writeApi(tokens.access_token), token: tokens.access_token });
}

/** A new Silicon (custodian `custodian`) signed in to Write. Waits out the Accounts CLI's code limit. */
async function silicon(custodian, label = "writer") {
  for (let attempt = 1; ; attempt++) {
    try {
      const account = await createSilicon(custodian, label);
      const tokens = await siliconTokens(account);
      return Object.assign(account, { api: writeApi(tokens.access_token), token: tokens.access_token });
    } catch (error) {
      const wait = Number(String(error.message).match(/"retry_after_seconds":\s*(\d+)/)?.[1]);
      if (!wait || attempt >= 3) throw error;
      await sleep((wait + 2) * 1000);
    }
  }
}

const anonymous = writeApi(null);

function form(bytes, filename, fields = {}, type = "application/octet-stream") {
  const body = new FormData();
  body.set("file", new Blob([bytes], { type }), filename);
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

/** Opens a file as a new doc. `file` is a fixture name or { bytes, name }. */
function openFile(api, file, fields) {
  const { bytes, name } = typeof file === "string" ? { bytes: fx(file), name: file } : file;
  return api.raw("POST", "/v1/docs/import", form(bytes, name, fields));
}

/** Opens a file on top of an existing doc. */
function openOnTop(api, id, file) {
  const { bytes, name } = typeof file === "string" ? { bytes: fx(file), name: file } : file;
  return api.raw("POST", `/v1/docs/${id}/import`, form(bytes, name));
}

async function opened(api, file, fields) {
  const r = await openFile(api, file, fields);
  assert.equal(r.status, 201, `opening ${typeof file === "string" ? file : file.name}: ${show(r)}`);
  return r.body;
}

async function newDoc(api, markdown, title = `Doc ${unique()}`, extra = {}) {
  const r = await api.post("/v1/docs", { title, markdown, ...extra });
  assert.equal(r.status, 201, `creating a doc: ${show(r)}`);
  return r.body;
}

async function markdownOf(api, id, query = "") {
  const r = await api.get(`/v1/docs/${id}/markdown${query}`);
  assert.equal(r.status, 200, `reading ${id}: ${show(r)}`);
  return r.body.markdown;
}

async function download(api, id, format, query = "") {
  const r = await api.raw("GET", `/v1/docs/${id}/export?format=${format}${query}`);
  assert.equal(r.status, 200, `downloading ${id} as ${format}: ${show(r)}`);
  assert.ok(Buffer.isBuffer(r.body), `a ${format} download is a file, not JSON`);
  return r;
}

async function share(owner, id, to, role, what = "docs") {
  const r = await owner.api.post(`/v1/${what}/${id}/sharing`, { to: to.id, role });
  assert.equal(r.status, 201, `sharing ${id} with ${to.id} as ${role}: ${show(r)}`);
  return r.body;
}

async function makePublic(owner, id, access = "view") {
  const r = await owner.api.put(`/v1/docs/${id}/public`, { access });
  assert.equal(r.status, 200, `making ${id} public: ${show(r)}`);
}

async function docsOf(api) {
  const r = await api.get("/v1/docs");
  assert.equal(r.status, 200, show(r));
  return r.body.docs;
}

/** A short printable form of a response, for assertion messages. */
function show(r) {
  if (Buffer.isBuffer(r.body)) return `${r.status} [${r.headers.get("content-type")}] ${r.body.subarray(0, 300).toString("utf8")}`;
  return `${r.status} ${JSON.stringify(r.body).slice(0, 600)}`;
}

const errorOf = r => (Buffer.isBuffer(r.body) ? null : r.body?.error ?? null);
const typeOf = r => (r.headers.get("content-type") ?? "").split(";")[0].trim();

/** The two file names a Content-Disposition carries: the ASCII one and the UTF-8 one. */
function dispositionOf(r) {
  const value = r.headers.get("content-disposition") ?? "";
  const star = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  return { value, kind: value.split(";")[0].trim(), ascii: value.match(/filename="([^"]*)"/)?.[1], utf8: star ? decodeURIComponent(star) : undefined };
}

// ------------------------------------------------------------------------------------------
// Reading downloaded files
// ------------------------------------------------------------------------------------------

/** The entries of a zip file (docx, odt), name -> bytes. */
function unzip(bytes) {
  const buf = Buffer.from(bytes);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  assert.ok(end >= 0, "the file is a zip archive");
  const entries = new Map();
  let p = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "a well-formed zip directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

const entryText = (zip, name) => {
  assert.ok(zip.has(name), `the archive has ${name} (it has ${[...zip.keys()].join(", ")})`);
  return zip.get(name).toString("utf8");
};

const PDFTOTEXT = process.env.PDFTOTEXT ?? "pdftotext";
/** The text of a PDF, or null when pdftotext isn't installed. */
function pdfText(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "write-fmt-pdf-"));
  try {
    writeFileSync(join(dir, "file.pdf"), bytes);
    return execFileSync(PDFTOTEXT, ["-enc", "UTF-8", join(dir, "file.pdf"), "-"], { encoding: "utf8" });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Plain words of XML (tags dropped), for "the text is inside" checks that don't care about runs. */
const xmlWords = xml =>
  xml
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** The uploaded images a doc's Markdown points at: [{ alt, url, id }]. */
function uploadedImages(markdown) {
  const out = [];
  for (const m of markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const id = m[2].startsWith(`${WEB}/assets/`) ? m[2].slice(WEB.length + 8) : null;
    out.push({ alt: m[1], url: m[2], id });
  }
  return out;
}

/**
 * Fetches an image from the web origin docs point at, as `who` (an account with a token) or without signing in. Images
 * follow their doc's access: the web forwards the caller's token (or session) to the service, which checks it.
 */
const fromWeb = (url, who) => fetch(url, who ? { headers: { authorization: `Bearer ${who.token}` } } : {});

/** Fetches an uploaded image, as `who`, both from the service and from the web origin the doc points at. */
async function assertServedImage(who, image, expected = DOT) {
  assert.match(image.id ?? "", /^a_[A-Za-z0-9]+$/, `the doc points at an uploaded image on ${WEB}/assets/, not at ${image.url.slice(0, 120)}`);
  const direct = await who.api.raw("GET", `/v1/assets/${image.id}`);
  assert.equal(direct.status, 200, `GET /v1/assets/${image.id}: ${show(direct)}`);
  assert.equal(typeOf(direct), "image/png");
  if (expected) assert.ok(Buffer.from(direct.body).equals(expected), "the uploaded image is the picture from the file, byte for byte");
  const web = await fromWeb(image.url, who);
  assert.equal(web.status, 200, `the web editor serves ${image.url}`);
  assert.equal((web.headers.get("content-type") ?? "").split(";")[0], "image/png");
  assert.ok(Buffer.from(await web.arrayBuffer()).equals(Buffer.from(direct.body)), "the web origin serves the same bytes");
}

/** A PNG of random pixels, `w` x `h`, stored uncompressed (so its size is predictable). */
function noisePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = b => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3), 0x5a);
  for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

// ------------------------------------------------------------------------------------------
// What a rich doc must read like once opened (from fixtures/formats/rich.md)
// ------------------------------------------------------------------------------------------

const HEADINGS = ["# Report Title", "## Section One", "### Numbered Steps", "## Data Table", "## Maths", "## Code"];
const BULLETS = "- First bullet\n- Second bullet\n  - Nested bullet\n- Third bullet";
const STEPS = "1. Step one\n2. Step two\n3. Step three";
const CHECKLIST = "- [ ] Open task\n- [x] Done task";
const TABLE = "| City | Code |\n| --- | --- |\n| Berlin | BER |\n| Nairobi | NBO |";
const QUOTE = "> A quoted line with **bold** words.";
const FOOTNOTE = ["A sentence with a footnote.[^1]", "[^1]: The footnote text."];
const hasLine = (md, line) => md.split("\n").includes(line);
const inlineMaths = md => md.match(/(?<!\$)\$(?!\$)([^$\n]+)\$/)?.[1] ?? null;
const displayMaths = md => md.match(/\$\$\n([\s\S]*?)\n\$\$/)?.[1] ?? null;

function assertHeadings(md, what) {
  for (const heading of HEADINGS) assert.ok(hasLine(md, heading), `${what}: the heading line ${JSON.stringify(heading)} is there\n---\n${md}`);
}

function assertInlineFormatting(md, what, { code = true } = {}) {
  const intro = code
    ? "An **intro** paragraph with *italic*, ~~struck~~ words, `inline code` and a [link](https://example.com/page)."
    : "An **intro** paragraph with *italic*, ~~struck~~ words, inline code and a [link](https://example.com/page).";
  assert.ok(hasLine(md, intro), `${what}: bold, italic, strikethrough${code ? ", inline code" : ""} and the link read right\n---\n${md}`);
}

function assertMaths(md, what) {
  const inline = inlineMaths(md);
  assert.ok(inline && /E/.test(inline) && /m/.test(inline) && /c/.test(inline) && /\^\{?2\}?/.test(inline), `${what}: inline maths E = mc^2 stays maths, got ${JSON.stringify(inline)}\n---\n${md}`);
  const display = displayMaths(md);
  assert.ok(display && display.includes("\\int"), `${what}: the display integral stays a maths block, got ${JSON.stringify(display)}\n---\n${md}`);
}

function assertFootnote(md, what) {
  for (const line of FOOTNOTE) assert.ok(hasLine(md, line), `${what}: footnote line ${JSON.stringify(line)}\n---\n${md}`);
}

function assertNoBrokenImages(md, what) {
  for (const image of uploadedImages(md)) assert.ok(image.id, `${what}: every image is an uploaded one, not ${JSON.stringify(image.url.slice(0, 120))}\n---\n${md}`);
}

// ==========================================================================================
// Opening files
// ==========================================================================================

test("a Markdown file opens exactly as written, owned by whoever opened it", async () => {
  const me = await carbon("open-md");
  const doc = await opened(me.api, "rich.md");
  assert.equal(doc.kind, "doc");
  assert.equal(doc.title, "rich", "the title is the file's name without its extension");
  assert.equal(doc.owner.id, me.id);
  assert.equal(doc.created_by.id, me.id);
  assert.equal(doc.role, "owner");
  assert.equal(doc.folder_id, null);
  assert.equal(await markdownOf(me.api, doc.id), RICH_MD, "Markdown is the native format: it opens without any change");

  const versions = await me.api.get(`/v1/docs/${doc.id}/versions`);
  assert.equal(versions.status, 200, show(versions));
  const latest = versions.body.versions[0];
  assert.equal(latest.origin, "import");
  assert.equal(latest.summary, `${me.id} opened a file into the doc`);
  const activity = await me.api.get(`/v1/docs/${doc.id}/activity`);
  assert.ok(activity.body.events.some(e => e.kind === "doc.imported" && e.data?.filename === "rich.md"), `the doc's activity records the file: ${show(activity)}`);
});

test("every spelling of the extensions opens: .markdown .MD .htm .HTML .DOCX .TXT", async () => {
  const me = await carbon("open-ext");
  const cases = [
    [{ bytes: Buffer.from("# From markdown\n"), name: "notes.markdown" }, "# From markdown\n"],
    [{ bytes: Buffer.from("# Shouting\n"), name: "LOUD.MD" }, "# Shouting\n"],
    [{ bytes: Buffer.from("<p>An <b>htm</b> page</p>"), name: "page.htm" }, "An **htm** page\n"],
    [{ bytes: Buffer.from("<h2>Upper</h2>"), name: "PAGE.HTML" }, "## Upper\n"],
    [{ bytes: Buffer.from("Just text.\n"), name: "README.TXT" }, "Just text.\n"],
  ];
  for (const [file, expected] of cases) {
    const doc = await opened(me.api, file);
    assert.equal(await markdownOf(me.api, doc.id), expected, file.name);
  }
  const word = await opened(me.api, { bytes: fx("rich.docx"), name: "REPORT.DOCX" });
  assert.equal(word.title, "REPORT");
  assertHeadings(await markdownOf(me.api, word.id), "REPORT.DOCX");
});

test("a plain text file opens as its text: paragraphs, line breaks, and nothing read as Markdown", async () => {
  const me = await carbon("open-txt");
  const text = "Plain text fixture line one.\nSecond line in the same paragraph.\n\nA brand new paragraph here.\n";
  assert.equal(fx("plain.txt").toString("utf8"), text);
  const doc = await opened(me.api, "plain.txt");
  assert.equal(doc.kind, "doc");
  const md = await markdownOf(me.api, doc.id);
  assert.equal(md, "Plain text fixture line one.\\\nSecond line in the same paragraph.\n\nA brand new paragraph here.\n", "a blank line starts a paragraph; a single line break is a hard break");

  // Text that looks like Markdown is still just text.
  const tricky = "# Not a heading\n1. Not a list\n*not italic* and <b>not bold</b> and [not](a link) and $not maths$\n";
  const trickyDoc = await opened(me.api, { bytes: Buffer.from(tricky), name: "tricky.txt" });
  const txt = await download(me.api, trickyDoc.id, "txt");
  assert.equal(txt.body.toString("utf8").trim(), tricky.trim(), "the text reads back exactly as it was in the file");
  const pm = await me.api.get(`/v1/docs/${trickyDoc.id}/prosemirror`);
  assert.equal(pm.status, 200, show(pm));
  const nodes = JSON.stringify(pm.body.doc);
  assert.deepEqual(pm.body.doc.content.map(n => n.type), ["paragraph"], `one paragraph, no heading or list: ${nodes}`);
  const types = [];
  const walk = node => {
    types.push(node.type, ...(node.marks ?? []).map(m => `mark:${m.type}`));
    (node.content ?? []).forEach(walk);
  };
  walk(pm.body.doc);
  assert.deepEqual([...new Set(types)].sort(), ["doc", "hardBreak", "paragraph", "text"], `only text and line breaks, no formatting, links or maths: ${nodes}`);

  // Windows line endings read the same.
  const crlf = await opened(me.api, { bytes: Buffer.from(text.replace(/\n/g, "\r\n")), name: "windows.txt" });
  assert.equal(await markdownOf(me.api, crlf.id), md, "CRLF line endings read like LF ones");
});

test("plain text files in the encodings editors save read right", async t => {
  const me = await carbon("open-enc");
  await t.test("UTF-8 with a byte-order mark (Notepad's UTF-8 with BOM)", async () => {
    const doc = await opened(me.api, { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Hello there.\n")]), name: "bom.txt" });
    assert.equal(await markdownOf(me.api, doc.id), "Hello there.\n", "the byte-order mark isn't part of the text");
  });
  await t.test("UTF-16 with a byte-order mark (Notepad's Unicode)", async () => {
    const doc = await opened(me.api, { bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hello UTF-16 café\n", "utf16le")]), name: "unicode.txt" });
    assert.equal(await markdownOf(me.api, doc.id), "Hello UTF-16 café\n");
  });
  await t.test("Windows-1252 (Notepad's ANSI)", async () => {
    const doc = await opened(me.api, { bytes: Buffer.from("Café crème brûlée\n", "latin1"), name: "ansi.txt" });
    assert.equal(await markdownOf(me.api, doc.id), "Café crème brûlée\n");
  });
  await t.test("a Markdown file with a byte-order mark keeps its heading", async () => {
    const doc = await opened(me.api, { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Title\n\nBody text.\n")]), name: "bom.md" });
    assert.equal(await markdownOf(me.api, doc.id), "# Title\n\nBody text.\n");
  });
});

test("a Word (.docx) file opens with everything in it", SLOW, async () => {
  const me = await carbon("open-docx");
  const doc = await opened(me.api, "rich.docx");
  assert.equal(doc.kind, "doc");
  assert.equal(doc.title, "rich");
  const md = await markdownOf(me.api, doc.id);
  assertHeadings(md, ".docx");
  assertInlineFormatting(md, ".docx");
  for (const block of [BULLETS, STEPS, CHECKLIST, TABLE, QUOTE]) assert.ok(md.includes(block), `.docx: ${JSON.stringify(block)}\n---\n${md}`);
  assertMaths(md, ".docx");
  assert.match(md, /```[a-z]*\nprint\("hello"\)\n```/, ".docx: the code block");
  assertFootnote(md, ".docx");
  assert.ok(hasLine(md, "---") && hasLine(md, "Closing paragraph."), ".docx: the divider and the last paragraph");
});

test("an old Word (.doc) file opens with its structure", SLOW, async () => {
  const me = await carbon("open-doc");
  const doc = await opened(me.api, "rich.doc");
  assert.equal(doc.kind, "doc");
  const md = await markdownOf(me.api, doc.id);
  assertHeadings(md, ".doc");
  assertInlineFormatting(md, ".doc");
  assert.ok(md.includes(BULLETS), `.doc: the nested bullets\n---\n${md}`);
  // LibreOffice's .doc export restarts the numbering after the first step; the steps are what matter.
  for (const step of ["Step one", "Step two", "Step three"]) assert.match(md, new RegExp(`^\\d+[.)] ${step}$`, "m"), `.doc: ${step} is a numbered item`);
  for (const block of [CHECKLIST, TABLE, QUOTE]) assert.ok(md.includes(block), `.doc: ${JSON.stringify(block)}\n---\n${md}`);
  assertMaths(md, ".doc");
  assert.match(md, /```[a-z]*\nprint\("hello"\)\n```/, ".doc: the code block");
  assertFootnote(md, ".doc");
});

test("an OpenDocument (.odt) file opens with its structure", SLOW, async () => {
  const me = await carbon("open-odt");
  const doc = await opened(me.api, "rich.odt");
  const md = await markdownOf(me.api, doc.id);
  assertHeadings(md, ".odt");
  // Reading through Word preserves the code style and checklist that Pandoc's ODT reader loses.
  assertInlineFormatting(md, ".odt");
  for (const block of [BULLETS, STEPS, CHECKLIST, TABLE, QUOTE]) assert.ok(md.includes(block), `.odt: ${JSON.stringify(block)}\n---\n${md}`);
  assertMaths(md, ".odt");
  assert.ok(md.includes('print("hello")'), ".odt: the code text");
  assertFootnote(md, ".odt");
});

test("a rich text (.rtf) file opens with its formatting, lists and table text", SLOW, async () => {
  const me = await carbon("open-rtf");
  const doc = await opened(me.api, "rich.rtf");
  assert.equal(doc.kind, "doc");
  const md = await markdownOf(me.api, doc.id);
  assert.ok(md.includes("An **intro** paragraph with *italic*, ~~struck~~ words,"), `.rtf: bold, italic, strikethrough\n---\n${md}`);
  assert.ok(md.includes("[link](https://example.com/page)"), ".rtf: the link");
  assert.match(md, /^- First bullet$/m, ".rtf: bullets");
  assert.match(md, /^ {2}- Nested bullet$/m, ".rtf: the nested bullet");
  assert.match(md, /^1\. Step one$/m, ".rtf: numbered steps");
  for (const cell of ["City", "Berlin", "BER", "Nairobi", "NBO"]) assert.ok(md.includes(cell), `.rtf: the table cell ${cell}`);
});

test("a rich text (.rtf) file keeps its headings, quote, footnote and maths", SLOW, async () => {
  const me = await carbon("open-rtf2");
  const md = await markdownOf(me.api, (await opened(me.api, "rich.rtf")).id);
  assertHeadings(md, ".rtf");
  assert.ok(md.includes(QUOTE), `.rtf: the quote\n---\n${md}`);
  assertFootnote(md, ".rtf");
  assertMaths(md, ".rtf");
  assertNoBrokenImages(md, ".rtf");
});

test("a web page (.html) opens with everything in it", async () => {
  const me = await carbon("open-html");
  const doc = await opened(me.api, "rich.html");
  const md = await markdownOf(me.api, doc.id);
  assertHeadings(md, ".html");
  assertInlineFormatting(md, ".html");
  for (const block of [BULLETS, STEPS, CHECKLIST, TABLE, QUOTE]) assert.ok(md.includes(block), `.html: ${JSON.stringify(block)}\n---\n${md}`);
  assert.equal(inlineMaths(md), "E = mc^2", ".html: MathML comes back as the same LaTeX");
  assert.equal(displayMaths(md), "\\int_0^1 x^2 \\, dx");
  assert.match(md, /```[A-Za-z]*\nprint\("hello"\)\n```/, ".html: the code block");
  assertFootnote(md, ".html");
});

test("a code block in a web page keeps its language", async () => {
  const me = await carbon("open-html-code");
  // rich.html is what pandoc writes (and what Write's own .html download writes): <pre class="sourceCode python">.
  const md = await markdownOf(me.api, (await opened(me.api, "rich.html")).id);
  assert.match(md, /```python\nprint\("hello"\)\n```/, `the language is python\n---\n${md}`);
  // The other common way pages mark a language.
  const page = await opened(me.api, { bytes: Buffer.from('<h1>T</h1><pre><code class="language-js">let x = 1;\n</code></pre>'), name: "code.html" });
  assert.equal(await markdownOf(me.api, page.id), "# T\n\n```js\nlet x = 1;\n```\n");
});

test("an explicit title replaces the file name", async () => {
  const me = await carbon("open-title");
  const named = await opened(me.api, "rich.md", { title: "Custom Name" });
  assert.equal(named.title, "Custom Name");
  const blank = await opened(me.api, "rich.md", { title: "   " });
  assert.equal(blank.title, "rich", "a blank title falls back to the file name");
});

test("opening a file into a folder: own folders, shared folders, and folders you can't add to", async t => {
  const owner = await carbon("open-folder-owner");
  const friend = await carbon("open-folder-friend");
  const folder = await owner.api.post("/v1/folders", { name: `Plans ${unique()}` });
  assert.equal(folder.status, 201, show(folder));

  await t.test("into the opener's own folder", async () => {
    const doc = await opened(owner.api, "rich.md", { folder_id: folder.body.id });
    assert.equal(doc.folder_id, folder.body.id);
    assert.equal(doc.owner.id, owner.id);
  });
  await t.test("into a folder shared for editing: the folder's owner owns the doc, the opener made it", async () => {
    await share(owner, folder.body.id, friend, "editor", "folders");
    const doc = await opened(friend.api, "rich.docx", { folder_id: folder.body.id });
    assert.equal(doc.folder_id, folder.body.id);
    assert.equal(doc.owner.id, owner.id, "a folder never holds docs its owner doesn't control");
    assert.equal(doc.created_by.id, friend.id, "the doc still shows who created it");
    const pdf = await opened(friend.api, "rich.pdf", { folder_id: folder.body.id });
    assert.equal(pdf.kind, "pdf");
    assert.equal(pdf.owner.id, owner.id);
  });
  await t.test("into a folder shared only for viewing: refused, and no doc is made", async () => {
    const viewer = await carbon("open-folder-viewer");
    await share(owner, folder.body.id, viewer, "viewer", "folders");
    const r = await openFile(viewer.api, "rich.md", { folder_id: folder.body.id });
    assert.equal(r.status, 403, show(r));
    assert.equal(errorOf(r)?.code, "forbidden");
    assert.equal((await docsOf(viewer.api)).filter(d => d.owner.id === viewer.id).length, 0, "nothing was created");
  });
  await t.test("into a folder that doesn't exist", async () => {
    const r = await openFile(friend.api, "rich.md", { folder_id: "f_doesnotexist000000" });
    assert.equal(r.status, 404, show(r));
    assert.equal(errorOf(r)?.code, "not_found");
  });
});

// ==========================================================================================
// Pictures inside files
// ==========================================================================================

for (const [name, sameBytes] of [
  ["embedded-image.docx", true],
  ["embedded-image.odt", true],
  ["embedded-image.doc", false],
  ["embedded-image.rtf", false],
]) {
  test(`the picture inside a ${name.split(".").pop()} file becomes an uploaded image the doc points at`, SLOW, async () => {
    const me = await carbon(`img-${name.split(".").pop()}`);
    const doc = await opened(me.api, name);
    const md = await markdownOf(me.api, doc.id);
    assert.ok(md.includes("Text before the picture.") && md.includes("Text after the picture."), `the text around the picture\n---\n${md}`);
    const images = uploadedImages(md);
    assert.equal(images.length, 1, `one picture\n---\n${md}`);
    // LibreOffice may write the picture again on the way (.doc, .rtf), so only Word/OpenDocument promise the same bytes.
    await assertServedImage(me, images[0], sameBytes ? DOT : null);
  });
}

test("pictures in a Word table cell, and Word drawings browsers can't show, become images in the doc", SLOW, async t => {
  const me = await carbon("img-pictures");
  const doc = await opened(me.api, "pictures.docx");
  const md = await markdownOf(me.api, doc.id);
  const images = uploadedImages(md);
  assert.equal(images.length, 2, `two pictures\n---\n${md}`);
  await t.test("the picture in a table cell", async () => {
    const cell = images.find(i => i.alt === "Dot in a cell");
    assert.ok(cell, `the cell's picture keeps its description\n---\n${md}`);
    assert.match(md, /<td>\s*!\[Dot in a cell\]|\| !\[Dot in a cell\]/, "it is still inside the table");
    await assertServedImage(me, cell, DOT);
  });
  await t.test("a Word drawing (EMF) is shown as a PNG", async () => {
    const drawing = images.find(i => i.alt === "A drawing");
    assert.ok(drawing?.id, `the drawing is an uploaded image\n---\n${md}`);
    const r = await me.api.raw("GET", `/v1/assets/${drawing.id}`);
    assert.equal(r.status, 200);
    assert.equal(typeOf(r), "image/png", "browsers can't show EMF, so the doc gets a PNG");
    assert.ok(Buffer.from(r.body).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "PNG bytes");
  });
});

test("a picture embedded in a web page (data: URI) becomes an uploaded image", async () => {
  const me = await carbon("img-html");
  assert.ok(fx("embedded-image.html").toString("utf8").includes('src="data:image/png;base64,'), "the fixture carries the picture inside it");
  const md = await markdownOf(me.api, (await opened(me.api, "embedded-image.html")).id);
  const images = uploadedImages(md);
  assert.equal(images.length, 1, `one picture\n---\n${md.slice(0, 400)}`);
  await assertServedImage(me, images[0], DOT);
});

test("downloads of a doc opened from a web page keep the page's picture", SLOW, async () => {
  const me = await carbon("img-html-dl");
  const doc = await opened(me.api, "embedded-image.html");
  const docx = unzip((await download(me.api, doc.id, "docx")).body);
  assert.ok([...docx.keys()].some(k => k.startsWith("word/media/")), `the Word file carries the picture (entries: ${[...docx.keys()].join(", ")})`);
  const html = (await download(me.api, doc.id, "html")).body.toString("utf8");
  assert.match(html, /<img [^>]*src="data:image\/png;base64,/, "the web page download shows the picture");
});

test("a picture in a file opened on top of a doc becomes that doc's uploaded image", async () => {
  const me = await carbon("img-on-top");
  const doc = await newDoc(me.api, "# Before\n");
  const r = await openOnTop(me.api, doc.id, "embedded-image.docx");
  assert.equal(r.status, 200, show(r));
  const images = uploadedImages(await markdownOf(me.api, doc.id));
  assert.equal(images.length, 1);
  await assertServedImage(me, images[0], DOT);
});

// ==========================================================================================
// Formatting Markdown can't write is never dropped
// ==========================================================================================

const STYLED_LINE = 'Plain <span style="color: #ff0000">red words</span> then <mark style="background-color: #ffff00">yellow highlight</mark> then <u>underlined words</u> then ~~struck words~~ end.';

test("a web page opens keeping text colour, highlight, underline and strikethrough", async () => {
  const me = await carbon("styled-html");
  const md = await markdownOf(me.api, (await opened(me.api, "styled.html")).id);
  assert.equal(md, `# Styled Heading\n\n${STYLED_LINE}\n`);
});

test("a Word file opens keeping text colour, highlight, underline and strikethrough", async () => {
  // styled.docx is what LibreOffice (and Word) write for coloured text: <w:color>, <w:shd>, <w:u>, <w:strike>.
  const me = await carbon("styled-docx");
  const document = entryText(unzip(fx("styled.docx")), "word/document.xml");
  assert.ok(document.includes('<w:color w:val="FF0000"/>') && document.includes('w:fill="FFFF00"'), "the fixture's runs are coloured");
  const md = await markdownOf(me.api, (await opened(me.api, "styled.docx")).id);
  assert.ok(md.includes('<span style="color: #ff0000">red words</span>') || md.includes('<span style="color: #FF0000">red words</span>'), `the red text stays red\n---\n${md}`);
  assert.match(md, /<mark style="background-color: #(ffff00|FFFF00)">yellow highlight<\/mark>/, `the highlight stays\n---\n${md}`);
  assert.ok(md.includes("<u>underlined words</u>") && md.includes("~~struck words~~"), `underline and strikethrough stay\n---\n${md}`);
});

for (const format of ["docx", "odt", "rtf", "html"]) {
  test(`a doc downloaded as .${format} and opened on top of itself keeps its colour, highlight and underline`, SLOW, async () => {
    const me = await carbon(`styled-trip-${format}`);
    const doc = await newDoc(me.api, `${STYLED_LINE}\n`, "Styled");
    assert.equal(await markdownOf(me.api, doc.id), `${STYLED_LINE}\n`);
    const file = await download(me.api, doc.id, format);
    const r = await openOnTop(me.api, doc.id, { bytes: file.body, name: `Styled.${format}` });
    assert.equal(r.status, 200, show(r));
    const md = await markdownOf(me.api, doc.id);
    assert.ok(md.includes('<span style="color: #ff0000">red words</span>'), `.${format}: the text colour survives\n---\n${md}`);
    assert.match(md, /<mark style="background-color: #(ffff00|FFFF00)">yellow highlight<\/mark>/, `.${format}: the highlight survives\n---\n${md}`);
    assert.ok(md.includes("<u>underlined words</u>"), `.${format}: underline stays underline\n---\n${md}`);
    assert.ok(md.includes("~~struck words~~"), `.${format}: strikethrough survives`);
  });
}

test("downloading a doc and opening the file on top of it leaves the text as it was", SLOW, async t => {
  const me = await carbon("round-trip");
  const markdown = "# Plan\n\nIntro with **bold**, *italic* and a [link](https://example.com/).\n\n## Steps\n\n- One\n- Two\n\n1. First\n2. Second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
  for (const format of ["docx", "odt", "rtf", "html"]) {
    await t.test(`.${format}`, async () => {
      const doc = await newDoc(me.api, markdown, "Round Trip");
      const file = await download(me.api, doc.id, format);
      const r = await openOnTop(me.api, doc.id, { bytes: file.body, name: `Round Trip.${format}` });
      assert.equal(r.status, 200, show(r));
      const after = await markdownOf(me.api, doc.id);
      assert.ok(!/^(# )?Round Trip$/m.test(after), `.${format}: the doc's title didn't become part of its text\n---\n${after}`);
      assert.equal(after, markdown, `.${format}: the text is unchanged`);
    });
  }
});

// ==========================================================================================
// Downloading
// ==========================================================================================

async function richDoc(api, title = "Report Title") {
  return newDoc(api, RICH_MD, title);
}

test("downloading as Markdown gives the doc's Markdown (the default format)", async () => {
  const me = await carbon("dl-md");
  const doc = await richDoc(me.api);
  const md = await download(me.api, doc.id, "md");
  assert.equal(typeOf(md), "text/markdown");
  assert.deepEqual(dispositionOf(md), { value: `attachment; filename="Report Title.md"; filename*=UTF-8''Report%20Title.md`, kind: "attachment", ascii: "Report Title.md", utf8: "Report Title.md" });
  assert.equal(md.body.toString("utf8"), await markdownOf(me.api, doc.id));
  assert.equal(md.body.toString("utf8"), RICH_MD);
  const plain = await me.api.raw("GET", `/v1/docs/${doc.id}/export`);
  assert.equal(plain.status, 200);
  assert.equal(typeOf(plain), "text/markdown", "no format means Markdown");
  const alias = await download(me.api, doc.id, "markdown");
  assert.equal(dispositionOf(alias).ascii, "Report Title.md");
});

test("downloading as plain text gives the words without markup", async () => {
  const me = await carbon("dl-txt");
  const doc = await richDoc(me.api);
  const txt = await download(me.api, doc.id, "txt");
  assert.equal(typeOf(txt), "text/plain");
  assert.equal(dispositionOf(txt).ascii, "Report Title.txt");
  const text = txt.body.toString("utf8");
  for (const words of ["Report Title", "An intro paragraph with italic", "First bullet", "Nested bullet", "Step one", "Berlin", "NBO", 'print("hello")', "The footnote text.", "Closing paragraph."]) {
    assert.ok(text.includes(words), `the text has ${JSON.stringify(words)}\n---\n${text}`);
  }
  for (const markup of ["**", "# Report", "](https://", "[^1]:"]) assert.ok(!text.includes(markup), `no Markdown markup ${JSON.stringify(markup)} in plain text`);
});

test("downloading as Word gives a .docx with the doc's structure inside", SLOW, async () => {
  const me = await carbon("dl-docx");
  const doc = await richDoc(me.api);
  const r = await download(me.api, doc.id, "docx");
  assert.equal(typeOf(r), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(dispositionOf(r).ascii, "Report Title.docx");
  assert.equal(r.body.subarray(0, 4).toString("latin1"), "PK\u0003\u0004", "a .docx is a zip file");
  const zip = unzip(r.body);
  assert.ok(zip.has("[Content_Types].xml"));
  const document = entryText(zip, "word/document.xml");
  const words = xmlWords(document);
  for (const text of ["Report Title", "Section One", "Nested bullet", "Step three", "Open task", "Berlin", "NBO", "A quoted line with", 'print("hello")', "Closing paragraph."]) {
    assert.ok(words.includes(text), `word/document.xml has ${JSON.stringify(text)}`);
  }
  assert.match(document, /<w:pStyle w:val="Heading1"\s*\/>/, "headings are Word headings");
  assert.match(document, /<w:pStyle w:val="Heading3"\s*\/>/);
  assert.match(document, /<w:tbl>/, "the table is a Word table");
  assert.match(document, /<m:oMath/, "maths is Word maths");
  assert.match(document, /<w:strike\s*\/>/, "strikethrough");
  const numbering = entryText(zip, "word/numbering.xml");
  assert.ok(numbering.includes("\u2610") && numbering.includes("\u2612"), "the checklist's open and ticked boxes (Word list bullets)");
  assert.ok(entryText(zip, "word/_rels/document.xml.rels").includes('Target="https://example.com/page"'), "the link points at its address");
  assert.ok(xmlWords(entryText(zip, "word/footnotes.xml")).includes("The footnote text."), "the footnote is a Word footnote");
});

test("downloading as OpenDocument gives an .odt with the doc's structure inside", SLOW, async () => {
  const me = await carbon("dl-odt");
  const doc = await richDoc(me.api);
  const r = await download(me.api, doc.id, "odt");
  assert.equal(typeOf(r), "application/vnd.oasis.opendocument.text");
  assert.equal(dispositionOf(r).ascii, "Report Title.odt");
  const zip = unzip(r.body);
  assert.equal(zip.get("mimetype")?.toString("utf8"), "application/vnd.oasis.opendocument.text");
  const content = entryText(zip, "content.xml");
  const words = xmlWords(content);
  for (const text of ["Report Title", "Section One", "Nested bullet", "Step three", "Berlin", "NBO", "The footnote text.", "Closing paragraph."]) {
    assert.ok(words.includes(text), `content.xml has ${JSON.stringify(text)}`);
  }
  assert.match(content, /<text:h [^>]*text:outline-level="1"[^>]*>(<[^>]+>)*Report Title/, "the title heading is an OpenDocument heading");
  assert.match(content, /<table:table /, "the table");
  assert.match(content, /<text:note /, "the footnote");
  assert.match(content, /xlink:href="https:\/\/example\.com\/page"/, "the link");
  const formulas = [...zip.keys()].filter(k => /^Object \d+\/content\.xml$/.test(k)).map(k => zip.get(k).toString("utf8"));
  assert.ok(formulas.some(f => f.includes("<math")), "the maths is kept as formulas");
});

test("downloading as rich text gives an .rtf with the text", SLOW, async () => {
  const me = await carbon("dl-rtf");
  const doc = await richDoc(me.api);
  const r = await download(me.api, doc.id, "rtf");
  assert.equal(typeOf(r), "application/rtf");
  assert.equal(dispositionOf(r).ascii, "Report Title.rtf");
  const rtf = r.body.toString("latin1");
  assert.ok(rtf.startsWith("{\\rtf1"), "an .rtf starts with {\\rtf1");
  for (const text of ["Report Title", "Section One", "Nested bullet", "Berlin", "NBO", "The footnote text."]) assert.ok(rtf.includes(text), `the .rtf has ${JSON.stringify(text)}`);
  assert.match(rtf, /HYPERLINK "https:\/\/example\.com\/page"/, "the link");
  assert.match(rtf, /\\footnote/, "the footnote");
});

test("downloading as a web page gives a standalone .html with the doc's structure", async () => {
  const me = await carbon("dl-html");
  const doc = await richDoc(me.api);
  const r = await download(me.api, doc.id, "html");
  assert.equal(typeOf(r), "text/html");
  assert.equal(dispositionOf(r).ascii, "Report Title.html");
  const html = r.body.toString("utf8");
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.match(html, /<title>Report Title<\/title>/);
  assert.match(html, /<h1[^>]*>Report Title<\/h1>/);
  assert.match(html, /<h3[^>]*>Numbered Steps<\/h3>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>(<p>)?Berlin(<\/p>)?<\/td>/);
  assert.match(html, /<math[^>]*>/, "maths as MathML");
  assert.match(html, /<a href="https:\/\/example\.com\/page">link<\/a>/);
  assert.match(html, /<del>struck<\/del>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /class="footnotes?/, "the footnotes section");
  assert.match(html, /<pre[^>]*>[\s\S]*print[\s\S]*hello[\s\S]*<\/pre>/, "the code block");
});

test("downloading as PDF gives a .pdf with the doc's text in it", SLOW, async () => {
  const me = await carbon("dl-pdf");
  const doc = await richDoc(me.api);
  const r = await download(me.api, doc.id, "pdf");
  assert.equal(typeOf(r), "application/pdf");
  assert.equal(dispositionOf(r).ascii, "Report Title.pdf");
  assert.equal(r.body.subarray(0, 5).toString("latin1"), "%PDF-");
  const text = pdfText(r.body);
  if (text === null) return; // no pdftotext here
  for (const words of ["Report Title", "Section One", "Nested bullet", "Step three", "Berlin", "NBO", "The footnote text.", "Closing paragraph."]) {
    assert.ok(text.includes(words), `the PDF's text has ${JSON.stringify(words)}`);
  }
});

test("conversions running at the same time all succeed (downloads and opened files through LibreOffice)", SLOW, async () => {
  const me = await carbon("parallel");
  const doc = await richDoc(me.api, "Parallel");
  const formats = ["odt", "rtf", "pdf", "odt", "pdf", "rtf"];
  const files = ["rich.doc", "rich.doc", "rich.rtf", "embedded-image.odt"];
  const results = await Promise.all([...formats.map(f => me.api.raw("GET", `/v1/docs/${doc.id}/export?format=${f}`)), ...files.map(n => openFile(me.api, n))]);
  const magic = { odt: "PK", rtf: "{\\rtf", pdf: "%PDF-" };
  formats.forEach((format, i) => {
    const r = results[i];
    assert.equal(r.status, 200, `${format} download ${i}: ${show(r)}`);
    assert.equal(r.body.subarray(0, magic[format].length).toString("latin1"), magic[format], `${format} download ${i} is a real ${format}`);
  });
  for (const [i, name] of files.entries()) {
    const r = results[formats.length + i];
    assert.equal(r.status, 201, `opening ${name} (${i}): ${show(r)}`);
    assert.ok((await markdownOf(me.api, r.body.id)).includes(name.startsWith("embedded") ? "Image Doc" : "Report Title"), `${name} opened with its text`);
  }
});

test("download formats are named case-insensitively, and an unknown one is refused", async () => {
  const me = await carbon("dl-fmt");
  const doc = await newDoc(me.api, "# X\n", "Formats");
  const upper = await download(me.api, doc.id, "DOCX");
  assert.equal(typeOf(upper), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(dispositionOf(upper).ascii, "Formats.docx");
  for (const format of ["xml", "pages", "exe"]) {
    const r = await me.api.raw("GET", `/v1/docs/${doc.id}/export?format=${format}`);
    assert.equal(r.status, 422, `format=${format}: ${show(r)}`);
    assert.equal(errorOf(r)?.code, "invalid");
    assert.match(errorOf(r)?.hint ?? "", /md, txt, docx, odt, rtf, html or pdf/);
  }
});

test("download file names come from the title, made safe", async t => {
  const me = await carbon("dl-names");
  const cases = [
    ["Résumé — plan/2026", "R_sum_ - plan-2026.md", "Résumé - plan-2026.md"],
    ['Say "hi" <now>', "Say -hi- -now-.md", "Say -hi- -now-.md"],
    ["...hidden...", "hidden.md", "hidden.md"],
    ["日本語のメモ", "______.md", "日本語のメモ.md"],
  ];
  for (const [title, ascii, utf8] of cases) {
    await t.test(JSON.stringify(title), async () => {
      const doc = await newDoc(me.api, "Body.\n", title);
      const names = dispositionOf(await download(me.api, doc.id, "md"));
      assert.equal(names.kind, "attachment");
      assert.equal(names.ascii, ascii);
      assert.equal(names.utf8, utf8);
    });
  }
  await t.test("a long title is cut to 120 characters", async () => {
    const doc = await newDoc(me.api, "Body.\n", "x".repeat(250));
    assert.equal(dispositionOf(await download(me.api, doc.id, "docx")).ascii, `${"x".repeat(120)}.docx`);
  });
  await t.test("a doc without a title is named by its first line, or Untitled", async () => {
    const named = await newDoc(me.api, "# First line heading\n\nbody\n", "");
    assert.equal(dispositionOf(await download(me.api, named.id, "pdf")).ascii, "First line heading.pdf");
    const empty = await newDoc(me.api, undefined, "");
    assert.equal(dispositionOf(await download(me.api, empty.id, "txt")).ascii, "Untitled.txt");
  });
});

test("Word, OpenDocument, rich text and web page downloads keep text colour, highlight and underline", SLOW, async () => {
  const me = await carbon("dl-colours");
  const doc = await newDoc(me.api, `${STYLED_LINE} And <mark>plain mark</mark>.\n`, "Colours");

  const document = entryText(unzip((await download(me.api, doc.id, "docx")).body), "word/document.xml");
  assert.match(document, /<w:color w:val="FF0000"\/><\/w:rPr><w:t xml:space="preserve">red<\/w:t>/, "Word: the red run");
  assert.match(document, /<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"\/><\/w:rPr><w:t xml:space="preserve">yellow<\/w:t>/, "Word: the yellow highlight");
  assert.match(document, /w:fill="FFF3A3"/, "Word: a highlight without a colour gets the default one");
  assert.match(document, /<w:u w:val="single"\s*\/>/, "Word: underline");

  const content = entryText(unzip((await download(me.api, doc.id, "odt")).body), "content.xml").toLowerCase();
  assert.ok(content.includes('fo:color="#ff0000"'), "OpenDocument: the text colour");
  assert.ok(content.includes('fo:background-color="#ffff00"'), "OpenDocument: the highlight");
  assert.ok(content.includes('style:text-underline-style="solid"'), "OpenDocument: underline");

  const rtf = (await download(me.api, doc.id, "rtf")).body.toString("latin1");
  assert.match(rtf, /\\red255\\green0\\blue0;/, "rich text: red is in the colour table");
  assert.match(rtf, /\\red255\\green255\\blue0;/, "rich text: yellow is in the colour table");
  assert.match(rtf, /\\cf\d+/, "rich text: coloured runs");
  assert.match(rtf, /\\(highlight|chcbpat|cb)\d+/, "rich text: highlighted runs");

  const html = (await download(me.api, doc.id, "html")).body.toString("utf8");
  assert.match(html, /<span style="color: #ff0000">red words<\/span>/, "web page: the text colour");
  assert.match(html, /style="background-color: #ffff00"[^>]*>yellow highlight</, "web page: the highlight");
  assert.match(html, /<u>underlined words<\/u>/, "web page: underline");
});

test("downloads carry the doc's own images, and only link to images from elsewhere", SLOW, async () => {
  const me = await carbon("dl-images");
  const doc = await newDoc(me.api, "# Picture\n", "Picture");
  const up = await me.api.raw("POST", `/v1/docs/${doc.id}/assets`, form(DOT, "dot.png", {}, "image/png"));
  assert.equal(up.status, 201, show(up));
  const put = await me.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: `# Picture\n\n![A red dot](${up.body.url})\n\n![Far away](https://example.com/far-away.png)\n` });
  assert.equal(put.status, 200, show(put));

  const docx = unzip((await download(me.api, doc.id, "docx")).body);
  const media = [...docx.keys()].filter(k => k.startsWith("word/media/"));
  assert.equal(media.length, 1, `Word: one picture inside (${media.join(", ")})`);
  assert.ok(docx.get(media[0]).equals(DOT), "Word: it is the uploaded picture");
  assert.ok(entryText(docx, "word/_rels/document.xml.rels").includes('Target="https://example.com/far-away.png"'), "Word: the far-away image is a link");

  const odt = unzip((await download(me.api, doc.id, "odt")).body);
  assert.ok([...odt.keys()].some(k => k.startsWith("Pictures/") && odt.get(k).equals(DOT)), "OpenDocument: the picture inside");

  const rtf = (await download(me.api, doc.id, "rtf")).body.toString("latin1");
  assert.match(rtf, /\\pict/, "rich text: the picture inside");

  const html = (await download(me.api, doc.id, "html")).body.toString("utf8");
  assert.ok(html.includes(`src="data:image/png;base64,${DOT.toString("base64")}"`), "web page: the picture inside, as data");
  assert.ok(!/<img [^>]*src="https:\/\/example\.com/.test(html), "web page: the far-away image isn't shown from elsewhere");
  assert.ok(html.includes('href="https://example.com/far-away.png"'), "web page: it is a link instead");

  const pdf = (await download(me.api, doc.id, "pdf")).body.toString("latin1");
  assert.match(pdf, /\/Subtype\s*\/Image/, "PDF: the picture inside");
});

test("a doc with a table of contents downloads with one", SLOW, async () => {
  const me = await carbon("dl-toc");
  const doc = await newDoc(me.api, "[[_TOC_]]\n\n# Alpha\n\ntext\n\n## Beta\n\nmore\n", "Contents");
  const document = entryText(unzip((await download(me.api, doc.id, "docx")).body), "word/document.xml");
  assert.match(document, /TOC \\o/, "Word: a table of contents field");
  const html = (await download(me.api, doc.id, "html")).body.toString("utf8");
  assert.match(html, /<nav id="TOC"/, "web page: a table of contents");
  const entry = html.match(/<li><a href="#([^"]+)"[^>]*>Alpha<\/a>/);
  assert.ok(entry, `web page: the contents link to the headings\n${html.match(/<nav id="TOC"[\s\S]*?<\/nav>/)?.[0]}`);
  assert.match(html, new RegExp(`<h1 id="${entry[1]}"[^>]*>Alpha</h1>`), "the heading is the link's target");
});

test("downloads are the doc as it reads now: pending suggestions aren't in them", SLOW, async () => {
  const owner = await carbon("dl-sugg-owner");
  const commenter = await carbon("dl-sugg-commenter");
  const doc = await newDoc(owner.api, "Alpha beta gamma.\n", "Suggested");
  await share(owner, doc.id, commenter, "commenter");
  const s = await commenter.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "beta", new: "SUGGESTED" }], suggest: true });
  assert.equal(s.status, 200, show(s));
  const critic = await markdownOf(owner.api, doc.id, "?suggestions=critic");
  assert.ok(critic.includes("{++SUGGESTED++}"), `the suggestion is pending: ${critic}`);

  const md = await download(owner.api, doc.id, "md");
  assert.equal(md.body.toString("utf8"), "Alpha beta gamma.\n");
  assert.equal(md.body.toString("utf8"), await markdownOf(owner.api, doc.id), "the Markdown download is the doc's Markdown");
  const words = xmlWords(entryText(unzip((await download(owner.api, doc.id, "docx")).body), "word/document.xml"));
  assert.ok(words.includes("Alpha beta gamma.") && !words.includes("SUGGESTED"), "Word: the doc as it reads now");
  const txt = (await download(commenter.api, doc.id, "txt")).body.toString("utf8");
  assert.ok(!txt.includes("SUGGESTED"), "the same for the commenter who suggested it");
});

test("anyone who can open a doc can download it; others can't", async t => {
  const owner = await carbon("dl-perm-owner");
  const viewer = await carbon("dl-perm-viewer");
  const stranger = await carbon("dl-perm-stranger");
  const doc = await newDoc(owner.api, "# Shared\n\nwords\n", "Shared");
  await share(owner, doc.id, viewer, "viewer");

  await t.test("a viewer", async () => {
    assert.ok((await download(viewer.api, doc.id, "md")).body.toString("utf8").includes("words"));
    await download(viewer.api, doc.id, "docx");
  });
  await t.test("a stranger: not found", async () => {
    const r = await stranger.api.raw("GET", `/v1/docs/${doc.id}/export?format=md`);
    assert.equal(r.status, 404, show(r));
  });
  await t.test("without signing in, a private doc: sign in", async () => {
    const r = await anonymous.raw("GET", `/v1/docs/${doc.id}/export?format=md`);
    assert.equal(r.status, 401, show(r));
    assert.equal(errorOf(r)?.code, "unauthorized");
  });
  await t.test("without signing in, a public doc: yes", async () => {
    await makePublic(owner, doc.id, "view");
    const md = await anonymous.raw("GET", `/v1/docs/${doc.id}/export?format=md`);
    assert.equal(md.status, 200, show(md));
    assert.ok(md.body.toString("utf8").includes("words"));
    const docx = await anonymous.raw("GET", `/v1/docs/${doc.id}/export?format=docx`);
    assert.equal(docx.status, 200, show(docx));
  });
  await t.test("a private doc again: the link stops working", async () => {
    await makePublic(owner, doc.id, "none");
    const r = await anonymous.raw("GET", `/v1/docs/${doc.id}/export?format=md`);
    assert.equal(r.status, 401, show(r));
  });
});

// ==========================================================================================
// Older versions
// ==========================================================================================

async function twoVersions(owner) {
  const doc = await newDoc(owner.api, "# One\n\nfirst content\n", "Versioned");
  const first = (await owner.api.get(`/v1/docs/${doc.id}`)).body.seq;
  const put = await owner.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: "# Two\n\nsecond content\n" });
  assert.equal(put.status, 200, show(put));
  return { doc, first, latest: put.body.seq };
}

test("an older version downloads in every format", SLOW, async () => {
  const owner = await carbon("seq-dl");
  const { doc, first } = await twoVersions(owner);
  const md = await download(owner.api, doc.id, "md", `&seq=${first}`);
  assert.equal(md.body.toString("utf8"), "# One\n\nfirst content\n");
  assert.equal(dispositionOf(md).ascii, "Versioned.md");
  const txt = (await download(owner.api, doc.id, "txt", `&seq=${first}`)).body.toString("utf8");
  assert.ok(txt.includes("first content") && !txt.includes("second content"), "plain text of that version");
  const words = xmlWords(entryText(unzip((await download(owner.api, doc.id, "docx", `&seq=${first}`)).body), "word/document.xml"));
  assert.ok(words.includes("first content") && !words.includes("second content"), "Word file of that version");
  const content = xmlWords(entryText(unzip((await download(owner.api, doc.id, "odt", `&seq=${first}`)).body), "content.xml"));
  assert.ok(content.includes("first content") && !content.includes("second content"), "OpenDocument of that version");
  const html = (await download(owner.api, doc.id, "html", `&seq=${first}`)).body.toString("utf8");
  assert.ok(html.includes("first content") && !html.includes("second content"), "web page of that version");
  const pdf = pdfText((await download(owner.api, doc.id, "pdf", `&seq=${first}`)).body);
  if (pdf !== null) assert.ok(pdf.includes("first content") && !pdf.includes("second content"), "PDF of that version");
  const latest = await download(owner.api, doc.id, "md");
  assert.equal(latest.body.toString("utf8"), "# Two\n\nsecond content\n", "without seq: the doc as it is now");
});

test("only editors can download an older version", async t => {
  const owner = await carbon("seq-perm-owner");
  const editor = await carbon("seq-perm-editor");
  const commenter = await carbon("seq-perm-commenter");
  const viewer = await carbon("seq-perm-viewer");
  const { doc, first } = await twoVersions(owner);
  await share(owner, doc.id, editor, "editor");
  await share(owner, doc.id, commenter, "commenter");
  await share(owner, doc.id, viewer, "viewer");
  await makePublic(owner, doc.id, "view");

  await t.test("an editor can", async () => {
    assert.equal((await download(editor.api, doc.id, "md", `&seq=${first}`)).body.toString("utf8"), "# One\n\nfirst content\n");
  });
  for (const [label, api] of [["a commenter", () => commenter.api], ["a viewer", () => viewer.api], ["anyone with the public link", () => anonymous]]) {
    await t.test(`${label} can't, but can download the doc as it is`, async () => {
      const old = await api().raw("GET", `/v1/docs/${doc.id}/export?format=docx&seq=${first}`);
      assert.equal(old.status, 403, show(old));
      assert.equal(errorOf(old)?.code, "forbidden");
      const now = await api().raw("GET", `/v1/docs/${doc.id}/export?format=md`);
      assert.equal(now.status, 200, show(now));
      assert.equal(now.body.toString("utf8"), "# Two\n\nsecond content\n");
    });
  }
});

test("a version that doesn't exist can't be downloaded", async () => {
  const owner = await carbon("seq-range");
  const { doc, latest } = await twoVersions(owner);
  const control = await owner.api.get(`/v1/docs/${doc.id}/versions/${latest + 50}/markdown`);
  assert.equal(control.status, 404, `reading that version as Markdown is refused: ${show(control)}`);
  for (const seq of [latest + 50, -1]) {
    const r = await owner.api.raw("GET", `/v1/docs/${doc.id}/export?format=md&seq=${seq}`);
    assert.equal(r.status, 404, `seq=${seq} (the doc's versions go from 0 to ${latest}): ${show(r)}`);
    assert.equal(errorOf(r)?.code, "not_found");
  }
});

// ==========================================================================================
// Opening a file on top of a doc
// ==========================================================================================

test("opening a file on top of a doc makes its next version; the old text stays in the history", async () => {
  const me = await carbon("on-top");
  const doc = await newDoc(me.api, "# Original Heading\n\nalpha beta gamma\n", "On Top");
  const before = (await me.api.get(`/v1/docs/${doc.id}`)).body.seq;

  const r = await openOnTop(me.api, doc.id, "rich.docx");
  assert.equal(r.status, 200, show(r));
  assert.ok(r.body.seq > before, `a later version (${r.body.seq} > ${before})`);
  const now = await markdownOf(me.api, doc.id);
  assertHeadings(now, "opened on top");
  assert.ok(!now.includes("alpha beta gamma"), "the doc now reads as the file");
  const meta = await me.api.get(`/v1/docs/${doc.id}`);
  assert.equal(meta.body.id, doc.id, "the same doc");
  assert.equal(meta.body.title, "On Top", "its title stays");
  assert.equal(meta.body.seq, r.body.seq);

  const old = await me.api.get(`/v1/docs/${doc.id}/versions/${before}/markdown`);
  assert.equal(old.status, 200, show(old));
  assert.equal(old.body.markdown, "# Original Heading\n\nalpha beta gamma\n", "the old text is still in the history");
  const versions = (await me.api.get(`/v1/docs/${doc.id}/versions`)).body.versions;
  assert.equal(versions[0].seq, r.body.seq);
  assert.equal(versions[0].origin, "import");
  assert.equal(versions[0].summary, `${me.id} opened a file into the doc`);

  // Going back is itself a new version; the opened file stays in the history too.
  const back = await me.api.post(`/v1/docs/${doc.id}/restore-version`, { seq: before });
  assert.equal(back.status, 200, show(back));
  assert.equal(await markdownOf(me.api, doc.id), "# Original Heading\n\nalpha beta gamma\n");
  const imported = await me.api.get(`/v1/docs/${doc.id}/versions/${r.body.seq}/markdown`);
  assert.ok(imported.body.markdown.includes("# Report Title"), "the opened file's version can be brought back again");
});

test("opening a file on top keeps comments: on text still there, and showing the text that went", async t => {
  const me = await carbon("on-top-comments");
  /** A doc with `markdown`, a comment on each quote, then `file` opened on top; the threads after. */
  const scenario = async (markdown, quotes, file) => {
    const doc = await newDoc(me.api, markdown, "Commented");
    const ids = [];
    for (const quote of quotes) {
      const r = await me.api.post(`/v1/docs/${doc.id}/threads`, { anchor: { kind: "text", quote }, body: `About: ${quote}` });
      assert.equal(r.status, 201, show(r));
      ids.push(r.body.id);
    }
    const r = await openOnTop(me.api, doc.id, { bytes: Buffer.from(file), name: "notes.md" });
    assert.equal(r.status, 200, show(r));
    assert.equal(await markdownOf(me.api, doc.id), file);
    const threads = new Map((await me.api.get(`/v1/docs/${doc.id}/threads?status=all`)).body.threads.map(x => [x.id, x]));
    return ids.map(id => threads.get(id));
  };

  await t.test("a comment on text the file keeps stays on it; one on text the file removes stays, showing that text", async () => {
    const [kept, removed] = await scenario(
      "# Notes\n\nKeep this paragraph exactly.\n\nRemove this paragraph.\n",
      ["Keep this paragraph exactly.", "Remove this paragraph."],
      "# Notes\n\nKeep this paragraph exactly.\n",
    );
    assert.equal(kept.orphaned, false, JSON.stringify(kept));
    assert.equal(kept.current_quote, "Keep this paragraph exactly.");
    assert.ok(removed, "the thread on the removed text is kept");
    assert.equal(removed.quote, "Remove this paragraph.");
    assert.equal(removed.comments[0].body, "About: Remove this paragraph.");
    assert.equal(removed.orphaned, true, JSON.stringify(removed));
  });
  await t.test("a comment on text the file replaces with other words doesn't move onto them", async () => {
    const [replaced] = await scenario(
      "# Notes\n\nReplace this sentence entirely.\n",
      ["Replace this sentence entirely."],
      "# Notes\n\nZebra quantum 42 lorem.\n",
    );
    assert.equal(replaced.quote, "Replace this sentence entirely.");
    assert.notEqual(
      replaced.current_quote,
      "Zebra quantum 42 lorem.",
      `the comment now claims to be on words it was never about: ${JSON.stringify({ quote: replaced.quote, current_quote: replaced.current_quote, orphaned: replaced.orphaned })}`,
    );
  });
});

test("people editing live see a file opened on top of the doc", async () => {
  const require = createRequire(new URL("../../web/package.json", import.meta.url));
  const Y = require("yjs");
  const { WebsocketProvider } = require("y-websocket");
  const decoding = require("lib0/decoding");

  const owner = await carbon("on-top-live-owner");
  const editor = await carbon("on-top-live-editor");
  const doc = await newDoc(owner.api, "# Live\n\nbefore the file\n", "Live");
  await share(owner, doc.id, editor, "editor");
  const ticket = await editor.api.post(`/v1/docs/${doc.id}/live`);
  assert.equal(ticket.status, 200, show(ticket));

  const ydoc = new Y.Doc();
  const events = [];
  const provider = new WebsocketProvider(ticket.body.url.slice(0, ticket.body.url.lastIndexOf("/")), doc.id, ydoc, {
    params: { ticket: ticket.body.ticket },
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
  provider.messageHandlers[100] = (_encoder, decoder) => events.push(JSON.parse(new TextDecoder().decode(decoding.readVarUint8Array(decoder))));
  const textOf = node => (node instanceof Y.XmlText ? node.toDelta().map(op => (typeof op.insert === "string" ? op.insert : "")).join("") : node.toArray().map(textOf).join("\n"));
  const frag = ydoc.getXmlFragment("default");
  const until = async (what, check, ms = 10_000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}; the live doc reads: ${JSON.stringify(textOf(frag))}`);
      await sleep(50);
    }
  };
  try {
    await until("the editor to sync", () => provider.synced && textOf(frag).includes("before the file"));
    const r = await openOnTop(owner.api, doc.id, "rich.docx");
    assert.equal(r.status, 200, show(r));
    await until("the opened file to reach the editor", () => textOf(frag).includes("Report Title") && textOf(frag).includes("Closing paragraph."));
    assert.ok(!textOf(frag).includes("before the file"), "the live doc is the new version");
    const heading = frag.toArray()[0];
    assert.equal(heading.nodeName, "heading");
    assert.equal(Number(heading.getAttribute("level")), 1);
  } finally {
    provider.shouldConnect = false;
    provider.destroy();
    ydoc.destroy();
  }
});

test("only editors can open a file on top of a doc", async t => {
  const owner = await carbon("on-top-perm-owner");
  const editor = await carbon("on-top-perm-editor");
  const commenter = await carbon("on-top-perm-commenter");
  const viewer = await carbon("on-top-perm-viewer");
  const stranger = await carbon("on-top-perm-stranger");
  const doc = await newDoc(owner.api, "# Mine\n\noriginal\n", "Guarded");
  await share(owner, doc.id, editor, "editor");
  await share(owner, doc.id, commenter, "commenter");
  await share(owner, doc.id, viewer, "viewer");
  const seqNow = async () => (await owner.api.get(`/v1/docs/${doc.id}`)).body.seq;

  for (const [label, who, status, code] of [
    ["a commenter", commenter, 403, "forbidden"],
    ["a viewer", viewer, 403, "forbidden"],
    ["a stranger", stranger, 404, "not_found"],
  ]) {
    await t.test(`${label}: ${status}`, async () => {
      const before = await seqNow();
      const r = await openOnTop(who.api, doc.id, "rich.md");
      assert.equal(r.status, status, show(r));
      assert.equal(errorOf(r)?.code, code);
      assert.equal(await seqNow(), before, "the doc didn't change");
    });
  }
  await t.test("without signing in: 401", async () => {
    await makePublic(owner, doc.id, "edit");
    const r = await openOnTop(anonymous, doc.id, "rich.md");
    assert.equal(r.status, 401, show(r));
    await makePublic(owner, doc.id, "none");
  });
  await t.test("an editor can", async () => {
    const r = await openOnTop(editor.api, doc.id, "rich.md");
    assert.equal(r.status, 200, show(r));
    assert.equal(await markdownOf(owner.api, doc.id), RICH_MD);
    const versions = (await owner.api.get(`/v1/docs/${doc.id}/versions`)).body.versions;
    assert.equal(versions[0].authors[0].id, editor.id, "the version is the editor's");
  });
});

test("what can't be opened on top of a doc is refused, and the doc stays as it was", async t => {
  const me = await carbon("on-top-refuse");
  const doc = await newDoc(me.api, "# Stays\n\nunchanged\n", "Stays");
  const check = async (file, status, code) => {
    const before = (await me.api.get(`/v1/docs/${doc.id}`)).body.seq;
    const r = await openOnTop(me.api, doc.id, file);
    assert.equal(r.status, status, show(r));
    assert.equal(errorOf(r)?.code, code);
    assert.equal((await me.api.get(`/v1/docs/${doc.id}`)).body.seq, before, "no new version");
    assert.equal(await markdownOf(me.api, doc.id), "# Stays\n\nunchanged\n");
    return r;
  };
  await t.test("a PDF (it opens as a new doc instead)", async () => {
    const r = await check("rich.pdf", 422, "invalid");
    assert.match(errorOf(r).hint ?? "", /new doc/i);
  });
  await t.test("an unsupported file", () => check({ bytes: Buffer.from("a,b\n1,2\n"), name: "data.csv" }, 415, "unsupported_format"));
  await t.test("a broken Word file", () => check({ bytes: Buffer.from("not a zip at all"), name: "broken.docx" }, 422, "unsupported_format"));
  await t.test("anything on top of a PDF doc (turn it into a doc first)", async () => {
    const pdf = await opened(me.api, "rich.pdf");
    const r = await openOnTop(me.api, pdf.id, "rich.md");
    assert.equal(r.status, 409, show(r));
    assert.equal(errorOf(r)?.code, "conflict");
    assert.equal((await me.api.get(`/v1/docs/${pdf.id}`)).body.kind, "pdf");
  });
});

// ==========================================================================================
// PDFs
// ==========================================================================================

test("a PDF opens as it is, and its original file is served", async () => {
  const me = await carbon("pdf-open");
  const doc = await opened(me.api, "rich.pdf");
  assert.equal(doc.kind, "pdf", "a PDF is shown as it is");
  assert.equal(doc.title, "rich");
  assert.equal((await me.api.get(`/v1/docs/${doc.id}`)).body.kind, "pdf");
  const original = await me.api.raw("GET", `/v1/docs/${doc.id}/original`);
  assert.equal(original.status, 200, show(original));
  assert.equal(typeOf(original), "application/pdf");
  assert.ok(Buffer.from(original.body).equals(fx("rich.pdf")), "the original, byte for byte");
  const names = dispositionOf(original);
  assert.equal(names.kind, "inline", "shown in the browser, not saved");
  assert.equal(names.ascii, "rich.pdf");
  const upper = await opened(me.api, { bytes: fx("rich.pdf"), name: "SCAN.PDF" });
  assert.equal(upper.kind, "pdf");
});

test("a PDF's original keeps a file name that isn't plain ASCII", async () => {
  const me = await carbon("pdf-name");
  const doc = await opened(me.api, { bytes: fx("rich.pdf"), name: "Überblick 2026.pdf" });
  assert.equal(doc.title, "Überblick 2026");
  const original = await me.api.raw("GET", `/v1/docs/${doc.id}/original`);
  assert.equal(original.status, 200);
  const names = dispositionOf(original);
  assert.ok(names.ascii || names.utf8, `the response still names the file: content-disposition=${JSON.stringify(names.value)}`);
  assert.equal(names.utf8 ?? names.ascii, "Überblick 2026.pdf");
});

test("a PDF doc downloads as the original PDF, and as its text in every other format", SLOW, async () => {
  const me = await carbon("pdf-dl");
  const doc = await opened(me.api, "rich.pdf");
  for (const format of ["pdf", "PDF"]) {
    const r = await download(me.api, doc.id, format);
    assert.equal(typeOf(r), "application/pdf");
    assert.ok(Buffer.from(r.body).equals(fx("rich.pdf")), `format=${format}: the original PDF, byte for byte (got ${r.body.length} bytes, the original is ${fx("rich.pdf").length})`);
    assert.equal(dispositionOf(r).kind, "attachment");
  }
  const md = (await download(me.api, doc.id, "md")).body.toString("utf8");
  for (const words of ["Report Title", "First bullet", "Berlin", "The footnote text."]) assert.ok(md.includes(words), `Markdown download has ${JSON.stringify(words)}: ${JSON.stringify(md.slice(0, 200))}`);
  const words = xmlWords(entryText(unzip((await download(me.api, doc.id, "docx")).body), "word/document.xml"));
  assert.ok(words.includes("Report Title") && words.includes("Berlin"), "Word download has the PDF's text");
  const txt = (await download(me.api, doc.id, "txt")).body.toString("utf8");
  assert.ok(txt.includes("Section One"), "plain text download has the PDF's text");
});

test("a PDF doc can be read as Markdown, like every doc", async () => {
  const me = await carbon("pdf-md");
  const doc = await opened(me.api, "rich.pdf");
  const md = await markdownOf(me.api, doc.id);
  assert.ok(md.includes("Report Title") && md.includes("Berlin"), `"Every doc can always be read as Markdown": got ${JSON.stringify(md.slice(0, 200))}`);
});

test("a PDF shown as it is can't be written to as Markdown until it is turned into a doc", async () => {
  const me = await carbon("pdf-write");
  const doc = await opened(me.api, "rich.pdf");
  const put = await me.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: "# Hidden\n\ntext nobody sees\n" });
  assert.equal(put.status, 409, `writing a PDF doc's Markdown is refused like opening a file on top of it: ${show(put)}`);
  assert.equal(errorOf(put)?.code, "conflict");
  const meta = await me.api.get(`/v1/docs/${doc.id}`);
  assert.equal(meta.body.kind, "pdf");
  assert.equal(meta.body.seq, doc.seq, "no hidden version was written");
});

test("turning a PDF into a doc gives a doc with its text, and the original stays", async () => {
  const me = await carbon("pdf-convert");
  const doc = await opened(me.api, "rich.pdf");
  const r = await me.api.post(`/v1/docs/${doc.id}/convert`);
  assert.equal(r.status, 200, show(r));
  assert.equal(r.body.id, doc.id, "the same doc");
  assert.equal(r.body.kind, "doc", "it is a normal doc now");
  const md = await markdownOf(me.api, doc.id);
  for (const words of ["Report Title", "Section One", "First bullet", "Step one", "Berlin", "NBO", 'print("hello")', "The footnote text.", "Closing paragraph."]) {
    assert.ok(md.includes(words), `the doc has the PDF's ${JSON.stringify(words)}`);
  }
  const original = await me.api.raw("GET", `/v1/docs/${doc.id}/original`);
  assert.equal(original.status, 200, show(original));
  assert.ok(Buffer.from(original.body).equals(fx("rich.pdf")), "the PDF stays as its original");
  const edit = await me.api.post(`/v1/docs/${doc.id}/edits`, { edits: [{ old: "Closing paragraph.", new: "Closing paragraph, edited." }] });
  assert.equal(edit.status, 200, `it can be edited now: ${show(edit)}`);
  const versions = (await me.api.get(`/v1/docs/${doc.id}/versions`)).body.versions;
  assert.ok(versions.some(v => v.origin === "import"), "the conversion is in the history");
  const again = await me.api.post(`/v1/docs/${doc.id}/convert`);
  assert.equal(again.status, 409, show(again));
  assert.equal(errorOf(again)?.code, "conflict");
});

test("who can see a PDF's original and turn it into a doc", async t => {
  const owner = await carbon("pdf-perm-owner");
  const editor = await carbon("pdf-perm-editor");
  const commenter = await carbon("pdf-perm-commenter");
  const stranger = await carbon("pdf-perm-stranger");
  const doc = await opened(owner.api, "rich.pdf");
  await share(owner, doc.id, editor, "editor");
  await share(owner, doc.id, commenter, "commenter");

  await t.test("a commenter sees the original but can't convert it", async () => {
    assert.equal((await commenter.api.raw("GET", `/v1/docs/${doc.id}/original`)).status, 200);
    const r = await commenter.api.post(`/v1/docs/${doc.id}/convert`);
    assert.equal(r.status, 403, show(r));
    assert.equal(errorOf(r)?.code, "forbidden");
  });
  await t.test("a stranger: not found", async () => {
    assert.equal((await stranger.api.raw("GET", `/v1/docs/${doc.id}/original`)).status, 404);
    assert.equal((await stranger.api.post(`/v1/docs/${doc.id}/convert`)).status, 404);
  });
  await t.test("without signing in: a private PDF asks to sign in, a public one is shown", async () => {
    assert.equal((await anonymous.raw("GET", `/v1/docs/${doc.id}/original`)).status, 401);
    await makePublic(owner, doc.id, "view");
    const r = await anonymous.raw("GET", `/v1/docs/${doc.id}/original`);
    assert.equal(r.status, 200, show(r));
    assert.ok(Buffer.from(r.body).equals(fx("rich.pdf")));
    assert.equal((await anonymous.post(`/v1/docs/${doc.id}/convert`)).status, 401);
  });
  await t.test("an editor can convert it", async () => {
    const r = await editor.api.post(`/v1/docs/${doc.id}/convert`);
    assert.equal(r.status, 200, show(r));
    assert.equal(r.body.kind, "doc");
  });
  await t.test("a normal doc has no original", async () => {
    const plain = await newDoc(owner.api, "# Plain\n");
    const r = await owner.api.raw("GET", `/v1/docs/${plain.id}/original`);
    assert.equal(r.status, 404, show(r));
    assert.equal(errorOf(r)?.code, "not_found");
    const c = await owner.api.post(`/v1/docs/${plain.id}/convert`);
    assert.equal(c.status, 409, show(c));
  });
});

// ==========================================================================================
// What isn't opened
// ==========================================================================================

test("unsupported files are refused with a clear error, and nothing is made", async () => {
  const me = await carbon("refuse");
  for (const [bytes, name] of [
    [Buffer.from("a,b\n1,2\n"), "data.csv"],
    [Buffer.from([0, 1, 2, 3]), "thing.xyz"],
    [Buffer.from("# no extension\n"), "README"],
    [fx("dot.png"), "dot.png"],
    [Buffer.from("PK\u0003\u0004"), "deck.pptx"],
  ]) {
    const r = await openFile(me.api, { bytes, name });
    assert.equal(r.status, 415, `${name}: ${show(r)}`);
    const error = errorOf(r);
    assert.equal(error?.code, "unsupported_format");
    assert.ok(error.message.includes(name), `the message names the file: ${error.message}`);
    assert.equal(error.hint, "Open .md, .txt, .docx, .doc, .odt, .rtf, .html or .pdf files.");
  }
  assert.deepEqual(await docsOf(me.api), [], "no doc was made");
});

test("a file that isn't what its name says is refused, and nothing is made", async t => {
  const me = await carbon("refuse-fake");
  const random = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) % 256));
  for (const [bytes, name] of [
    [Buffer.from("this is not a pdf"), "fake.pdf"],
    [Buffer.from("not a zip at all"), "broken.docx"],
    [Buffer.from("not a zip either"), "broken.odt"],
    [random, "random.docx"],
    [random, "random.doc"],
    [random, "random.rtf"],
    [Buffer.from("plain words, no rich text header"), "plain.rtf"],
  ]) {
    await t.test(name, async () => {
      const r = await openFile(me.api, { bytes, name });
      assert.equal(r.status, 422, `${name} should be refused: ${show(r)}`);
      assert.equal(errorOf(r)?.code, "unsupported_format");
    });
  }
  assert.deepEqual((await docsOf(me.api)).map(d => d.title), [], "no doc was made");
});

test("an upload must be a multipart form with the file in `file`, answered in the API's error shape", async t => {
  const me = await carbon("refuse-form");
  await t.test("no file field", async () => {
    const body = new FormData();
    body.set("title", "No file");
    const r = await me.api.raw("POST", "/v1/docs/import", body);
    assert.equal(r.status, 422, show(r));
    assert.equal(errorOf(r)?.code, "invalid");
    assert.match(errorOf(r).message, /field named `file`/);
  });
  await t.test("a JSON body instead of a form", async () => {
    const r = await me.api.post("/v1/docs/import", { file: "rich.md" });
    assert.ok(r.status >= 400 && r.status < 500, show(r));
    assert.ok(errorOf(r)?.code, `errors are JSON {"error": {...}} (docs/api.md): ${show(r)}`);
  });
  await t.test("opening a file needs signing in", async () => {
    const r = await anonymous.post("/v1/docs/import");
    assert.equal(r.status, 401, show(r));
    assert.equal(errorOf(r)?.code, "unauthorized");
  });
});

test("files over 50 MB are refused as too large, however large", SLOW, async t => {
  const me = await carbon("refuse-big");
  const doc = await newDoc(me.api, "# Big\n");
  for (const mb of [51, 70]) {
    await t.test(`${mb} MB file to open`, async () => {
      const r = await openFile(me.api, { bytes: Buffer.alloc(mb * 1024 * 1024, 0x61), name: "big.txt" });
      assert.equal(r.status, 413, show(r));
      assert.equal(errorOf(r)?.code, "too_large");
    });
    await t.test(`${mb} MB image`, async () => {
      const side = Math.ceil(Math.sqrt((mb * 1024 * 1024) / 3));
      const r = await me.api.raw("POST", `/v1/docs/${doc.id}/assets`, form(noisePng(side, side), "huge.png", {}, "image/png"));
      assert.equal(r.status, 413, show(r));
      assert.equal(errorOf(r)?.code, "too_large");
    });
  }
  assert.deepEqual((await docsOf(me.api)).map(d => d.id), [doc.id], "no doc was made from the big files");
});

// ==========================================================================================
// Image uploads
// ==========================================================================================

test("image uploads take PNG, JPEG, GIF, WebP and SVG, and serve them so they can't run as pages", async t => {
  const me = await carbon("asset-ok");
  const doc = await newDoc(me.api, "# Images\n");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#dc2828"/></svg>');
  for (const [bytes, name, type] of [
    [DOT, "dot.png", "image/png"],
    [fx("dot.jpg"), "dot.jpg", "image/jpeg"],
    [fx("dot.gif"), "dot.gif", "image/gif"],
    [fx("dot.webp"), "dot.webp", "image/webp"],
    [svg, "dot.svg", "image/svg+xml"],
    [Buffer.concat([Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n'), svg]), "declared.svg", "image/svg+xml"],
  ]) {
    await t.test(name, async () => {
      const r = await me.api.raw("POST", `/v1/docs/${doc.id}/assets`, form(bytes, name, {}, type));
      assert.equal(r.status, 201, show(r));
      assert.match(r.body.id, /^a_[A-Za-z0-9]+$/);
      assert.equal(r.body.url, `${WEB}/assets/${r.body.id}`, "docs point at images on the web editor's origin");
      const served = await me.api.raw("GET", `/v1/assets/${r.body.id}`);
      assert.equal(served.status, 200);
      assert.equal(typeOf(served), type);
      assert.ok(Buffer.from(served.body).equals(bytes), "the same bytes");
      assert.match(served.headers.get("content-security-policy") ?? "", /sandbox/);
      assert.equal(served.headers.get("x-content-type-options"), "nosniff");
      const web = await fromWeb(r.body.url, me);
      assert.equal(web.status, 200, `the web origin serves ${r.body.url}`);
      assert.equal((web.headers.get("content-type") ?? "").split(";")[0], type);
      assert.equal(web.headers.get("x-content-type-options"), "nosniff");
      assert.ok(Buffer.from(await web.arrayBuffer()).equals(bytes));
    });
  }
});

test("the web origin docs point at serves uploaded images with the service's sandbox, not the site's page policy", async () => {
  const me = await carbon("asset-csp");
  const doc = await newDoc(me.api, "# Images\n");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#dc2828"/></svg>');
  for (const [bytes, name, type] of [[DOT, "dot.png", "image/png"], [svg, "dot.svg", "image/svg+xml"]]) {
    const r = await me.api.raw("POST", `/v1/docs/${doc.id}/assets`, form(bytes, name, {}, type));
    assert.equal(r.status, 201, show(r));
    const service = (await me.api.raw("GET", `/v1/assets/${r.body.id}`)).headers.get("content-security-policy");
    assert.equal(service, "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    const web = await fromWeb(r.body.url, me);
    assert.equal(web.status, 200);
    assert.equal(web.headers.get("content-security-policy"), service, `${name} at ${r.body.url} keeps the service's policy`);
  }
});

test("image uploads refuse files that aren't images", async t => {
  const me = await carbon("asset-refuse");
  const doc = await newDoc(me.api, "# Images\n");
  for (const [bytes, name, type] of [
    [Buffer.from("hello"), "note.txt", "text/plain"],
    [fx("rich.pdf"), "rich.pdf", "application/pdf"],
    [fx("rich.docx"), "rich.docx", "application/octet-stream"],
    [Buffer.from("<html><body>page</body></html>"), "page.html", "text/html"],
    [Buffer.from("this is plainly not an image"), "fake.png", "image/png"],
    [Buffer.from("GIF but not really"), "fake.gif", "image/gif"],
  ]) {
    await t.test(name, async () => {
      const r = await me.api.raw("POST", `/v1/docs/${doc.id}/assets`, form(bytes, name, {}, type));
      assert.equal(r.status, 415, `${name} should be refused: ${show(r)}`);
      assert.equal(errorOf(r)?.code, "unsupported_format");
      assert.equal(errorOf(r)?.hint, "Use PNG, JPEG, GIF, WebP or SVG.");
    });
  }
});

test("an uploaded image is what its bytes are, whatever the file is called", async () => {
  const me = await carbon("asset-bytes");
  const doc = await newDoc(me.api, "# Images\n");
  for (const name of ["photo.jpg", "pasted image", "image.bin"]) {
    const r = await me.api.raw("POST", `/v1/docs/${doc.id}/assets`, form(DOT, name, {}, "application/octet-stream"));
    assert.equal(r.status, 201, `a PNG called ${JSON.stringify(name)}: ${show(r)}`);
    assert.equal(typeOf(await me.api.raw("GET", `/v1/assets/${r.body.id}`)), "image/png", `${name} is served as the PNG it is`);
  }
});

test("who can add images to a doc", async t => {
  const owner = await carbon("asset-perm-owner");
  const editor = await carbon("asset-perm-editor");
  const viewer = await carbon("asset-perm-viewer");
  const stranger = await carbon("asset-perm-stranger");
  const doc = await newDoc(owner.api, "# Images\n");
  await share(owner, doc.id, editor, "editor");
  await share(owner, doc.id, viewer, "viewer");
  const upload = api => api.raw("POST", `/v1/docs/${doc.id}/assets`, form(DOT, "dot.png", {}, "image/png"));
  await t.test("the owner and an editor can", async () => {
    assert.equal((await upload(owner.api)).status, 201);
    assert.equal((await upload(editor.api)).status, 201);
  });
  await t.test("a viewer can't", async () => {
    const r = await upload(viewer.api);
    assert.equal(r.status, 403, show(r));
    assert.equal(errorOf(r)?.code, "forbidden");
  });
  await t.test("a stranger: not found", async () => {
    assert.equal((await upload(stranger.api)).status, 404);
  });
  await t.test("without signing in, even on a doc anyone can edit", async () => {
    await makePublic(owner, doc.id, "edit");
    assert.equal((await upload(anonymous)).status, 401);
  });
});

test("an image that doesn't exist is not found, on the service and on the web origin", async () => {
  const r = await anonymous.raw("GET", "/v1/assets/a_doesnotexist0000000");
  assert.equal(r.status, 404, show(r));
  assert.equal(errorOf(r)?.code, "not_found");
  assert.equal((await fetch(`${WEB}/assets/a_doesnotexist0000000`)).status, 404);
  assert.equal((await fetch(`${WEB}/assets/not-an-asset-id`)).status, 404);
});

test("an image is shown to whoever can open its doc, on the service and on the web origin", async t => {
  const owner = await carbon("asset-access-owner");
  const stranger = await carbon("asset-access-stranger");
  const doc = await newDoc(owner.api, "# Picture\n");
  const up = await owner.api.raw("POST", `/v1/docs/${doc.id}/assets`, form(DOT, "dot.png", {}, "image/png"));
  assert.equal(up.status, 201, show(up));
  const put = await owner.api.put(`/v1/docs/${doc.id}/markdown`, { markdown: `# Picture\n\n![A red dot](${up.body.url})\n` });
  assert.equal(put.status, 200, show(put));
  const status = async who => [(await (who ? who.api : anonymous).raw("GET", `/v1/assets/${up.body.id}`)).status, (await fromWeb(up.body.url, who)).status];

  await t.test("the owner sees it", async () => assert.deepEqual(await status(owner), [200, 200]));
  await t.test("someone the doc isn't shared with doesn't", async () => assert.deepEqual(await status(stranger), [404, 404]));
  await t.test("nor does anyone without signing in", async () => assert.deepEqual(await status(null), [404, 404]));
  await t.test("once the doc is public, anyone with its link does", async () => {
    await makePublic(owner, doc.id, "view");
    assert.deepEqual(await status(null), [200, 200]);
    assert.deepEqual(await status(stranger), [200, 200]);
  });
  await t.test("and once it is private again, they don't", async () => {
    await makePublic(owner, doc.id, "none");
    assert.deepEqual(await status(null), [404, 404]);
  });
});

test("deleting a doc permanently deletes its images and its PDF original", async () => {
  const me = await carbon("asset-purge");
  const doc = await opened(me.api, "embedded-image.docx");
  const [image] = uploadedImages(await markdownOf(me.api, doc.id));
  await assertServedImage(me, image, DOT);
  const pdf = await opened(me.api, "rich.pdf");
  assert.equal((await me.api.raw("GET", `/v1/docs/${pdf.id}/original`)).status, 200);

  for (const id of [doc.id, pdf.id]) {
    assert.equal((await me.api.del(`/v1/docs/${id}`)).status, 204);
  }
  assert.equal((await me.api.raw("GET", `/v1/assets/${image.id}`)).status, 200, "in the trash, a doc keeps its images");
  for (const id of [doc.id, pdf.id]) {
    const purge = await me.api.del(`/v1/docs/${id}/permanently?confirm=${id}`);
    assert.equal(purge.status, 204, show(purge));
  }
  assert.equal((await me.api.raw("GET", `/v1/assets/${image.id}`)).status, 404, "the image is gone");
  assert.equal((await fromWeb(image.url, me)).status, 404, "on the web origin too");
  assert.equal((await me.api.raw("GET", `/v1/docs/${pdf.id}/original`)).status, 404, "the PDF is gone");
});

test("a copy keeps its pictures when the doc it was copied from is deleted permanently", async () => {
  const me = await carbon("asset-copy");
  const doc = await opened(me.api, "embedded-image.docx");
  const copy = await me.api.post(`/v1/docs/${doc.id}/copy`, { title: "Kept copy" });
  assert.equal(copy.status, 201, show(copy));
  const [image] = uploadedImages(await markdownOf(me.api, copy.body.id));
  assert.ok(image, "the copy has the picture");

  assert.equal((await me.api.del(`/v1/docs/${doc.id}`)).status, 204);
  assert.equal((await me.api.del(`/v1/docs/${doc.id}/permanently?confirm=${doc.id}`)).status, 204);
  // Only the deleted doc is gone: the copy is another doc and must still show its picture.
  const [still] = uploadedImages(await markdownOf(me.api, copy.body.id));
  const served = await fromWeb(still.url, me);
  assert.equal(served.status, 200, `the copy's picture ${still.url} still loads`);
  const docx = unzip((await download(me.api, copy.body.id, "docx")).body);
  assert.ok([...docx.keys()].some(k => k.startsWith("word/media/")), "and the copy still downloads with it");
});

// ==========================================================================================
// Silicons
// ==========================================================================================

test("a Silicon opens files, opens them on top, and downloads, like a Carbon", { timeout: 15 * 60_000 }, async () => {
  const custodian = await signUpCarbon("fmt-custodian");
  const si = await silicon(custodian, "formats");
  const doc = await opened(si.api, "rich.docx");
  assert.equal(doc.kind, "doc");
  assert.equal(doc.owner.id, si.id, "the Silicon owns the doc it opened");
  assert.equal(doc.created_by.id, si.id);
  assertHeadings(await markdownOf(si.api, doc.id), "a Silicon's .docx");

  const onTop = await openOnTop(si.api, doc.id, { bytes: Buffer.from("# Rewritten\n\nBy a Silicon.\n"), name: "rewrite.md" });
  assert.equal(onTop.status, 200, show(onTop));
  const versions = (await si.api.get(`/v1/docs/${doc.id}/versions`)).body.versions;
  assert.equal(versions[0].summary, `${si.id} opened a file into the doc`);
  assert.equal(versions[0].authors[0].kind, "silicon");

  const words = xmlWords(entryText(unzip((await download(si.api, doc.id, "docx")).body), "word/document.xml"));
  assert.ok(words.includes("Rewritten") && words.includes("By a Silicon."));
  const pdf = await opened(si.api, "rich.pdf");
  assert.equal(pdf.kind, "pdf");
  assert.equal((await si.api.post(`/v1/docs/${pdf.id}/convert`)).body.kind, "doc");
});

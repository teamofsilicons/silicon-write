import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyImportError, createImportBatch, planImport, runImportBatch, type ImportSource, type ImportTransport } from "../lib/write/import-files";
import type { Doc } from "../lib/write/types";

const file = (path: string, size = 10): ImportSource => ({ name: path.split("/").at(-1)!, webkitRelativePath: path.includes("/") ? path : "", size });
const doc = (id: string) => ({ id, title: id }) as Doc;
const rejection = (message = "This file is not valid.") => ({ status: 422, code: "unsupported_format", message });

function recorder(overrides: Partial<ImportTransport<ImportSource>> = {}) {
  const calls: string[] = [];
  let count = 0;
  const transport: ImportTransport<ImportSource> = {
    createFolder: async (name, parentId) => { const id = `f${++count}`; calls.push(`folder ${name} in ${parentId} = ${id}`); return { id }; },
    importFile: async (source, folderId) => { calls.push(`file ${source.webkitRelativePath || source.name} in ${folderId}`); return doc(source.webkitRelativePath || source.name); },
    describeError: classifyImportError,
    ...overrides,
  };
  return { calls, transport };
}

test("folder plans preserve the root and nested paths while excluding hidden, unsupported and duplicate selections", () => {
  const plan = planImport([
    file("Notes/Sub/Welcome.md"), file("Notes/Welcome.md"), file("Notes/draft.MARKDOWN"),
    file("Notes/.secret/private.md"), file("Notes/.hidden.md"), file("Notes/__MACOSX/copy.md"),
    file("Notes/node_modules/Readme.md"), file("Notes/~$draft.docx"), file("Notes/picture.png"), file("Notes/Welcome.md"),
  ]);
  assert.deepEqual(plan.files.map(entry => [entry.path, entry.folders]), [
    ["Notes/Sub/Welcome.md", ["Notes", "Sub"]], ["Notes/Welcome.md", ["Notes"]], ["Notes/draft.MARKDOWN", ["Notes"]],
  ]);
  assert.equal(plan.skipped.length, 7);
  assert.match(plan.skipped.at(-1)!.reason, /already selected/);
});

test("invalid paths and oversized files are skipped before any folder or upload is attempted", async () => {
  const plan = planImport([file("../escape.md"), file("/absolute.md"), file("Notes//empty.md"), file("Notes/./same.md"), file("Notes\\bad.md"), file("Notes/big.pdf", 50 * 1024 * 1024 + 1), file("Only pictures/image.png")]);
  assert.equal(plan.files.length, 0);
  assert.equal(plan.skipped.length, 7);
  const { calls, transport } = recorder();
  await runImportBatch(createImportBatch(plan, null), transport);
  assert.deepEqual(calls, []);
});

test("a folder is created only once, parents before children, under the current library folder", async () => {
  const batch = createImportBatch(planImport([file("Notes/B/a.md"), file("Notes/A/b.md"), file("Notes/A/a.md"), file("Notes/unsupported/picture.png")]), "existing");
  const { calls, transport } = recorder();
  await runImportBatch(batch, transport);
  assert.deepEqual(calls, [
    "folder Notes in existing = f1", "folder A in f1 = f2", "file Notes/A/a.md in f2", "file Notes/A/b.md in f2",
    "folder B in f1 = f3", "file Notes/B/a.md in f3",
  ]);
  assert.equal(batch.entries.filter(entry => entry.state === "done").length, 3);
  assert.equal(batch.skipped.length, 1);
});

test("retry imports only rejected files and reuses every confirmed folder and doc", async () => {
  const batch = createImportBatch(planImport([file("Notes/a.md"), file("Notes/b.md")]), null);
  let first = true;
  const uploaded: string[] = [];
  const { calls, transport } = recorder({ importFile: async source => {
    uploaded.push(source.name);
    if (source.name === "b.md" && first) throw rejection();
    return doc(source.name);
  } });
  await runImportBatch(batch, transport);
  assert.deepEqual(batch.entries.map(entry => entry.state), ["done", "failed"]);
  first = false;
  await runImportBatch(batch, transport);
  assert.deepEqual(uploaded, ["a.md", "b.md", "b.md"]);
  assert.deepEqual(calls, ["folder Notes in null = f1"]);
  assert.deepEqual(batch.entries.map(entry => entry.doc?.id), ["a.md", "b.md"]);
});

test("ambiguous upload outcomes are never replayed, including timeouts and invalid success responses", async () => {
  const batch = createImportBatch(planImport([file("a.md"), file("b.md"), file("c.md"), file("d.md")]), null);
  const uploaded: string[] = [];
  const { transport } = recorder({ importFile: async source => {
    uploaded.push(source.name);
    if (source.name === "a.md") throw { status: 0, message: "Lost connection" };
    if (source.name === "b.md") throw { status: 500, message: "Could not finish" };
    if (source.name === "c.md") throw { status: 408, message: "Timed out" };
    return null as unknown as Doc;
  } });
  await runImportBatch(batch, transport);
  await runImportBatch(batch, transport);
  assert.deepEqual(uploaded, ["a.md", "b.md", "c.md", "d.md"]);
  assert.ok(batch.entries.every(entry => entry.state === "uncertain"));
});

test("only known rejections from before creation can be retried", () => {
  for (const error of [
    { status: 401, code: "unauthorized" }, { status: 403, code: "forbidden" },
    { status: 413, code: "too_large" }, { status: 415, code: "unsupported_media_type" }, rejection(),
  ]) assert.equal(classifyImportError(error).retryable, true);
  for (const error of [
    { status: 422, code: "invalid" }, { status: 409, code: "conflict" }, { status: 404, code: "not_found" },
    { status: 403 }, { status: 500, code: "unsupported_format" }, { status: 0 },
  ]) assert.equal(classifyImportError(error).retryable, false);
});

test("a rejected shared parent is attempted once per retry, while sibling folders continue", async () => {
  const batch = createImportBatch(planImport([file("Notes/Fail/a.md"), file("Notes/Fail/b.md"), file("Notes/Good/c.md")]), null);
  const created: string[] = [];
  let first = true;
  const { calls, transport } = recorder({ createFolder: async name => {
    created.push(name);
    if (name === "Fail" && first) throw rejection("This folder could not be made.");
    return { id: name };
  } });
  await runImportBatch(batch, transport);
  assert.deepEqual(created, ["Notes", "Fail", "Good"]);
  assert.deepEqual(batch.entries.map(entry => entry.state), ["failed", "failed", "done"]);
  first = false;
  await runImportBatch(batch, transport);
  assert.deepEqual(created, ["Notes", "Fail", "Good", "Fail"]);
  assert.deepEqual(calls, ["file Notes/Good/c.md in Good", "file Notes/Fail/a.md in Fail", "file Notes/Fail/b.md in Fail"]);
});

test("an unconfirmed parent cannot create duplicate folders through children or retries", async () => {
  const batch = createImportBatch(planImport([file("Notes/a.md"), file("Notes/Sub/b.md")]), null);
  let folders = 0;
  const { calls, transport } = recorder({ createFolder: async () => { folders += 1; throw new Error("Connection closed"); } });
  await runImportBatch(batch, transport);
  await runImportBatch(batch, transport);
  assert.equal(folders, 1);
  assert.deepEqual(calls, []);
  assert.ok(batch.entries.every(entry => entry.state === "uncertain"));
});

test("stopping finishes the current file, retains the queue, and resumes without repeating successes", async () => {
  const batch = createImportBatch(planImport([file("a.md"), file("b.md"), file("c.md")]), null);
  let stop = false;
  const uploaded: string[] = [];
  const { transport } = recorder({ importFile: async source => { uploaded.push(source.name); stop = true; return doc(source.name); } });
  await runImportBatch(batch, transport, { shouldStop: () => stop });
  assert.deepEqual(batch.entries.map(entry => entry.state), ["done", "pending", "pending"]);
  assert.equal(batch.running, false);
  await runImportBatch(batch, transport);
  assert.deepEqual(uploaded, ["a.md", "b.md", "c.md"]);
});

test("the same batch cannot be started twice while a write is in flight", async () => {
  const batch = createImportBatch(planImport([file("a.md"), file("b.md")]), null);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let uploads = 0;
  const { transport } = recorder({ importFile: async source => { uploads += 1; await gate; return doc(source.name); } });
  const first = runImportBatch(batch, transport);
  await runImportBatch(batch, transport);
  assert.equal(batch.running, true);
  release();
  await first;
  assert.equal(uploads, 2);
  assert.equal(batch.running, false);
});

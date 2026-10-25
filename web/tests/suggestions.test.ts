import assert from "node:assert/strict";
import { test } from "node:test";
import { getSchema, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { SuggestionDelete, SuggestionInsert, SuggestionNodes, suggestionPlugin, suggestionsIn, suggestionDecorations, proposedSlice } from "../components/editor/suggestions";

const Picture = Node.create({ name: "inlineImage", inline: true, group: "inline", atom: true, addAttributes: () => ({ src: { default: "picture.png" } }) });
const schema = getSchema([StarterKit, TableKit, Picture, SuggestionDelete, SuggestionInsert, SuggestionNodes]);
const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : []);
const state = (nodes: PMNode[]) => EditorState.create({ doc: schema.nodes.doc.create(null, nodes), plugins: [suggestionPlugin({ author: "author", isOn: () => true, onRefused: () => assert.fail("structural suggestions are supported") })] });
const pending = (doc: PMNode) => suggestionsIn(doc);

test("code edits and formatting keep the original block and propose its replacement", () => {
  for (const block of [schema.nodes.codeBlock.create({ language: "js" }, schema.text("const a = 1;")), p("Plain words")]) {
    const before = state([block]);
    const change = block.type.name === "codeBlock" ? before.tr.insertText("x", 7, 8) : before.tr.addMark(1, 6, schema.marks.bold.create());
    const after = before.applyTransaction(change).state;
    assert.equal(after.doc.childCount, 2);
    assert.deepEqual(after.doc.child(0).content.toJSON(), block.content.toJSON());
    assert.equal(after.doc.child(0).attrs.suggestion.kind, "delete");
    assert.equal(after.doc.child(1).attrs.suggestion.kind, "insert");
    assert.equal(pending(after.doc).length, 1);
  }
});

test("splitting a paragraph creates a reviewable structural suggestion", () => {
  const before = state([p("One two")]);
  const after = before.applyTransaction(before.tr.split(4)).state;
  assert.equal(after.doc.childCount, 3);
  assert.equal(after.doc.child(0).textContent, "One two");
  assert.equal(after.doc.child(0).attrs.suggestion.kind, "delete");
  assert.equal(after.doc.child(1).attrs.suggestion.kind, "insert");
  assert.equal(after.doc.child(2).attrs.suggestion.kind, "insert");
});

test("table row insertion retains the original table and its proposed replacement", () => {
  const row = (text: string) => schema.nodes.tableRow.create(null, schema.nodes.tableCell.create(null, p(text)));
  const table = schema.nodes.table.create(null, row("one"));
  const before = state([table]);
  const after = before.applyTransaction(before.tr.insert(table.nodeSize - 1, row("two"))).state;
  assert.equal(after.doc.child(0).childCount, 1);
  assert.equal(after.doc.child(1).childCount, 2);
  assert.equal(pending(after.doc).length, 1);
});

test("inserting and removing inline pictures uses node suggestions", () => {
  let before = state([p("a b")]);
  let after = before.applyTransaction(before.tr.insert(3, schema.nodes.inlineImage.create())).state;
  assert.equal(after.doc.child(0).child(1).attrs.suggestion.kind, "insert");
  assert.equal(pending(after.doc).length, 1);
  before = state([schema.nodes.paragraph.create(null, [schema.text("a "), schema.nodes.inlineImage.create(), schema.text("b")])]);
  after = before.applyTransaction(before.tr.delete(3, 4)).state;
  assert.equal(after.doc.child(0).child(1).attrs.suggestion.kind, "delete");
  assert.equal(pending(after.doc).length, 1);
});

test("structural edits preserve another author's pending text", () => {
  const existing = schema.text("old", [schema.marks.suggestionInsert.create({ id: "s_other", author: "other" })]);
  const original = schema.nodes.paragraph.create(null, [schema.text("a "), existing]);
  const before = state([original]);
  const after = before.applyTransaction(before.tr.setSelection(TextSelection.create(before.doc, 1, 2)).addMark(1, 2, schema.marks.bold.create())).state;
  assert.ok(pending(after.doc).some(s => s.id === "s_other" && s.author === "other" && s.inserted === "old"));
  assert.equal(after.doc.child(0).child(1).marks[0].attrs.id, "s_other");
});

test("removing another author's pending text keeps its proposal and identity", () => {
  const existing = schema.text("pending", [schema.marks.suggestionInsert.create({ id: "s_other", author: "other" })]);
  const before = state([schema.nodes.paragraph.create(null, [schema.text("a "), existing])]);
  const after = before.applyTransaction(before.tr.delete(3, 10)).state;
  assert.deepEqual(pending(after.doc).map(s => [s.id, s.author, s.inserted]), [["s_other", "other", "pending"]]);
});

test("an author can edit and remove their own inserted block without creating duplicates", () => {
  const code = schema.nodes.codeBlock.create({ language: "js", suggestion: { kind: "insert", id: "s_own", author: "author" } }, schema.text("old"));
  const before = state([code, p("After")]);
  const edited = before.applyTransaction(before.tr.insertText("new", 1, 4)).state;
  assert.equal(edited.doc.childCount, 2);
  assert.equal(edited.doc.child(0).textContent, "new");
  assert.equal(edited.doc.child(0).attrs.suggestion.id, "s_own");
  const removed = edited.applyTransaction(edited.tr.delete(0, edited.doc.child(0).nodeSize)).state;
  assert.equal(removed.doc.childCount, 1);
  assert.equal(removed.doc.textContent, "After");
  assert.equal(pending(removed.doc).length, 0);
});

test("structural proposals decorate custom node views and clear after a decision", () => {
  const picture = schema.nodes.inlineImage.create({ suggestion: { kind: "insert", id: "s_picture", author: "author" } });
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, picture));
  const decorations = suggestionDecorations(doc).find();
  assert.equal(decorations.length, 1);
  assert.deepEqual([decorations[0].from, decorations[0].to], [1, 2]);
  const accepted = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.nodes.inlineImage.create()));
  assert.equal(suggestionDecorations(accepted).find().length, 0);
});

test("ordinary typing and continued typing after a paste stay one suggestion", () => {
  let edited = state([p("Hello")]);
  edited = edited.apply(edited.tr.setSelection(TextSelection.create(edited.doc, 6)));
  for (const chunk of [" ", "t", "o", "d", "a", "y", " and tomorrow", "."]) {
    edited = edited.applyTransaction(edited.tr.insertText(chunk)).state;
  }
  const proposals = pending(edited.doc);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].inserted, " today and tomorrow.");
});

test("overwriting a passage keeps the before and after in one suggestion", () => {
  const before = state([p("The original passage stays here.")]);
  const after = before.applyTransaction(before.tr.insertText("better writing", 5, 21)).state;
  const changes = pending(after.doc);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].deleted, "original passage");
  assert.equal(changes[0].inserted, "better writing");
});

test("formatting and splitting after typing preserve the proposed text", () => {
  let edited = state([p("Hello world")]);
  edited = edited.applyTransaction(edited.tr.insertText(" new", 6)).state;
  edited = edited.applyTransaction(edited.tr.addMark(1, 6, schema.marks.bold.create())).state;
  assert.equal(edited.doc.lastChild?.textContent, "Hello new world");
  const proposedStart = edited.doc.firstChild!.nodeSize;
  edited = edited.apply(edited.tr.setSelection(TextSelection.create(edited.doc, proposedStart + 10)));
  edited = edited.applyTransaction(edited.tr.split(proposedStart + 10)).state;
  const visible: string[] = [];
  edited.doc.forEach(node => { if (node.attrs.suggestion?.kind !== "delete") visible.push(node.textContent); });
  assert.deepEqual(visible, ["Hello new", " world"]);
});

test("editing a proposed paragraph does not add nested deletion proposals", () => {
  const own = schema.nodes.paragraph.create({ suggestion: { kind: "insert", id: "s_block", author: "author" } }, schema.text("New words"));
  const before = state([own]);
  const after = before.applyTransaction(before.tr.setSelection(TextSelection.create(before.doc, 5, 10)).insertText("text")).state;
  assert.equal(after.doc.textContent, "New text");
  assert.equal(pending(after.doc).length, 1);
  assert.equal(pending(after.doc)[0].deleted, "");
  assert.equal(after.selection.head, 9);
});

test("editing an existing own insertion retains its original review id", () => {
  const deletion = schema.text("original", [schema.marks.suggestionDelete.create({ id: "s_replace", author: "author" })]);
  const insertion = schema.text("proposed", [schema.marks.suggestionInsert.create({ id: "s_replace", author: "author" })]);
  const before = state([schema.nodes.paragraph.create(null, [deletion, insertion])]);
  const after = before.applyTransaction(before.tr.insertText("better", 9, 17)).state;
  assert.deepEqual(pending(after.doc).map(s => [s.id, s.inserted, s.deleted]), [["s_replace", "better", "original"]]);
});


test("replacing a mixed original and proposed passage preserves the baseline and copies only visible text", () => {
  let current = state([p("The original passage stays here.")]);
  current = current.applyTransaction(current.tr.insertText("better draft", 5, 21)).state;
  current = current.applyTransaction(current.tr.insertText("A complete rewrite.", 1, current.doc.content.size - 1)).state;
  const slice = proposedSlice(current.doc.slice(1, current.doc.content.size - 1));
  assert.equal(slice.content.textBetween(0, slice.content.size), "A complete rewrite.");
  const original: string[] = [];
  current.doc.descendants(node => {
    if (node.isText && !node.marks.some(mark => mark.type.name === "suggestionInsert")) original.push(node.text!);
  });
  assert.equal(original.join(""), "The original passage stays here.");
});

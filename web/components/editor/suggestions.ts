/**
 * Suggestions (track changes). Two marks, stored in the doc like any other mark, which is also how the service and
 * the `write` CLI read and make them:
 * - `suggestionInsert {id, author}`: text someone suggests adding (shown underlined, not yet part of the doc);
 * - `suggestionDelete {id, author}`: text someone suggests removing (shown struck through, still part of the doc).
 *
 * In suggesting mode (`SuggestMode`), every edit becomes a suggestion: typed text is marked as an insertion, and text
 * that is deleted is put back marked as a deletion (unless it was the author's own suggested insertion, which simply
 * goes). Commenters can only edit this way; the service refuses anything else from them. Structural changes use a node attribute, so paragraphs, formatting, tables and pictures can all be proposed.
 */
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import type { Mark as PMMark, Node as PMNode } from "@tiptap/pm/model";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

const suggestionAttrs = {
  id: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute("data-suggestion"), renderHTML: (a: Record<string, unknown>) => ({ "data-suggestion": a.id }) },
  author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute("data-author"), renderHTML: (a: Record<string, unknown>) => ({ "data-author": a.author }) },
};

export const SuggestionInsert = Mark.create({
  name: "suggestionInsert",
  inclusive: false,
  addAttributes: () => suggestionAttrs,
  parseHTML: () => [{ tag: "ins[data-suggestion]" }],
  renderHTML: ({ HTMLAttributes }) => ["ins", mergeAttributes(HTMLAttributes, { class: "suggest-insert" }), 0],
});

export const SuggestionDelete = Mark.create({
  name: "suggestionDelete",
  inclusive: false,
  addAttributes: () => suggestionAttrs,
  parseHTML: () => [{ tag: "del[data-suggestion]" }],
  renderHTML: ({ HTMLAttributes }) => ["del", mergeAttributes(HTMLAttributes, { class: "suggest-delete" }), 0],
});

export const suggestModeKey = new PluginKey<{ on: boolean }>("suggest-mode");
const FIX = "suggest-mode-fix";

export interface SuggestModeOptions {
  /** The account's uuid (the author of its suggestions). */
  author: string;
  /** Whether suggesting is on (read on every transaction). */
  isOn: () => boolean;
  /** Told why an edit was refused in suggesting mode. */
  onRefused: (reason: string) => void;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `s_${Array.from(bytes, b => "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 57]).join("")}`;
}

function isRemote(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return Boolean(meta?.isChangeOrigin) || Boolean(tr.getMeta("addToHistory") === false && tr.getMeta("y-sync$"));
}

/** A step suggesting mode can turn into a suggestion: text replaced inside one text block. */
function suggestible(step: unknown, doc: PMNode): boolean {
  if (!(step instanceof ReplaceStep)) return false;
  const s = step as ReplaceStep & { structure?: boolean };
  const $from = doc.resolve(s.from);
  const $to = doc.resolve(s.to);
  if (!$from.parent.isTextblock || $from.parent.type.name === "codeBlock" || !$from.sameParent($to)) return false;
  if (s.slice.openStart !== s.slice.openEnd) return false;
  let inlineOnly = true;
  s.slice.content.forEach(node => {
    if (!node.isInline) inlineOnly = false;
  });
  return inlineOnly;
}

function ownInsert(marks: readonly PMMark[], author: string): boolean {
  return marks.some(m => m.type.name === "suggestionInsert" && m.attrs.author === author);
}

export interface NodeSuggestion { kind: "insert" | "delete"; id: string; author: string }

const nodeTypes = ["paragraph", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem", "blockquote", "codeBlock", "horizontalRule", "image", "inlineImage", "table", "tableRow", "tableCell", "tableHeader", "blockMath", "inlineMath", "hardBreak", "footnote", "docLink", "tableOfContents"];

/** Removes pending changes from a proposed replacement; their original nodes stay alongside it. */
function currentNode(node: PMNode): PMNode | null {
  const suggestion = node.attrs.suggestion as NodeSuggestion | null;
  if (suggestion?.kind === "insert" || node.marks.some(m => m.type.name === "suggestionInsert")) return null;
  const marks = node.marks.filter(m => m.type.name !== "suggestionInsert" && m.type.name !== "suggestionDelete");
  if (node.isText) return node.mark(marks);
  const children: PMNode[] = [];
  node.forEach(child => { const kept = currentNode(child); if (kept) children.push(kept); });
  return node.type.createAndFill({ ...node.attrs, suggestion: null }, children, marks);
}

/** Proposes structural edits as old and new nodes, preserving the unchanged surrounding nodes. */
export function structuralSuggestion(oldState: EditorState, newState: EditorState, id: string, author: string): Transaction | null {
  const before: PMNode[] = [], after: PMNode[] = [];
  oldState.doc.forEach(node => before.push(node));
  newState.doc.forEach(node => after.push(node));
  let first = 0, endBefore = before.length, endAfter = after.length;
  while (first < endBefore && first < endAfter && before[first]!.eq(after[first]!)) first++;
  while (endBefore > first && endAfter > first && before[endBefore - 1]!.eq(after[endAfter - 1]!)) { endBefore--; endAfter--; }
  if (first === endBefore && first === endAfter) return null;
  const mark = (node: PMNode, kind: "insert" | "delete") => node.type.create({ ...node.attrs, suggestion: { kind, id, author } }, node.content, node.marks);
  const ownNode = (node: PMNode) => node.attrs.suggestion?.kind === "insert" && node.attrs.suggestion.author === author;
  const originals = before.slice(first, endBefore).filter(node => !ownNode(node)).map(node => node.attrs.suggestion ? node : mark(node, "delete"));
  const proposed = after.slice(first, endAfter).flatMap(node => {
    if (ownNode(node)) return [node];
    const clean = currentNode(node);
    return clean ? [mark(clean, "insert")] : [];
  });
  const from = after.slice(0, first).reduce((n, node) => n + node.nodeSize, 0);
  const to = after.slice(0, endAfter).reduce((n, node) => n + node.nodeSize, 0);
  return newState.tr.replaceWith(from, to, [...originals, ...proposed]).setMeta(FIX, true);
}

/** The shared schema retains node proposals in live editors and version/read-only views. */
export const SuggestionNodes = Extension.create({
  name: "suggestionNodes",
  addGlobalAttributes() {
    return [{ types: nodeTypes, attributes: {
      suggestion: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const kind = el.getAttribute("data-suggestion-kind"), id = el.getAttribute("data-suggestion"), author = el.getAttribute("data-author");
          return (kind === "insert" || kind === "delete") && id && author ? { kind, id, author } : null;
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          const s = attrs.suggestion as NodeSuggestion | null;
          return s ? { "data-suggestion-kind": s.kind, "data-suggestion": s.id, "data-author": s.author } : {};
        },
      },
    } }];
  },
});

export const SuggestMode = Extension.create<SuggestModeOptions>({
  name: "suggestMode",
  addOptions() {
    return { author: "", isOn: () => false, onRefused: () => {} };
  },
  addProseMirrorPlugins() {
    return [suggestionPlugin(this.options)];
  },
});

export function suggestionPlugin(options: SuggestModeOptions): Plugin {
    let current: { id: string; at: number; time: number } | null = null;
    const idFor = (pos: number) => {
      const now = Date.now();
      if (!current || Math.abs(current.at - pos) > 2 || now - current.time > 30_000) current = { id: newId(), at: pos, time: now };
      current.time = now;
      return current.id;
    };
    return new Plugin({
        key: suggestModeKey,
        appendTransaction(transactions, oldState, newState) {
          if (!options.isOn()) return null;
          const local = transactions.filter(tr => tr.docChanged && !isRemote(tr) && !tr.getMeta(FIX));
          if (!local.length) return null;
          if (local.some(tr => tr.steps.some((step, index) => !suggestible(step, tr.docs[index]!)))) {
            return structuralSuggestion(oldState, newState, idFor(newState.selection.from), options.author);
          }
          const schema = newState.schema;
          const insertType = schema.marks.suggestionInsert;
          const deleteType = schema.marks.suggestionDelete;
          // Gather, in final-document positions: ranges inserted, and slices deleted (to put back).
          const inserted: [number, number][] = [];
          const restore: { pos: number; nodes: PMNode[] }[] = [];
          // Backspace leaves the cursor before the struck-through text; Delete after it.
          const selection = oldState.selection;
          let backward = false;
          for (const tr of local) {
            const laterMaps = (from: number) => {
              // Maps from after this transaction's step `from` to the final document.
              return (pos: number, assoc: number) => {
                let p = tr.mapping.slice(from).map(pos, assoc);
                const index = transactions.indexOf(tr);
                for (const later of transactions.slice(index + 1)) p = later.mapping.map(p, assoc);
                return p;
              };
            };
            tr.steps.forEach((step, i) => {
              const s = step as ReplaceStep;
              const before = tr.docs[i];
              const map = laterMaps(i + 1);
              if (s.slice.size > 0) {
                const a = map(s.from, -1);
                const b = map(s.from + s.slice.size, 1);
                if (b > a) inserted.push([a, b]);
              }
              if (s.to > s.from) {
                backward = selection.empty && selection.head === s.to && s.slice.size === 0;
                const nodes: PMNode[] = [];
                before.nodesBetween(s.from, s.to, (node, pos) => {
                  if (!node.isInline) return true;
                  const start = Math.max(s.from, pos);
                  const end = Math.min(s.to, pos + node.nodeSize);
                  if (end <= start) return false;
                  // Removing your own suggested text really removes it.
                  const suggested = node.attrs.suggestion as NodeSuggestion | null;
                  if (ownInsert(node.marks, options.author) || suggested?.kind === "insert" && suggested.author === options.author) return false;
                  const piece = node.isText ? node.cut(start - pos, end - pos) : node;
                  nodes.push(piece);
                  return false;
                });
                if (nodes.length) restore.push({ pos: map(s.from, -1), nodes });
              }
            });
          }
          if (!inserted.length && !restore.length) return null;
          const fix = newState.tr;
          fix.setMeta(FIX, true);
          for (const [a, b] of inserted) {
            const id = idFor(a);
            fix.removeMark(a, b, deleteType);
            fix.addMark(a, b, insertType.create({ id, author: options.author }));
            fix.doc.nodesBetween(a, b, (node, pos) => {
              if (node.isInline && !node.isText && !node.attrs.suggestion) {
                fix.setNodeMarkup(pos, undefined, { ...node.attrs, suggestion: { kind: "insert", id, author: options.author } }, node.marks.filter(m => m.type !== insertType && m.type !== deleteType));
              }
            });
          }
          // Put deleted text back, marked as a suggested deletion (from the end, so positions hold).
          restore.sort((x, y) => y.pos - x.pos);
          let cursor: number | null = null;
          for (const { pos, nodes } of restore) {
            const at = fix.mapping.map(pos, -1);
            const id = idFor(at);
            let offset = at;
            for (const node of nodes) {
              const already = node.marks.some(m => m.type === deleteType || m.type === insertType);
              const marked = node.isText
                ? (already ? node : node.mark(deleteType.create({ id, author: options.author }).addToSet(node.marks.filter(m => m.type !== insertType))))
                : (node.attrs.suggestion ? node : node.type.create({ ...node.attrs, suggestion: { kind: "delete", id, author: options.author } }, node.content, node.marks));
              fix.insert(offset, marked);
              offset += marked.nodeSize;
            }
            cursor = backward ? at : offset;
          }
          if (cursor !== null && !inserted.length) fix.setSelection(TextSelection.create(fix.doc, cursor));
          return fix;
        },
      });
}


/** The suggestions in the doc, by id, in document order. */
export function suggestionsIn(doc: PMNode): { id: string; author: string; from: number; to: number; inserted: string; deleted: string }[] {
  const found = new Map<string, { id: string; author: string; from: number; to: number; inserted: string; deleted: string }>();
  doc.descendants((node, pos) => {
    const suggestion = node.attrs.suggestion as NodeSuggestion | null;
    if (suggestion) {
      const { id, author, kind } = suggestion;
      const entry = found.get(id) ?? { id, author, from: pos, to: pos + node.nodeSize, inserted: "", deleted: "" };
      entry.from = Math.min(entry.from, pos);
      entry.to = Math.max(entry.to, pos + node.nodeSize);
      const label = node.textContent || String(node.attrs.alt || node.attrs.latex || node.attrs.title || node.type.name);
      if (kind === "insert") entry.inserted += label;
      else entry.deleted += label;
      found.set(id, entry);
    }
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== "suggestionInsert" && mark.type.name !== "suggestionDelete") continue;
      const id = String(mark.attrs.id);
      const entry = found.get(id) ?? { id, author: String(mark.attrs.author ?? ""), from: pos, to: pos + node.nodeSize, inserted: "", deleted: "" };
      entry.from = Math.min(entry.from, pos);
      entry.to = Math.max(entry.to, pos + node.nodeSize);
      if (mark.type.name === "suggestionInsert") entry.inserted += node.text ?? "";
      else entry.deleted += node.text ?? "";
      found.set(id, entry);
    }
    return false;
  });
  return [...found.values()].sort((a, b) => a.from - b.from);
}

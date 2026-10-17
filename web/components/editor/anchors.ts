/**
 * Where comments sit, and who just changed what.
 *
 * - A comment's anchor is a pair of Yjs relative positions (base64 of `Y.encodeRelativePosition`), the same encoding the
 *   service resolves, so the comment stays on its text while the doc changes around it.
 * - `CommentAnchors` highlights every open thread's text; the active one more strongly. Clicking highlighted text
 *   opens its thread.
 * - `RemoteFlash` briefly highlights what someone else just changed, with the author's name when it was a Silicon.
 */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import type { Account, Thread } from "@/lib/write/types";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface Binding {
  doc: Y.Doc;
  type: Y.XmlFragment;
  mapping: Map<unknown, unknown>;
}

function binding(editor: Editor): Binding | null {
  const state = ySyncPluginKey.getState(editor.state) as { binding?: Binding } | undefined;
  return state?.binding ?? null;
}

/** The anchor for a range of the doc: Yjs relative positions, as the service stores them. */
export function anchorFor(editor: Editor, from: number, to: number): { start: string; end: string } | null {
  const b = binding(editor);
  if (!b) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const start = absolutePositionToRelativePosition(from, b.type, b.mapping as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const end = absolutePositionToRelativePosition(to, b.type, b.mapping as any);
  if (!start || !end) return null;
  return { start: toBase64(Y.encodeRelativePosition(start)), end: toBase64(Y.encodeRelativePosition(end)) };
}

/** Where an anchor is now, in the editor (null when its text is gone). */
export function rangeOf(editor: Editor, anchor: { start?: string; end?: string }): { from: number; to: number } | null {
  const b = binding(editor);
  if (!b || !anchor.start) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const from = relativePositionToAbsolutePosition(b.doc, b.type, Y.decodeRelativePosition(fromBase64(anchor.start)), b.mapping as any);
    const to = anchor.end
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        relativePositionToAbsolutePosition(b.doc, b.type, Y.decodeRelativePosition(fromBase64(anchor.end)), b.mapping as any)
      : null;
    if (from === null) return null;
    if (to === null) {
      // A point: an image (the node right there), a table cell (the cell around it), or a whole section (the
      // top-level block around it).
      const doc = editor.state.doc;
      const at = Math.min(from, doc.content.size);
      const after = doc.nodeAt(at);
      if (after && (after.type.name === "image" || (after.isBlock && doc.resolve(at).depth === 0))) return { from: at, to: at + after.nodeSize };
      const $pos = doc.resolve(at);
      for (let depth = $pos.depth; depth > 0; depth--) {
        const name = $pos.node(depth).type.name;
        if (name === "tableCell" || name === "tableHeader") return { from: $pos.before(depth), to: $pos.after(depth) };
      }
      if ($pos.depth === 0) return null;
      return { from: $pos.before(1), to: $pos.after(1) };
    }
    if (to <= from) return null;
    return { from, to };
  } catch {
    return null;
  }
}

export const anchorsKey = new PluginKey<DecorationSet>("comment-anchors");

export interface CommentAnchorsOptions {
  onActivate: (threadId: string) => void;
}

interface AnchorsStorage {
  threads: Thread[];
  active: string | null;
}

export const CommentAnchors = Extension.create<CommentAnchorsOptions, AnchorsStorage>({
  name: "commentAnchors",
  addOptions() {
    return { onActivate: () => {} };
  },
  addStorage() {
    return { threads: [], active: null };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const storage = this.storage;
    const options = this.options;
    const build = () => {
      const decorations: Decoration[] = [];
      for (const thread of storage.threads) {
        if (thread.status !== "open" || thread.anchor.kind === "pdf") continue;
        const range = rangeOf(editor, thread.anchor);
        if (!range) continue;
        const active = storage.active === thread.id;
        const attrs = { class: active ? "comment-anchor comment-anchor-active" : "comment-anchor", "data-thread": thread.id };
        if (thread.anchor.end) decorations.push(Decoration.inline(range.from, range.to, attrs));
        else decorations.push(Decoration.node(range.from, range.to, { ...attrs, class: `${attrs.class} comment-anchor-block` }));
      }
      return DecorationSet.create(editor.state.doc, decorations);
    };
    return [
      new Plugin({
        key: anchorsKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, old) => (tr.getMeta(anchorsKey) || tr.docChanged ? build() : old.map(tr.mapping, tr.doc)),
        },
        props: {
          decorations: state => anchorsKey.getState(state),
          handleClick: (_view, _pos, event) => {
            const target = (event.target as HTMLElement | null)?.closest?.("[data-thread]");
            const id = target?.getAttribute("data-thread");
            if (id) {
              options.onActivate(id);
              return false;
            }
            return false;
          },
        },
      }),
    ];
  },
});

/** Hands new threads (or the active one) to the anchors plugin and redraws. */
export function setAnchors(editor: Editor, threads: Thread[], active: string | null) {
  const storage = (editor.storage as unknown as { commentAnchors: AnchorsStorage }).commentAnchors;
  storage.threads = threads;
  storage.active = active;
  editor.view.dispatch(editor.state.tr.setMeta(anchorsKey, true).setMeta("addToHistory", false));
}

export const flashKey = new PluginKey<DecorationSet>("remote-flash");

export interface RemoteFlashOptions {
  /** Who made the last remote change (set from the Yjs transaction just before ProseMirror sees it). */
  lastAuthor: () => Account | null;
}

/** Briefly highlights changes that came from someone else; a Silicon's change carries its name. */
export const RemoteFlash = Extension.create<RemoteFlashOptions>({
  name: "remoteFlash",
  addOptions() {
    return { lastAuthor: () => null };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: flashKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            let next = set.map(tr.mapping, tr.doc);
            if (tr.getMeta(flashKey) === "clear") return DecorationSet.empty;
            const remote = (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin;
            if (!remote || !tr.docChanged) return next;
            const author = options.lastAuthor();
            if (!author || author.kind !== "silicon") return next;
            const added: Decoration[] = [];
            tr.mapping.maps.forEach((map, i) => {
              map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                let from = newStart;
                let to = newEnd;
                for (const later of tr.mapping.maps.slice(i + 1)) {
                  from = later.map(from, -1);
                  to = later.map(to, 1);
                }
                if (to > from) {
                  added.push(Decoration.inline(from, to, { class: "remote-change", "data-author": author.id }));
                  const label = document.createElement("span");
                  label.className = "remote-change-label";
                  label.textContent = author.display_name || author.id;
                  added.push(Decoration.widget(from, label, { side: -1, key: `flash-${from}-${Date.now()}` }));
                }
              });
            });
            if (added.length) next = next.add(tr.doc, added);
            return next;
          },
        },
        props: { decorations: state => flashKey.getState(state) },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          return {
            update(updated, prev) {
              const before = flashKey.getState(prev);
              const after = flashKey.getState(updated.state);
              if (after && after !== before && after.find().length) {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => view.dispatch(view.state.tr.setMeta(flashKey, "clear").setMeta("addToHistory", false)), 2600);
              }
            },
            destroy() {
              if (timer) clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});

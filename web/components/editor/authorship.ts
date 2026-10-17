/**
 * "Who wrote what": small avatars in the margin beside each block, showing who wrote most of it (from the service,
 * which knows which account every change came from).
 */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Account } from "@/lib/write/types";

export const authorshipKey = new PluginKey<DecorationSet>("authorship");

interface AuthorshipStorage {
  blocks: Account[][] | null;
}

function initials(account: Account): string {
  const name = account.display_name || account.id.replace(/^(c|si):/, "");
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export const Authorship = Extension.create<Record<string, never>, AuthorshipStorage>({
  name: "authorship",
  addStorage() {
    return { blocks: null };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: authorshipKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            if (!tr.getMeta(authorshipKey) && !tr.docChanged) return old;
            if (!storage.blocks) return DecorationSet.empty;
            const decorations: Decoration[] = [];
            let index = 0;
            tr.doc.forEach((node, offset) => {
              const authors = storage.blocks?.[index] ?? [];
              index += 1;
              if (!authors.length) return;
              const element = document.createElement("span");
              element.className = "authorship-gutter";
              element.setAttribute("aria-label", `Written by ${authors.map(a => a.id).join(", ")}`);
              element.title = `Written by ${authors.map(a => a.display_name ? `${a.display_name} (${a.id})` : a.id).join(", ")}`;
              for (const author of authors.slice(0, 3)) {
                const chip = document.createElement("span");
                chip.className = `authorship-chip${author.kind === "silicon" ? " authorship-silicon" : ""}`;
                chip.textContent = initials(author);
                element.appendChild(chip);
              }
              decorations.push(Decoration.widget(offset + (node.isTextblock ? 1 : 0), element, { side: -1, key: `author-${offset}-${authors.map(a => a.uuid).join("")}` }));
            });
            return DecorationSet.create(tr.doc, decorations);
          },
        },
        props: { decorations: state => authorshipKey.getState(state) },
      }),
    ];
  },
});

export function showAuthorship(editor: Editor, blocks: Account[][] | null) {
  (editor.storage as unknown as { authorship: AuthorshipStorage }).authorship.blocks = blocks;
  editor.view.dispatch(editor.state.tr.setMeta(authorshipKey, true).setMeta("addToHistory", false));
}

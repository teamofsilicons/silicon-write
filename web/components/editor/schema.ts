/**
 * The doc's schema: every node and mark the editor knows, shared by the live editor and read-only views (versions,
 * public pages). Names and attributes match what the service stores (crates/write-doc/src/model.rs `names`).
 */
import type { AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import { DocLink, Footnote, TableOfContents } from "./nodes";
import { SuggestionDelete, SuggestionInsert } from "./suggestions";

export function contentExtensions(options: { collaborative: boolean }): AnyExtension[] {
  return [
    StarterKit.configure({
      // Collaboration brings its own undo, which only undoes your own changes.
      undoRedo: options.collaborative ? false : undefined,
      link: { openOnClick: !options.collaborative, autolink: true, defaultProtocol: "https" },
      trailingNode: false,
    }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ inline: false, allowBase64: false }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    InlineMath,
    BlockMath,
    SuggestionInsert,
    SuggestionDelete,
    Footnote,
    DocLink,
    TableOfContents,
  ];
}

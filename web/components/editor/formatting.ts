/** Formatting shared with the Markdown and file converters. */
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";

export const Subscript = Mark.create({
  name: "subscript",
  excludes: "superscript",
  parseHTML: () => [{ tag: "sub" }],
  renderHTML: ({ HTMLAttributes }) => ["sub", HTMLAttributes, 0],
});

export const Superscript = Mark.create({
  name: "superscript",
  excludes: "subscript",
  parseHTML: () => [{ tag: "sup:not([data-footnote])" }],
  renderHTML: ({ HTMLAttributes }) => ["sup", HTMLAttributes, 0],
});

export const FileFormatting = Extension.create({
  name: "fileFormatting",
  addGlobalAttributes() {
    return [
      {
        types: ["link"],
        attributes: { title: { default: null, parseHTML: el => el.getAttribute("title") } },
      },
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: el => el.style.textAlign || el.getAttribute("align") || null,
            renderHTML: attrs => ["left", "center", "right", "justify"].includes(attrs.textAlign)
              ? { style: `text-align: ${attrs.textAlign}` } : {},
          },
        },
      },
    ];
  },
});

function safeLink(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, "https://write.invalid/");
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? value : null;
  } catch { return null; }
}

export const InlineImage = Image.extend({
  name: "inlineImage",
  // The block Image extension owns setImage (the toolbar/file chooser). Reusing that
  // command here silently turns a standalone image into an inline atom.
  addCommands() { return {}; },
  addAttributes() {
    return {
      ...this.parent?.(),
      link: { default: null, rendered: false, parseHTML: el => el.closest("a")?.getAttribute("href") ?? null },
      linkTitle: { default: null, rendered: false, parseHTML: el => el.closest("a")?.getAttribute("title") ?? null },
    };
  },
  parseHTML: () => [{ tag: "img[data-inline-image][src]" }],
  renderHTML({ node, HTMLAttributes }) {
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-inline-image": "" });
    const href = safeLink(node.attrs.link);
    return href
      ? ["a", { href, ...(node.attrs.linkTitle ? { title: node.attrs.linkTitle } : {}), rel: "noopener noreferrer" }, ["img", attrs]]
      : ["img", attrs];
  },
}).configure({ inline: true, allowBase64: false });

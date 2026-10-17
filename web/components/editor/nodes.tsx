"use client";

/**
 * The editor's own nodes (their names and attributes are what the service stores and reads as Markdown):
 * - `footnote {content}`: an inline note, numbered in order, edited in place; Markdown `[^n]`.
 * - `docLink {title}`: a `[[link]]` to another doc by its title; typing `[[Title]]` makes one.
 * - `tableOfContents`: the doc's headings, kept up to date; Markdown `[[_TOC_]]`.
 * - `FindReplace`: highlights matches of a search and replaces them.
 */
import { Extension, Node, InputRule, mergeAttributes } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/silicon-ui/popover/popover";
import styles from "./editor.module.css";

// ------------------------------------------------------------------------------------------
// Footnotes
// ------------------------------------------------------------------------------------------

function footnoteNumber(doc: PMNode, pos: number): number {
  let n = 0;
  let found = 0;
  doc.descendants((node, at) => {
    if (found) return false;
    if (node.type.name === "footnote") {
      n += 1;
      if (at === pos) found = n;
    }
    return true;
  });
  return found || n || 1;
}

function FootnoteView({ node, editor, getPos, updateAttributes, selected }: NodeViewProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(node.attrs.content ?? ""));
  const pos = typeof getPos === "function" ? getPos() : 0;
  const number = footnoteNumber(editor.state.doc, pos ?? 0);
  return (
    <NodeViewWrapper as="sup" className={`${styles.footnote} ${selected ? styles.footnoteSelected : ""}`} data-footnote="">
      <Popover open={open} onOpenChange={next => {
        if (next) setDraft(String(node.attrs.content ?? ""));
        if (!next && editor.isEditable && draft !== node.attrs.content) updateAttributes({ content: draft });
        setOpen(next);
      }}>
        <PopoverTrigger asChild>
          <button type="button" className={styles.footnoteButton} aria-label={`Footnote ${number}`} contentEditable={false}>
            {number}
          </button>
        </PopoverTrigger>
        <PopoverContent className={styles.footnotePopover}>
          <span className={styles.footnoteLabel}>Footnote {number}</span>
          {editor.isEditable ? (
            <textarea
              className={styles.footnoteText}
              value={draft}
              rows={3}
              autoFocus
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  updateAttributes({ content: draft });
                  setOpen(false);
                }
              }}
              aria-label="Footnote text"
            />
          ) : (
            <p className={styles.footnoteRead}>{String(node.attrs.content || "")}</p>
          )}
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}

export const Footnote = Node.create({
  name: "footnote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { content: { default: "", parseHTML: el => el.getAttribute("data-content") ?? "", renderHTML: a => ({ "data-content": a.content }) } };
  },
  parseHTML: () => [{ tag: "sup[data-footnote]" }],
  renderHTML: ({ HTMLAttributes }) => ["sup", mergeAttributes(HTMLAttributes, { "data-footnote": "" })],
  addNodeView() {
    return ReactNodeViewRenderer(FootnoteView);
  },
  addCommands() {
    return {
      insertFootnote:
        (content = "") =>
        ({ commands }) =>
          commands.insertContent({ type: "footnote", attrs: { content } }),
    };
  },
});

// ------------------------------------------------------------------------------------------
// Links between docs
// ------------------------------------------------------------------------------------------

function DocLinkView({ node }: NodeViewProps) {
  const router = useRouter();
  const title = String(node.attrs.title ?? "");
  const open = async (event: React.MouseEvent) => {
    event.preventDefault();
    try {
      const found = await api.get<{ doc: { id: string } | null }>("/v1/links", { query: { title } });
      if (found.doc) router.push(`/d/${found.doc.id}`);
      else alert(`There's no doc called “${title}” that you can open.`);
    } catch {
      // Signed out readers of a public doc can't follow links.
    }
  };
  return (
    <NodeViewWrapper as="span" className={styles.docLink} data-doc-link="">
      <a href="#" onClick={open} contentEditable={false} title={`Open “${title}”`}>
        {String(node.attrs.alias || title)}
      </a>
    </NodeViewWrapper>
  );
}

export const DocLink = Node.create({
  name: "docLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      title: { default: "", parseHTML: el => el.getAttribute("data-title") ?? "", renderHTML: a => ({ "data-title": a.title }) },
      alias: { default: null, parseHTML: el => el.getAttribute("data-alias"), renderHTML: a => a.alias ? { "data-alias": a.alias } : {} },
    };
  },
  parseHTML: () => [{ tag: "span[data-doc-link]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-doc-link": "" }), String(node.attrs.alias || node.attrs.title)],
  renderText: ({ node }) => `[[${node.attrs.title}${node.attrs.alias ? `|${node.attrs.alias}` : ""}]]`,
  addNodeView() {
    return ReactNodeViewRenderer(DocLinkView);
  },
  addInputRules() {
    return [
      new InputRule({
        find: /\[\[([^\][]{1,200})\]\]$/,
        handler: ({ state, range, match }) => {
          const [rawTitle, ...aliasParts] = match[1].split("|");
          const title = rawTitle.trim();
          const alias = aliasParts.length ? aliasParts.join("|").trim() : null;
          if (!title) return;
          state.tr.replaceWith(range.from, range.to, this.type.create({ title, alias }));
        },
      }),
    ];
  },
});

// ------------------------------------------------------------------------------------------
// Table of contents
// ------------------------------------------------------------------------------------------

function headingsOf(doc: PMNode): { level: number; text: string; pos: number }[] {
  const out: { level: number; text: string; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") out.push({ level: Number(node.attrs.level ?? 1), text: node.textContent, pos });
    return node.type.name !== "heading";
  });
  return out;
}

function TocView({ editor }: NodeViewProps) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const update = () => setVersion(v => v + 1);
    editor.on("update", update);
    return () => {
      editor.off("update", update);
    };
  }, [editor]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const headings = useMemo(() => headingsOf(editor.state.doc), [editor, version]);
  return (
    <NodeViewWrapper className={styles.toc} data-toc="" contentEditable={false}>
      <p className={styles.tocTitle}>Contents</p>
      {headings.length === 0 ? (
        <p className={styles.tocEmpty}>Headings will show here.</p>
      ) : (
        <ol className={styles.tocList}>
          {headings.map(h => (
            <li key={h.pos} style={{ paddingInlineStart: `${(h.level - 1) * 14}px` }}>
              <a
                href="#"
                onClick={e => {
                  e.preventDefault();
                  const dom = editor.view.nodeDOM(h.pos) as HTMLElement | null;
                  dom?.scrollIntoView({ behavior: "smooth", block: "start" });
                  editor.chain().setTextSelection(h.pos + 1).run();
                }}
              >
                {h.text || "Untitled heading"}
              </a>
            </li>
          ))}
        </ol>
      )}
    </NodeViewWrapper>
  );
}

export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML: () => [{ tag: "div[data-toc]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-toc": "" })],
  addNodeView() {
    return ReactNodeViewRenderer(TocView);
  },
});

// ------------------------------------------------------------------------------------------
// Find and replace
// ------------------------------------------------------------------------------------------

interface FindState {
  term: string;
  matches: { from: number; to: number }[];
  current: number;
  set: DecorationSet;
}

export const findKey = new PluginKey<FindState>("find");

function matchesIn(doc: PMNode, term: string): { from: number; to: number }[] {
  if (!term) return [];
  const needle = term.toLowerCase();
  const out: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Text of the block with positions (inline nodes break matches).
    let text = "";
    const offsets: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) {
          text += child.text![i];
          offsets.push(pos + 1 + offset + i);
        }
      } else {
        text += "\u0000";
        offsets.push(pos + 1 + offset);
      }
    });
    const hay = text.toLowerCase();
    let at = hay.indexOf(needle);
    while (at !== -1) {
      out.push({ from: offsets[at], to: offsets[at + needle.length - 1] + 1 });
      at = hay.indexOf(needle, at + Math.max(needle.length, 1));
    }
    return false;
  });
  return out;
}

function findState(doc: PMNode, term: string, current: number): FindState {
  const matches = matchesIn(doc, term);
  const index = matches.length ? Math.min(Math.max(current, 0), matches.length - 1) : -1;
  const set = DecorationSet.create(doc, matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? "find-match find-current" : "find-match" })));
  return { term, matches, current: index, set };
}

export const FindReplace = Extension.create({
  name: "findReplace",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: (): FindState => ({ term: "", matches: [], current: -1, set: DecorationSet.empty }),
          apply(tr, value: FindState): FindState {
            const meta = tr.getMeta(findKey) as { term?: string; current?: number } | undefined;
            if (meta) return findState(tr.doc, meta.term ?? value.term, meta.current ?? 0);
            if (tr.docChanged && value.term) return findState(tr.doc, value.term, value.current);
            return value;
          },
        },
        props: { decorations: state => findKey.getState(state)?.set },
      }),
    ];
  },
});

export const find = {
  search(editor: Editor, term: string) {
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { term, current: 0 }).setMeta("addToHistory", false));
    find.reveal(editor);
  },
  step(editor: Editor, delta: number) {
    const state = findKey.getState(editor.state);
    if (!state || !state.matches.length) return;
    const next = (state.current + delta + state.matches.length) % state.matches.length;
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { term: state.term, current: next }).setMeta("addToHistory", false));
    find.reveal(editor);
  },
  reveal(editor: Editor) {
    const state = findKey.getState(editor.state);
    const match = state?.matches[state.current];
    if (!match) return;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, match.from, match.to)).scrollIntoView().setMeta("addToHistory", false));
  },
  replace(editor: Editor, replacement: string) {
    const state = findKey.getState(editor.state);
    const match = state?.matches[state.current];
    if (!match) return;
    editor.chain().insertContentAt({ from: match.from, to: match.to }, replacement).run();
    find.reveal(editor);
  },
  replaceAll(editor: Editor, replacement: string) {
    const state = findKey.getState(editor.state);
    if (!state?.matches.length) return 0;
    let tr = editor.state.tr;
    for (const match of [...state.matches].reverse()) {
      tr = replacement ? tr.insertText(replacement, match.from, match.to) : tr.delete(match.from, match.to);
    }
    editor.view.dispatch(tr);
    return state.matches.length;
  },
  clear(editor: Editor) {
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { term: "", current: 0 }).setMeta("addToHistory", false));
  },
  count(editor: Editor): { total: number; current: number } {
    const state = findKey.getState(editor.state);
    return { total: state?.matches.length ?? 0, current: (state?.current ?? -1) + 1 };
  },
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: { insertFootnote: (content?: string) => ReturnType };
  }
}
